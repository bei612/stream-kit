//! USB/IP management handshake for one explicitly named local audio device.
use super::audio_class::AudioClass;
use std::io::{self, Read, Write};

pub const DEVICE_ID: u32 = 0x0001_0001;
const VERSION: u16 = 0x0111;
const IMPORT: u16 = 0x8003;
const DEVLIST: u16 = 0x8005;

/// A bus ID belongs to the owning lifecycle. It must be unpredictable per
/// attachment and must not be published as a remote network service. A loopback
/// socket is an isolation boundary, not authentication against local admins.
pub struct Export {
    bus_id: String,
    class: AudioClass,
}

impl Export {
    pub fn new(bus_id: String, class: AudioClass) -> Result<Self, &'static str> {
        if bus_id.is_empty()
            || bus_id.len() > 31
            || !bus_id.bytes().all(|b| b.is_ascii_alphanumeric())
        {
            return Err("USB/IP bus ID must contain 1..31 ASCII letters/digits");
        }
        Ok(Self { bus_id, class })
    }
    pub fn into_class(self) -> AudioClass {
        self.class
    }

    fn device(&self) -> [u8; 312] {
        let mut d = [0u8; 312];
        let path = format!("/stream-kit/virtual-audio/{}", self.class.identity().serial);
        d[..path.len()].copy_from_slice(path.as_bytes());
        d[256..256 + self.bus_id.len()].copy_from_slice(self.bus_id.as_bytes());
        d[288..292].copy_from_slice(&1u32.to_be_bytes()); // bus number
        d[292..296].copy_from_slice(&1u32.to_be_bytes()); // device number
        d[296..300].copy_from_slice(&2u32.to_be_bytes()); // full-speed, 1ms frame
        let descriptor = self.class.device_descriptor();
        for (from, to) in [(8, 300), (10, 302), (12, 304)] {
            d[to..to + 2].copy_from_slice(
                &u16::from_le_bytes([descriptor[from], descriptor[from + 1]]).to_be_bytes(),
            );
        }
        d[306..312].copy_from_slice(&[descriptor[4], descriptor[5], descriptor[6], 1, 1, 3]);
        d
    }

    /// Returns true only for the exact imported bus ID. Device listing completes
    /// its own connection. Management errors never transition into transfer mode.
    pub fn handshake(&self, reader: &mut impl Read, writer: &mut impl Write) -> io::Result<bool> {
        let mut h = [0u8; 8];
        reader.read_exact(&mut h)?;
        let version = u16::from_be_bytes(h[..2].try_into().unwrap());
        let command = u16::from_be_bytes(h[2..4].try_into().unwrap());
        if version != VERSION || h[4..8] != [0; 4] || !matches!(command, IMPORT | DEVLIST) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "unsupported USB/IP management request",
            ));
        }
        if command == IMPORT {
            let mut bus = [0u8; 32];
            reader.read_exact(&mut bus)?;
            let mut expected = [0u8; 32];
            expected[..self.bus_id.len()].copy_from_slice(self.bus_id.as_bytes());
            if bus != expected {
                reply(writer, 3, 4)?; // ST_NODEV, not an imported connection
                return Ok(false);
            }
            reply(writer, 3, 0)?;
            writer.write_all(&self.device())?;
            return Ok(true);
        }
        reply(writer, 5, 0)?;
        writer.write_all(&1u32.to_be_bytes())?;
        writer.write_all(&self.device())?;
        writer.write_all(&[1, 1, 0x20, 0, 1, 2, 0x20, 0, 1, 2, 0x20, 0])?;
        Ok(false)
    }
}
fn reply(writer: &mut impl Write, command: u16, status: u32) -> io::Result<()> {
    let mut h = [0u8; 8];
    h[..2].copy_from_slice(&VERSION.to_be_bytes());
    h[2..4].copy_from_slice(&command.to_be_bytes());
    h[4..8].copy_from_slice(&status.to_be_bytes());
    writer.write_all(&h)
}

#[cfg(test)]
mod tests {
    use super::super::audio_class::Identity;
    use super::*;
    fn export() -> Export {
        Export::new(
            "TestBusOnly".into(),
            AudioClass::new(Identity {
                vendor: 0xfffe,
                product: 1,
                serial: "TestOnly".into(),
            })
            .unwrap(),
        )
        .unwrap()
    }
    #[test]
    fn device_listing_and_import_have_native_wire_layout() {
        let e = export();
        let mut reply = Vec::new();
        assert!(
            !e.handshake(&mut [1, 0x11, 0x80, 5, 0, 0, 0, 0].as_slice(), &mut reply)
                .unwrap()
        );
        assert_eq!(reply.len(), 8 + 4 + 312 + 12);
        assert_eq!(&reply[..12], &[1, 0x11, 0, 5, 0, 0, 0, 0, 0, 0, 0, 1]);
        assert_eq!(
            &reply[12 + 296..12 + 306],
            &[0, 0, 0, 2, 0xff, 0xfe, 0, 1, 1, 0]
        );
        let mut request = vec![1, 0x11, 0x80, 3, 0, 0, 0, 0];
        let mut bus = [0u8; 32];
        bus[..11].copy_from_slice(b"TestBusOnly");
        request.extend(bus);
        reply.clear();
        assert!(e.handshake(&mut request.as_slice(), &mut reply).unwrap());
        assert_eq!(reply.len(), 320);
        assert_eq!(&reply[8..], &e.device());
        request[8] = b'X';
        reply.clear();
        assert!(!e.handshake(&mut request.as_slice(), &mut reply).unwrap());
        assert_eq!(reply, &[1, 0x11, 0, 3, 0, 0, 0, 4]);
    }
    #[test]
    fn unknown_versions_and_truncated_imports_fail_closed() {
        let e = export();
        let mut reply = Vec::new();
        assert!(
            e.handshake(&mut [1, 0x12, 0x80, 3, 0, 0, 0, 0].as_slice(), &mut reply)
                .is_err()
        );
        assert!(reply.is_empty());
        assert!(
            e.handshake(&mut [1, 0x11, 0x80, 3, 0, 0, 0, 0].as_slice(), &mut reply)
                .is_err()
        );
        assert!(reply.is_empty());
    }
}
