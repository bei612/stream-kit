//! Single-owner audio scheduler. The transport waits for `next_deadline` or a
//! new command; no polling clock or sleep/spin loop is needed inside the codec.
//! Playback and recording share the same 1 ms virtual USB clock. PCM is bounded
//! to 60 ms and timestamped, so reconnecting cannot replay old speech.

use super::{
    audio_class::{AudioClass, CAPTURE_ENDPOINT, FRAME_BYTES, PACKET_BYTES},
    usbip::{self, Direction, IsoResult, Request, Submit},
};
use std::{
    collections::VecDeque,
    io::{self, Write},
    time::{Duration, Instant},
};

#[cfg(test)]
const INTERVAL: Duration = Duration::from_millis(1);
const PCM_MAX_AGE: Duration = Duration::from_millis(60);
const PCM_PACKETS: usize = 60;
const MAX_PENDING: usize = 64;
const STALL: i32 = -32;
const CANCELLED: i32 = -104;
const NO_SPACE: i32 = -28;

struct PcmPacket {
    captured: Instant,
    data: [u8; PACKET_BYTES],
    bytes: usize,
    offset: usize,
}

struct PcmRing {
    packets: VecDeque<PcmPacket>,
}
impl PcmRing {
    fn new() -> Self {
        Self {
            packets: VecDeque::with_capacity(PCM_PACKETS),
        }
    }
    fn push(&mut self, pcm: &[u8], captured: Instant, now: Instant) {
        if pcm.is_empty() || now.saturating_duration_since(captured) >= PCM_MAX_AGE {
            return;
        }
        if self.packets.len() == PCM_PACKETS {
            self.packets.pop_front();
        }
        let mut packet = PcmPacket {
            captured,
            data: [0; PACKET_BYTES],
            bytes: pcm.len(),
            offset: 0,
        };
        packet.data[..pcm.len()].copy_from_slice(pcm);
        self.packets.push_back(packet);
    }
    fn read(&mut self, pcm: &mut [u8], now: Instant) {
        pcm.fill(0);
        let mut offset = 0;
        while offset < pcm.len() {
            let Some(front) = self.packets.front_mut() else {
                break;
            };
            if now.saturating_duration_since(front.captured) >= PCM_MAX_AGE {
                self.packets.pop_front();
                continue;
            }
            let count = (front.bytes - front.offset).min(pcm.len() - offset);
            pcm[offset..offset + count]
                .copy_from_slice(&front.data[front.offset..front.offset + count]);
            offset += count;
            front.offset += count;
            if front.offset == front.bytes {
                self.packets.pop_front();
            }
        }
    }
    fn clear(&mut self) {
        self.packets.clear();
    }
}

struct Pending {
    request: Submit,
    first_frame: u64,
    completed: usize,
    data: Vec<u8>,
}
impl Pending {
    fn frame(&self) -> u64 {
        self.first_frame + self.completed as u64
    }
}

pub struct Engine {
    device_id: u32,
    class: AudioClass,
    epoch: Instant,
    cursors: [u64; 2],
    pending: Vec<Pending>,
    pcm: PcmRing,
}

impl Engine {
    pub fn new(device_id: u32, class: AudioClass, now: Instant) -> Self {
        Self {
            device_id,
            class,
            epoch: now,
            cursors: [0; 2],
            pending: Vec::with_capacity(MAX_PENDING),
            pcm: PcmRing::new(),
        }
    }
    pub fn class(&self) -> &AudioClass {
        &self.class
    }
    pub fn next_deadline(&self) -> Option<Instant> {
        self.pending
            .iter()
            .map(|p| self.epoch + Duration::from_millis(p.frame()))
            .min()
    }

    /// Transport admission is device-scoped. Cross-device commands and duplicate
    /// outstanding sequence IDs fail the connection; ordinary unsupported USB
    /// requests receive STALL. A bounded full queue reports ENOSPC to the host.
    pub fn request(
        &mut self,
        request: Request,
        now: Instant,
        writer: &mut impl Write,
    ) -> io::Result<()> {
        let (device, sequence) = match &request {
            Request::Submit(s) => (s.device, s.sequence),
            Request::Unlink {
                device, sequence, ..
            } => (*device, *sequence),
        };
        if device != self.device_id || self.pending.iter().any(|p| p.request.sequence == sequence) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "USB device or sequence mismatch",
            ));
        }
        match request {
            Request::Unlink {
                sequence, target, ..
            } => {
                let found = self
                    .pending
                    .iter()
                    .position(|p| p.request.sequence == target);
                // A successful unlink replaces RET_SUBMIT for the cancelled URB.
                if let Some(index) = found {
                    let removed = self.pending.remove(index);
                    let direction = removed.request.direction;
                    if !self
                        .pending
                        .iter()
                        .any(|p| p.request.direction == direction)
                    {
                        self.cursors[direction_index(direction)] = self.frame_at(now);
                    }
                }
                usbip::write_unlink(writer, sequence, found.is_some())
            }
            Request::Submit(request) if request.endpoint == 0 => {
                match self.class.control(&request) {
                    Ok(reply) => {
                        if reply.reset_streams {
                            let interface = if request.setup[1] == 11 {
                                request.setup[4]
                            } else {
                                0
                            };
                            self.reset(interface, now, writer)?;
                        }
                        usbip::write_completion(
                            writer,
                            &request,
                            0,
                            reply.data.len(),
                            0,
                            &[],
                            &reply.data,
                        )
                    }
                    Err(_) => reject(writer, &request, STALL),
                }
            }
            Request::Submit(request) => {
                let valid = self.class.streaming(request.direction, request.endpoint)
                    && request.length <= usbip::MAX_TRANSFER_BYTES
                    && request.packets.as_ref().is_some_and(|p| {
                        !p.is_empty()
                            && p.len() <= usbip::MAX_ISO_PACKETS
                            && p.iter().all(|p| {
                                p.length as usize <= PACKET_BYTES
                                    && (p.length as usize).is_multiple_of(FRAME_BYTES)
                                    && (request.direction == Direction::Out
                                        || p.length as usize == PACKET_BYTES)
                            })
                    })
                    && if request.direction == Direction::Out {
                        request.data.len() == request.length
                    } else {
                        request.data.is_empty()
                    };
                if !valid {
                    return reject(writer, &request, STALL);
                }
                // Public callers cannot bypass the codec's packet bounds.
                let mut end = 0;
                for p in request.packets.as_ref().unwrap() {
                    let next = p
                        .offset
                        .checked_add(p.length)
                        .filter(|n| *n as usize <= request.length);
                    if p.offset < end || next.is_none() {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "USB audio packet offset invalid",
                        ));
                    }
                    end = next.unwrap();
                }
                if self.pending.len() == MAX_PENDING {
                    return reject(writer, &request, NO_SPACE);
                }
                let current_frame = self.frame_at(now);
                let cursor = &mut self.cursors[direction_index(request.direction)];
                let count = request.packets.as_ref().unwrap().len();
                let first_frame = (*cursor).max(current_frame) + 1;
                *cursor = first_frame + count as u64 - 1;
                let data = Vec::with_capacity(if request.direction == Direction::In {
                    count * PACKET_BYTES
                } else {
                    0
                });
                self.pending.push(Pending {
                    request,
                    first_frame,
                    completed: 0,
                    data,
                });
                Ok(())
            }
        }
    }

    fn reset(&mut self, interface: u8, now: Instant, writer: &mut impl Write) -> io::Result<()> {
        self.pcm.clear();
        let affected =
            |direction| interface == 0 || direction_index(direction) + 1 == interface as usize;
        let mut index = 0;
        while index < self.pending.len() {
            if affected(self.pending[index].request.direction) {
                reject(writer, &self.pending.remove(index).request, CANCELLED)?;
            } else {
                index += 1;
            }
        }
        for direction in [Direction::Out, Direction::In] {
            if affected(direction) {
                self.cursors[direction_index(direction)] = self.frame_at(now);
            }
        }
        Ok(())
    }

    fn frame_at(&self, now: Instant) -> u64 {
        now.saturating_duration_since(self.epoch).as_millis() as u64
    }

    /// Both directions execute each USB frame on one clock, independent of URB
    /// batching/arrival phase. Playback precedes capture in the same frame. A
    /// response is sent only after the entire URB has completed. Expired PCM is
    /// still discarded after a scheduling stall rather than replayed as current.
    pub fn complete_due(&mut self, now: Instant, writer: &mut impl Write) -> io::Result<()> {
        loop {
            let next = self
                .pending
                .iter()
                .enumerate()
                .filter(|(_, p)| p.frame() <= self.frame_at(now))
                .min_by_key(|(_, p)| (p.frame(), direction_index(p.request.direction)))
                .map(|(i, _)| i);
            let Some(index) = next else {
                break;
            };
            let pending = &mut self.pending[index];
            let request = &pending.request;
            let packets = request.packets.as_ref().unwrap();
            let packet = &packets[pending.completed];
            let bytes = packet.length as usize;
            if request.direction == Direction::Out {
                // No consumer: discard instead of replaying a previous session.
                if self.class.streaming(Direction::In, CAPTURE_ENDPOINT) {
                    self.pcm.push(
                        &request.data[packet.offset as usize..packet.offset as usize + bytes],
                        self.epoch + Duration::from_millis(pending.frame()),
                        now,
                    );
                }
            } else {
                let mut pcm = [0; PACKET_BYTES];
                self.pcm.read(&mut pcm, now);
                pending.data.extend(pcm);
            }
            pending.completed += 1;
            if pending.completed == packets.len() {
                let pending = self.pending.remove(index);
                let results: Vec<_> = pending
                    .request
                    .packets
                    .as_ref()
                    .unwrap()
                    .iter()
                    .map(|p| IsoResult {
                        actual: p.length,
                        status: 0,
                    })
                    .collect();
                let actual = results.iter().map(|p| p.actual as usize).sum();
                // USB/IP StartFrame means the FIRST packet, not the completion
                // frame: https://learn.microsoft.com/windows-hardware/drivers/ddi/usb/ns-usb-_urb_isoch_transfer
                usbip::write_completion(
                    writer,
                    &pending.request,
                    0,
                    actual,
                    pending.first_frame as i32,
                    &results,
                    &pending.data,
                )?;
            }
        }
        Ok(())
    }
}
fn direction_index(direction: Direction) -> usize {
    if direction == Direction::Out { 0 } else { 1 }
}
fn reject(writer: &mut impl Write, request: &Submit, status: i32) -> io::Result<()> {
    let results =
        vec![IsoResult { actual: 0, status }; request.packets.as_ref().map_or(0, Vec::len)];
    usbip::write_completion(writer, request, status, 0, 0, &results, &[])
}

#[cfg(test)]
mod tests {
    use super::super::{
        audio_class::{Identity, PLAYBACK_ENDPOINT},
        usbip::IsoPacket,
    };
    use super::*;
    fn setup(seq: u32, req: u8, value: u8, interface: u8) -> Request {
        Request::Submit(Submit {
            sequence: seq,
            device: 0x10001,
            direction: Direction::Out,
            endpoint: 0,
            flags: 0,
            length: 0,
            start_frame: 0,
            interval: 0,
            setup: [
                if req == 11 { 1 } else { 0 },
                req,
                value,
                0,
                interface,
                0,
                0,
                0,
            ],
            packets: None,
            data: Vec::new(),
        })
    }
    fn stream(seq: u32, direction: Direction, fill: u8) -> Request {
        Request::Submit(Submit {
            sequence: seq,
            device: 0x10001,
            direction,
            endpoint: if direction == Direction::Out {
                PLAYBACK_ENDPOINT
            } else {
                CAPTURE_ENDPOINT
            },
            flags: 0,
            length: PACKET_BYTES,
            start_frame: 0,
            interval: 1,
            setup: [0; 8],
            packets: Some(vec![IsoPacket {
                offset: 0,
                length: PACKET_BYTES as u32,
            }]),
            data: if direction == Direction::Out {
                vec![fill; PACKET_BYTES]
            } else {
                Vec::new()
            },
        })
    }
    fn engine(now: Instant) -> Engine {
        let class = AudioClass::new(Identity {
            vendor: 0xfffe,
            product: 1,
            serial: "TestOnly".into(),
        })
        .unwrap();
        let mut engine = Engine::new(0x10001, class, now);
        for request in [setup(1, 9, 1, 0), setup(2, 11, 1, 1), setup(3, 11, 1, 2)] {
            engine.request(request, now, &mut Vec::new()).unwrap();
        }
        engine
    }
    #[test]
    fn playback_reaches_capture_only_when_clock_is_due() {
        let now = Instant::now();
        let mut e = engine(now);
        let mut wire = Vec::new();
        // Capture arrives first: deterministic playback-first on equal deadlines.
        e.request(stream(5, Direction::In, 0), now, &mut wire)
            .unwrap();
        e.request(stream(4, Direction::Out, 0x23), now, &mut wire)
            .unwrap();
        e.complete_due(now, &mut wire).unwrap();
        assert!(wire.is_empty());
        assert_eq!(e.next_deadline(), Some(now + INTERVAL));
        e.complete_due(now + INTERVAL, &mut wire).unwrap();
        assert_eq!(wire.len(), 64 + 64 + PACKET_BYTES);
        assert_eq!(
            &wire[64 + 48..64 + 48 + PACKET_BYTES],
            &[0x23; PACKET_BYTES]
        );
        assert!(e.next_deadline().is_none());
    }
    #[test]
    fn shared_frames_preserve_pcm_across_different_urb_batches_and_arrival_phases() {
        let now = Instant::now();
        let mut e = engine(now);
        let Request::Submit(mut out) = stream(4, Direction::Out, 0x23) else {
            unreachable!()
        };
        out.length = PACKET_BYTES * 3;
        out.data = vec![0x23; out.length];
        out.packets = Some(
            (0..3)
                .map(|i| IsoPacket {
                    offset: (i * PACKET_BYTES) as u32,
                    length: PACKET_BYTES as u32,
                })
                .collect(),
        );
        let mut wire = Vec::new();
        // Capture arrives earlier, in a smaller URB. Both use the next USB
        // frame, not independent clocks phased by each request's arrival time.
        e.request(
            stream(5, Direction::In, 0),
            now + Duration::from_micros(100),
            &mut wire,
        )
        .unwrap();
        e.request(
            Request::Submit(out),
            now + Duration::from_micros(800),
            &mut wire,
        )
        .unwrap();
        e.complete_due(now + INTERVAL, &mut wire).unwrap();
        assert_eq!(wire.len(), 64 + PACKET_BYTES); // capture completed; OUT still pending
        assert_eq!(&wire[48..48 + PACKET_BYTES], &[0x23; PACKET_BYTES]);
        assert_eq!(i32::from_be_bytes(wire[28..32].try_into().unwrap()), 1);
        wire.clear();
        e.request(
            stream(6, Direction::In, 0),
            now + INTERVAL + Duration::from_micros(700),
            &mut wire,
        )
        .unwrap();
        e.complete_due(now + INTERVAL * 2, &mut wire).unwrap();
        assert_eq!(&wire[48..48 + PACKET_BYTES], &[0x23; PACKET_BYTES]);
        wire.clear();
        e.complete_due(now + INTERVAL * 3, &mut wire).unwrap();
        assert_eq!(wire.len(), 48 + 16 * 3);
        assert_eq!(
            i32::from_be_bytes(wire[28..32].try_into().unwrap()),
            1,
            "reply identifies first frame, not last"
        );
        assert!(e.next_deadline().is_none());
    }

    #[test]
    fn expired_audio_and_stopped_recording_never_replay() {
        let now = Instant::now();
        let mut e = engine(now);
        let mut wire = Vec::new();
        e.request(stream(4, Direction::Out, 0x23), now, &mut wire)
            .unwrap();
        e.request(stream(5, Direction::In, 0), now, &mut wire)
            .unwrap();
        e.complete_due(now + Duration::from_millis(100), &mut wire)
            .unwrap();
        assert_eq!(&wire[64 + 48..64 + 48 + PACKET_BYTES], &[0; PACKET_BYTES]);
        e.request(
            stream(6, Direction::Out, 0x55),
            now + Duration::from_millis(101),
            &mut Vec::new(),
        )
        .unwrap();
        e.complete_due(now + Duration::from_millis(102), &mut Vec::new())
            .unwrap();
        e.request(
            setup(7, 11, 0, 2),
            now + Duration::from_millis(102),
            &mut Vec::new(),
        )
        .unwrap();
        e.request(
            setup(8, 11, 1, 2),
            now + Duration::from_millis(102),
            &mut Vec::new(),
        )
        .unwrap();
        let mut capture = Vec::new();
        e.request(
            stream(9, Direction::In, 0),
            now + Duration::from_millis(102),
            &mut capture,
        )
        .unwrap();
        e.complete_due(now + Duration::from_millis(103), &mut capture)
            .unwrap();
        assert_eq!(&capture[48..48 + PACKET_BYTES], &[0; PACKET_BYTES]);
    }
    #[test]
    fn unlink_and_reset_remove_pending_transfers() {
        let now = Instant::now();
        let mut e = engine(now);
        e.request(stream(4, Direction::In, 0), now, &mut Vec::new())
            .unwrap();
        let mut unlink = Vec::new();
        e.request(
            Request::Unlink {
                sequence: 5,
                device: 0x10001,
                target: 4,
            },
            now,
            &mut unlink,
        )
        .unwrap();
        assert_eq!(
            i32::from_be_bytes(unlink[20..24].try_into().unwrap()),
            CANCELLED
        );
        assert!(e.next_deadline().is_none());
        e.request(stream(6, Direction::In, 0), now, &mut Vec::new())
            .unwrap();
        let mut reset = Vec::new();
        e.request(setup(7, 11, 0, 2), now, &mut reset).unwrap();
        assert_eq!(reset.len(), 64 + 48);
        assert_eq!(
            i32::from_be_bytes(reset[20..24].try_into().unwrap()),
            CANCELLED
        );
        assert!(e.next_deadline().is_none());
    }
    #[test]
    fn connection_is_device_scoped_and_pending_memory_is_bounded() {
        let now = Instant::now();
        let mut e = engine(now);
        assert!(
            e.request(
                Request::Unlink {
                    sequence: 4,
                    device: 123,
                    target: 0
                },
                now,
                &mut Vec::new()
            )
            .is_err()
        );
        for seq in 4..MAX_PENDING as u32 + 4 {
            e.request(stream(seq, Direction::In, 0), now, &mut Vec::new())
                .unwrap();
        }
        assert!(
            e.request(stream(4, Direction::In, 0), now, &mut Vec::new())
                .is_err()
        );
        let mut full = Vec::new();
        e.request(stream(100, Direction::In, 0), now, &mut full)
            .unwrap();
        assert_eq!(
            i32::from_be_bytes(full[20..24].try_into().unwrap()),
            NO_SPACE
        );
        assert_eq!(e.pending.len(), MAX_PENDING);
    }
    #[test]
    fn ring_overflow_preserves_whole_stereo_frames() {
        let now = Instant::now();
        let mut ring = PcmRing::new();
        for value in 0..100 {
            ring.push(&[value; PACKET_BYTES], now, now);
        }
        assert_eq!(ring.packets.len(), PCM_PACKETS);
        let mut pcm = [0; PACKET_BYTES];
        ring.read(&mut pcm, now);
        assert_eq!(pcm, [40; PACKET_BYTES]);
        ring.read(&mut pcm, now + PCM_MAX_AGE);
        assert_eq!(pcm, [0; PACKET_BYTES]);
    }
}
