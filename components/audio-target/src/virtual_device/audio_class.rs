//! Audio-only USB Audio Class 2 function, with a single fixed 48 kHz clock.
//!
//! Device identity is supplied by deployment, never borrowed from a gamepad or
//! physical sound card. This module has no driver installation side effects.
//! Descriptor layouts follow ADC-2 sections 4.7/4.9/4.10; clock requests follow
//! 5.2.5.1. Windows class-driver requirements:
//! https://learn.microsoft.com/windows-hardware/drivers/audio/usb-2-0-audio-drivers

use super::usbip::{Direction, Submit};

pub const SAMPLE_RATE: u32 = 48_000;
pub const FRAME_BYTES: usize = 4; // interleaved stereo, signed 16-bit little endian
pub const PACKET_BYTES: usize = 48 * FRAME_BYTES; // one full-speed USB millisecond
pub const PLAYBACK_ENDPOINT: u8 = 1;
pub const CAPTURE_ENDPOINT: u8 = 2;
const CLOCK_ID: u8 = 10;

#[derive(Clone, Debug)]
pub struct Identity {
    pub vendor: u16,
    pub product: u16,
    pub serial: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stall;

/// Resetting a stream invalidates queued PCM and pending transfers. The owning
/// transport applies that reset before submitting the control completion.
pub struct ControlReply {
    pub data: Vec<u8>,
    pub reset_streams: bool,
}

pub struct AudioClass {
    identity: Identity,
    configuration: u8,
    alternate: [u8; 3],
}

impl Identity {
    pub fn validate(&self) -> Result<(), &'static str> {
        if matches!(self.vendor, 0 | 0xffff) || matches!(self.product, 0 | 0xffff) {
            return Err("explicit USB vendor/product identity required");
        }
        // This is the device's USB string descriptor, not usbip-win2's optional
        // 16-byte serial override (which our native adapter leaves empty).
        // A one-byte bLength permits 126 UTF-16 code units plus the header.
        // Keep a Windows-safe ASCII subset supporting a domain/email prefix.
        if self.serial.is_empty()
            || self.serial.len() > 126
            || !self
                .serial
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._@:+-".contains(&b))
        {
            return Err("USB serial must contain 1..126 ASCII letters, digits or ._@:+-");
        }
        Ok(())
    }
}

impl AudioClass {
    pub fn new(identity: Identity) -> Result<Self, &'static str> {
        identity.validate()?;
        Ok(Self {
            identity,
            configuration: 0,
            alternate: [0; 3],
        })
    }

    pub fn identity(&self) -> &Identity {
        &self.identity
    }

    pub fn device_descriptor(&self) -> Vec<u8> {
        let mut d = vec![18, 1, 0, 2, 0xef, 2, 1, 64];
        d.extend(self.identity.vendor.to_le_bytes());
        d.extend(self.identity.product.to_le_bytes());
        d.extend([0, 1, 1, 2, 3, 1]);
        d
    }

    pub fn configuration_descriptor(&self) -> Vec<u8> {
        let mut d = vec![9, 2, 0, 0, 3, 1, 0, 0x80, 1];
        // One IAD groups exactly the control interface and two audio streams.
        d.extend([8, 11, 0, 3, 1, 0, 0x20, 2]);
        d.extend([9, 4, 0, 0, 0, 1, 1, 0x20, 2]);
        let ac_start = d.len();
        d.extend([9, 0x24, 1, 0, 2, 0, 0, 0, 0]);
        // Internal fixed clock synchronized to SOF; frequency/validity read-only.
        d.extend([8, 0x24, 10, CLOCK_ID, 5, 5, 0, 0]);
        // A software cable carries line-level PCM, not a physical microphone.
        // Correct terminal types avoid the OS treating this already-processed
        // remote signal as a built-in mic eligible for speech enhancement APOs.
        // USB Terminal Types 1.0: external line connector = 0x0603.
        for (input, output, in_type, out_type, name) in [
            (1u8, 2u8, 0x0101u16, 0x0603u16, 4u8),
            (3, 4, 0x0603, 0x0101, 5),
        ] {
            d.extend([17, 0x24, 2, input]);
            d.extend(in_type.to_le_bytes());
            d.extend([0, CLOCK_ID, 2, 3, 0, 0, 0, 0, 0, 0, name]);
            d.extend([12, 0x24, 3, output]);
            d.extend(out_type.to_le_bytes());
            d.extend([0, input, CLOCK_ID, 0, 0, name]);
        }
        let ac_length = (d.len() - ac_start) as u16;
        d[ac_start + 6..ac_start + 8].copy_from_slice(&ac_length.to_le_bytes());
        for (interface, terminal, endpoint, name) in [
            (1, 1, PLAYBACK_ENDPOINT, 4),
            (2, 4, 0x80 | CAPTURE_ENDPOINT, 5),
        ] {
            d.extend([9, 4, interface, 0, 0, 1, 2, 0x20, name]);
            d.extend([9, 4, interface, 1, 1, 1, 2, 0x20, name]);
            // Type I PCM, stereo front-left/front-right.
            d.extend([16, 0x24, 1, terminal, 0, 1, 1, 0, 0, 0, 2, 3, 0, 0, 0, 0]);
            d.extend([6, 0x24, 2, 1, 2, 16]);
            // Synchronous isochronous endpoint: no feedback endpoint required.
            d.extend([7, 5, endpoint, 0x0d, PACKET_BYTES as u8, 0, 1]);
            d.extend([8, 0x25, 1, 0, 0, 0, 0, 0]);
        }
        let length = d.len() as u16;
        d[2..4].copy_from_slice(&length.to_le_bytes());
        d
    }

    fn descriptor(&self, value: u16, language: u16) -> Result<Vec<u8>, Stall> {
        match (value >> 8, value as u8, language) {
            (1, 0, 0) => Ok(self.device_descriptor()),
            (2, 0, 0) => Ok(self.configuration_descriptor()),
            (3, 0, 0) => Ok(vec![4, 3, 9, 4]),
            (3, index, 0x0409) => {
                let s = match index {
                    1 => "Stream Kit",
                    2 => "Stream Kit Virtual Audio",
                    3 => &self.identity.serial,
                    4 => "Stream Kit Microphone Input",
                    5 => "Stream Kit Microphone",
                    _ => return Err(Stall),
                };
                let mut d = vec![0, 3];
                for ch in s.encode_utf16() {
                    d.extend(ch.to_le_bytes());
                }
                d[0] = d.len() as u8;
                Ok(d)
            }
            _ => Err(Stall),
        }
    }

    pub fn streaming(&self, direction: Direction, endpoint: u8) -> bool {
        self.configuration == 1
            && match (direction, endpoint) {
                (Direction::Out, PLAYBACK_ENDPOINT) => self.alternate[1] == 1,
                (Direction::In, CAPTURE_ENDPOINT) => self.alternate[2] == 1,
                _ => false,
            }
    }

    /// Unsupported controls STALL. Requests are fully validated before changing
    /// state; short descriptor reads are legal, malformed OUT writes are not.
    pub fn control(&mut self, transfer: &Submit) -> Result<ControlReply, Stall> {
        let [kind, request, vl, vh, il, ih, ll, lh] = transfer.setup;
        let value = u16::from_le_bytes([vl, vh]);
        let index = u16::from_le_bytes([il, ih]);
        let length = u16::from_le_bytes([ll, lh]) as usize;
        let is_in = kind & 0x80 != 0;
        if transfer.endpoint != 0
            || transfer.packets.is_some()
            || (transfer.direction == Direction::In) != is_in
            || transfer.length != length
            || (!is_in && transfer.data.len() != length)
            || (is_in && !transfer.data.is_empty())
        {
            return Err(Stall);
        }
        let mut reset_streams = false;
        let mut data = match (kind, request) {
            (0x80, 6) => self.descriptor(value, index)?,
            (0x80, 8) if value == 0 && index == 0 && length == 1 => vec![self.configuration],
            (0x00, 9) if value <= 1 && index == 0 && length == 0 => {
                self.configuration = value as u8;
                self.alternate = [0; 3];
                reset_streams = true;
                Vec::new()
            }
            (0x00, 5) if value <= 127 && index == 0 && length == 0 => Vec::new(),
            (0x81, 10) if self.configuration == 1 && value == 0 && index < 3 && length == 1 => {
                vec![self.alternate[index as usize]]
            }
            (0x01, 11)
                if self.configuration == 1
                    && index < 3
                    && length == 0
                    && (value == 0 || (index > 0 && value == 1)) =>
            {
                // Every SET_INTERFACE resets that stream, even if alt is unchanged.
                self.alternate[index as usize] = value as u8;
                reset_streams = index > 0;
                Vec::new()
            }
            (0x80, 0) if value == 0 && index == 0 && length == 2 => vec![0, 0],
            (0x81, 0) if self.configuration == 1 && value == 0 && index < 3 && length == 2 => {
                vec![0, 0]
            }
            (0x82, 0)
                if value == 0
                    && length == 2
                    && (index == 0
                        || index == 0x80
                        || (index == 1 && self.streaming(Direction::Out, 1))
                        || (index == 0x82 && self.streaming(Direction::In, 2))) =>
            {
                vec![0, 0]
            }
            // UAC2 class-interface clock GET_CUR and GET_RANGE. No SET_CUR is
            // advertised: one fixed sample rate avoids resampling ambiguity.
            (0xa1, 1)
                if self.configuration == 1
                    && index == (CLOCK_ID as u16) << 8
                    && value == 0x0100 =>
            {
                SAMPLE_RATE.to_le_bytes().to_vec()
            }
            (0xa1, 2)
                if self.configuration == 1
                    && index == (CLOCK_ID as u16) << 8
                    && value == 0x0100 =>
            {
                let mut d = vec![1, 0];
                d.extend(SAMPLE_RATE.to_le_bytes());
                d.extend(SAMPLE_RATE.to_le_bytes());
                d.extend(0u32.to_le_bytes());
                d
            }
            (0xa1, 1)
                if self.configuration == 1
                    && index == (CLOCK_ID as u16) << 8
                    && value == 0x0200 =>
            {
                vec![1]
            }
            _ => return Err(Stall),
        };
        data.truncate(length);
        Ok(ControlReply {
            data,
            reset_streams,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn class() -> AudioClass {
        // Synthetic identity is used only in in-memory tests, never enumerated.
        AudioClass::new(Identity {
            vendor: 0xfffe,
            product: 1,
            serial: "TestOnly".into(),
        })
        .unwrap()
    }
    pub fn setup(kind: u8, request: u8, value: u16, index: u16, length: u16) -> Submit {
        let mut setup = [kind, request, 0, 0, 0, 0, 0, 0];
        setup[2..4].copy_from_slice(&value.to_le_bytes());
        setup[4..6].copy_from_slice(&index.to_le_bytes());
        setup[6..8].copy_from_slice(&length.to_le_bytes());
        Submit {
            sequence: 1,
            device: 0x10001,
            direction: if kind & 128 != 0 {
                Direction::In
            } else {
                Direction::Out
            },
            endpoint: 0,
            flags: 0,
            length: length.into(),
            start_frame: 0,
            interval: 0,
            setup,
            packets: None,
            data: if kind & 128 == 0 {
                vec![0; length.into()]
            } else {
                Vec::new()
            },
        }
    }
    #[test]
    fn serial_descriptor_preserves_long_identity_and_bounds() {
        let mut identity = class().identity().clone();
        identity.serial = "owner@example.org:StreamKit0123456789".into();
        for serial in [identity.serial.clone(), "x".repeat(126)] {
            identity.serial = serial.clone();
            let mut device = AudioClass::new(identity.clone()).unwrap();
            let descriptor = device
                .control(&setup(0x80, 6, 0x303, 0x0409, 255))
                .unwrap()
                .data;
            assert_eq!(descriptor.len(), 2 + serial.len() * 2);
            assert_eq!(descriptor[0] as usize, descriptor.len());
            assert_eq!(descriptor[1], 3);
            let decoded: Vec<u16> = descriptor[2..]
                .chunks_exact(2)
                .map(|v| u16::from_le_bytes([v[0], v[1]]))
                .collect();
            assert_eq!(String::from_utf16(&decoded).unwrap(), serial);
        }
        for serial in [
            "".into(),
            "x".repeat(127),
            "bad,serial".into(),
            "bad serial".into(),
            "bad\\serial".into(),
            "bad/serial".into(),
            "bad\0serial".into(),
            "麦克风".into(),
        ] {
            identity.serial = serial;
            assert!(AudioClass::new(identity.clone()).is_err());
        }
    }
    #[test]
    fn descriptor_tree_has_only_audio_and_consistent_lengths() {
        let c = class();
        let d = c.configuration_descriptor();
        assert_eq!(d.len(), 211);
        assert_eq!(u16::from_le_bytes([d[2], d[3]]) as usize, d.len());
        let mut offset = 0;
        let mut interfaces = Vec::new();
        let mut endpoints = Vec::new();
        let mut ac_bytes = 0;
        let mut terminals = Vec::new();
        while offset < d.len() {
            let item = &d[offset..offset + d[offset] as usize];
            match item[1] {
                4 => {
                    assert_eq!(item[5], 1);
                    assert_eq!(item[7], 0x20);
                    interfaces.push((item[2], item[3], item[4]));
                }
                5 => endpoints.push((
                    item[2],
                    item[3],
                    u16::from_le_bytes([item[4], item[5]]),
                    item[6],
                )),
                0x24 if interfaces.last().map(|i| i.0) == Some(0) => {
                    ac_bytes += item.len();
                    if matches!(item[2], 2 | 3) {
                        terminals.push((item[3], u16::from_le_bytes([item[4], item[5]])));
                    }
                }
                _ => {}
            }
            offset += item.len();
        }
        assert_eq!(ac_bytes, 75);
        assert_eq!(
            terminals,
            [(1, 0x0101), (2, 0x0603), (3, 0x0603), (4, 0x0101)]
        );
        assert_eq!(u16::from_le_bytes([d[32], d[33]]), 75);
        assert_eq!(
            interfaces,
            [(0, 0, 0), (1, 0, 0), (1, 1, 1), (2, 0, 0), (2, 1, 1)]
        );
        assert_eq!(endpoints, [(1, 0x0d, 192, 1), (0x82, 0x0d, 192, 1)]);
        assert_eq!(c.device_descriptor().len(), 18);
    }
    #[test]
    fn host_enumeration_clock_and_stream_lifecycle() {
        let mut c = class();
        assert_eq!(
            c.control(&setup(0x80, 6, 0x100, 0, 8)).unwrap().data,
            c.device_descriptor()[..8]
        );
        assert!(!c.streaming(Direction::Out, 1));
        assert!(c.control(&setup(1, 11, 1, 1, 0)).is_err());
        assert!(c.control(&setup(0, 9, 1, 0, 0)).unwrap().reset_streams);
        assert_eq!(
            c.control(&setup(0xa1, 1, 0x100, 0xa00, 4)).unwrap().data,
            SAMPLE_RATE.to_le_bytes()
        );
        assert_eq!(
            c.control(&setup(0xa1, 2, 0x100, 0xa00, 14)).unwrap().data,
            [1, 0, 0x80, 0xbb, 0, 0, 0x80, 0xbb, 0, 0, 0, 0, 0, 0]
        );
        for i in [1, 2] {
            assert!(c.control(&setup(1, 11, 1, i, 0)).unwrap().reset_streams);
        }
        assert!(c.streaming(Direction::Out, 1));
        assert!(c.streaming(Direction::In, 2));
        assert!(!c.streaming(Direction::In, 1));
        c.control(&setup(0, 9, 0, 0, 0)).unwrap();
        assert!(!c.streaming(Direction::In, 2));
    }
    #[test]
    fn invalid_writes_do_not_change_state_and_unknown_requests_stall() {
        let mut c = class();
        let mut invalid = setup(0, 9, 1, 0, 0);
        invalid.direction = Direction::In;
        assert!(c.control(&invalid).is_err());
        assert_eq!(c.control(&setup(0x80, 8, 0, 0, 1)).unwrap().data, [0]);
        for s in [
            setup(0x80, 6, 0x301, 0, 8),
            setup(0x80, 6, 0x200, 1, 9),
            setup(0, 9, 2, 0, 0),
            setup(0x40, 1, 0, 0, 0),
        ] {
            assert!(c.control(&s).is_err());
        }
        c.control(&setup(0, 9, 1, 0, 0)).unwrap();
        assert!(c.control(&setup(0x21, 1, 0x100, 0xa00, 4)).is_err());
        assert!(c.control(&setup(1, 11, 1, 0, 0)).is_err());
    }
}
