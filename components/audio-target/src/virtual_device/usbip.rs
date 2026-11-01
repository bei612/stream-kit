//! Bounded USB/IP transfer framing for an audio-only virtual device.
//!
//! Wire layout: usbip-win2 v.0.9.8.1, commit
//! 55e1fa7f0c2157017b02dc1f3236e98169a535e4, include/usbip/proto.h.
//! https://github.com/vadimgrn/usbip-win2/tree/v.0.9.8.1/include/usbip
//! This is a transport codec, not authorization or a USB class implementation.
//! The owning server must bind the import to its device and validate endpoints.

use std::io::{self, Read, Write};

pub const HEADER_BYTES: usize = 48;
pub const ISO_BYTES: usize = 16;
pub const MAX_TRANSFER_BYTES: usize = 65_536;
pub const MAX_ISO_PACKETS: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Out,
    In,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IsoPacket {
    pub offset: u32,
    pub length: u32,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Submit {
    pub sequence: u32,
    pub device: u32,
    pub direction: Direction,
    pub endpoint: u8,
    pub flags: u32,
    pub length: usize,
    pub start_frame: i32,
    pub interval: i32,
    pub setup: [u8; 8],
    /// None denotes the protocol's -1 non-isochronous sentinel.
    pub packets: Option<Vec<IsoPacket>>,
    /// Host-to-device bytes only. An IN request does not carry a data payload.
    pub data: Vec<u8>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Request {
    Submit(Submit),
    Unlink {
        sequence: u32,
        device: u32,
        target: u32,
    },
}
fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
fn word(bytes: &[u8], offset: usize) -> u32 {
    u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap())
}
fn put(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_be_bytes());
}

/// Reads exactly one bounded request. Rejects unknown commands and invalid
/// counts before allocating or reading a payload. The stream owner sets I/O
/// deadlines; EOF and truncation propagate rather than becoming silence.
pub fn read_request(reader: &mut impl Read) -> io::Result<Request> {
    let mut h = [0u8; HEADER_BYTES];
    reader.read_exact(&mut h)?;
    let sequence = word(&h, 4);
    let device = word(&h, 8);
    let direction = match word(&h, 12) {
        0 => Direction::Out,
        1 => Direction::In,
        _ => return Err(invalid("invalid USB direction")),
    };
    let endpoint = word(&h, 16);
    if endpoint > 15 {
        return Err(invalid("invalid USB endpoint"));
    }
    match word(&h, 0) {
        2 => {
            return Ok(Request::Unlink {
                sequence,
                device,
                target: word(&h, 20),
            });
        }
        1 => {}
        _ => return Err(invalid("unsupported USB/IP request")),
    }
    let length = word(&h, 24) as i32;
    let count = word(&h, 32) as i32;
    if length < 0 || length as usize > MAX_TRANSFER_BYTES {
        return Err(invalid("USB transfer length exceeds bound"));
    }
    if count < -1 || count > MAX_ISO_PACKETS as i32 {
        return Err(invalid("invalid isochronous packet count"));
    }
    let length = length as usize;
    let mut data = if direction == Direction::Out {
        vec![0; length]
    } else {
        Vec::new()
    };
    reader.read_exact(&mut data)?;
    let packets = if count >= 0 {
        let mut packets = Vec::with_capacity(count as usize);
        let mut previous_end = 0;
        for _ in 0..count {
            let mut descriptor = [0u8; ISO_BYTES];
            reader.read_exact(&mut descriptor)?;
            let offset = word(&descriptor, 0);
            let size = word(&descriptor, 4);
            let end = offset
                .checked_add(size)
                .ok_or_else(|| invalid("isochronous packet offset overflow"))?;
            if offset < previous_end || end as usize > length {
                return Err(invalid("overlapping or out-of-bounds isochronous packet"));
            }
            previous_end = end;
            packets.push(IsoPacket {
                offset,
                length: size,
            });
        }
        Some(packets)
    } else {
        None
    };
    Ok(Request::Submit(Submit {
        sequence,
        device,
        direction,
        endpoint: endpoint as u8,
        flags: word(&h, 20),
        length,
        start_frame: word(&h, 28) as i32,
        interval: word(&h, 36) as i32,
        setup: h[40..48].try_into().unwrap(),
        packets,
        data,
    }))
}

#[derive(Debug, Clone, Copy)]
pub struct IsoResult {
    pub actual: u32,
    pub status: i32,
}

/// Completes a request using the driver's packed IN payload convention. OUT
/// replies contain no PCM, even when actual_length is nonzero. All sizes and
/// offsets are checked before the first byte is written to the connection.
pub fn write_completion(
    writer: &mut impl Write,
    request: &Submit,
    status: i32,
    actual: usize,
    start_frame: i32,
    packets: &[IsoResult],
    data: &[u8],
) -> io::Result<()> {
    if request.length > MAX_TRANSFER_BYTES || actual > request.length || actual > MAX_TRANSFER_BYTES
    {
        return Err(invalid("completion exceeds requested transfer"));
    }
    if (request.direction == Direction::In && data.len() != actual)
        || (request.direction == Direction::Out && !data.is_empty())
    {
        return Err(invalid(
            "completion payload does not match transfer direction",
        ));
    }
    let mut errors = 0;
    let count = match &request.packets {
        None => {
            if !packets.is_empty() {
                return Err(invalid("unexpected isochronous completion"));
            }
            -1i32
        }
        Some(expected) => {
            if expected.len() != packets.len() || expected.len() > MAX_ISO_PACKETS {
                return Err(invalid("isochronous completion count mismatch"));
            }
            let mut sum = 0usize;
            let mut previous_end = 0;
            for (input, output) in expected.iter().zip(packets) {
                let end = input
                    .offset
                    .checked_add(input.length)
                    .ok_or_else(|| invalid("isochronous completion offset overflow"))?;
                if input.offset < previous_end || end as usize > request.length {
                    return Err(invalid("isochronous completion offset exceeds transfer"));
                }
                previous_end = end;
                if output.actual > input.length {
                    return Err(invalid("isochronous completion exceeds packet"));
                }
                sum += output.actual as usize;
                if output.status != 0 {
                    errors += 1;
                }
            }
            if sum != actual {
                return Err(invalid("isochronous payload length mismatch"));
            }
            expected.len() as i32
        }
    };
    let mut header = [0u8; HEADER_BYTES];
    put(&mut header, 0, 3);
    put(&mut header, 4, request.sequence);
    put(&mut header, 20, status as u32);
    put(&mut header, 24, actual as u32);
    put(&mut header, 28, start_frame as u32);
    put(&mut header, 32, count as u32);
    put(&mut header, 36, errors);
    writer.write_all(&header)?;
    writer.write_all(data)?;
    if let Some(expected) = &request.packets {
        for (input, output) in expected.iter().zip(packets) {
            let mut descriptor = [0u8; ISO_BYTES];
            put(&mut descriptor, 0, input.offset);
            put(&mut descriptor, 4, input.length);
            put(&mut descriptor, 8, output.actual);
            put(&mut descriptor, 12, output.status as u32);
            writer.write_all(&descriptor)?;
        }
    }
    Ok(())
}

/// A queued unlink reports -ECONNRESET; an already completed request reports 0.
pub fn write_unlink(writer: &mut impl Write, sequence: u32, was_pending: bool) -> io::Result<()> {
    let mut header = [0u8; HEADER_BYTES];
    put(&mut header, 0, 4);
    put(&mut header, 4, sequence);
    put(
        &mut header,
        20,
        if was_pending { (-104i32) as u32 } else { 0 },
    );
    writer.write_all(&header)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn header(direction: u32, length: i32, count: i32) -> Vec<u8> {
        let mut h = vec![0; 48];
        put(&mut h, 0, 1);
        put(&mut h, 4, 0x10203040);
        put(&mut h, 8, 0x10001);
        put(&mut h, 12, direction);
        put(&mut h, 16, 2);
        put(&mut h, 24, length as u32);
        put(&mut h, 32, count as u32);
        h
    }
    fn packet(offset: u32, length: u32) -> [u8; 16] {
        let mut p = [0; 16];
        put(&mut p, 0, offset);
        put(&mut p, 4, length);
        p
    }
    #[test]
    fn in_iso_reply_compacts_data_but_preserves_host_offsets() {
        let mut bytes = header(1, 16, 2);
        bytes.extend(packet(0, 4));
        bytes.extend(packet(12, 4));
        let Request::Submit(request) = read_request(&mut bytes.as_slice()).unwrap() else {
            panic!()
        };
        let mut reply = Vec::new();
        write_completion(
            &mut reply,
            &request,
            0,
            6,
            42,
            &[
                IsoResult {
                    actual: 4,
                    status: 0,
                },
                IsoResult {
                    actual: 2,
                    status: 0,
                },
            ],
            &[1, 2, 3, 4, 5, 6],
        )
        .unwrap();
        assert_eq!(&reply[..8], &[0, 0, 0, 3, 0x10, 0x20, 0x30, 0x40]);
        assert_eq!(&reply[8..20], &[0; 12]);
        assert_eq!(word(&reply, 24), 6);
        assert_eq!(word(&reply, 32), 2);
        assert_eq!(&reply[48..54], &[1, 2, 3, 4, 5, 6]);
        assert_eq!(word(&reply, 70), 12);
        assert_eq!(word(&reply, 78), 2);
    }
    #[test]
    fn out_payload_precedes_descriptors_and_is_not_echoed() {
        let mut bytes = header(0, 4, 1);
        bytes.extend([7, 8, 9, 10]);
        bytes.extend(packet(0, 4));
        let Request::Submit(request) = read_request(&mut bytes.as_slice()).unwrap() else {
            panic!()
        };
        assert_eq!(request.data, [7, 8, 9, 10]);
        let mut reply = Vec::new();
        write_completion(
            &mut reply,
            &request,
            0,
            4,
            0,
            &[IsoResult {
                actual: 4,
                status: 0,
            }],
            &[],
        )
        .unwrap();
        assert_eq!(reply.len(), 64);
    }
    #[test]
    fn hostile_counts_and_offsets_fail_before_unbounded_allocation() {
        for (length, count) in [(-1, -1), (65537, -1), (0, -2), (0, 1025)] {
            assert_eq!(
                read_request(&mut header(0, length, count).as_slice())
                    .unwrap_err()
                    .kind(),
                io::ErrorKind::InvalidData
            );
        }
        let mut overlap = header(1, 8, 2);
        overlap.extend(packet(0, 8));
        overlap.extend(packet(4, 4));
        assert!(read_request(&mut overlap.as_slice()).is_err());
        let mut overflow = header(1, 8, 1);
        overflow.extend(packet(u32::MAX, 4));
        assert!(read_request(&mut overflow.as_slice()).is_err());
        let truncated = header(0, 4, -1);
        assert_eq!(
            read_request(&mut truncated.as_slice()).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
    }
    #[test]
    fn invalid_completion_writes_nothing_and_non_iso_uses_minus_one() {
        let Request::Submit(request) = read_request(&mut header(1, 4, -1).as_slice()).unwrap()
        else {
            panic!()
        };
        let mut reply = Vec::new();
        assert!(write_completion(&mut reply, &request, 0, 5, 0, &[], &[0; 5]).is_err());
        assert!(reply.is_empty());
        write_completion(&mut reply, &request, 0, 2, 0, &[], &[5, 6]).unwrap();
        assert_eq!(&reply[32..36], &[255; 4]);
        assert_eq!(reply.len(), 50);
    }
    #[test]
    fn unlink_has_no_payload_and_reports_cancellation() {
        let mut h = header(0, 0, 0);
        put(&mut h, 0, 2);
        put(&mut h, 20, 7);
        assert_eq!(
            read_request(&mut h.as_slice()).unwrap(),
            Request::Unlink {
                sequence: 0x10203040,
                device: 0x10001,
                target: 7
            }
        );
        let mut reply = Vec::new();
        write_unlink(&mut reply, 9, true).unwrap();
        assert_eq!(reply.len(), 48);
        assert_eq!(word(&reply, 0), 4);
        assert_eq!(word(&reply, 20) as i32, -104);
    }
}
