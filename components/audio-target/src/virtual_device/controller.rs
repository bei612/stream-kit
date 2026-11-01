//! Native Windows host-controller adapter for the pinned usbip-win2 0.9.8.1 ABI.
//! Uses only the existing driver interface; it never installs a driver or
//! changes USB filters. All mutation is scoped to an exact local attachment.
use std::{
    ffi::c_void,
    io,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    ptr,
};

const GET_DEVICES: u32 = 0x0022_e008;
const ATTACH_ONCE: u32 = 0x0022_e018;
const DETACH: u32 = 0x0022_e004;
const STOP_REATTACH: u32 = 0x0022_e014;
const ROW_BYTES: usize = 1132;
const ATTACH_BYTES: usize = 1124;
const STOP_BYTES: usize = 1108;
const MAX_PORTS: usize = 255;
const LOCAL_HOST: &str = "127.0.0.1";

#[repr(C)]
struct Guid {
    a: u32,
    b: u16,
    c: u16,
    d: [u8; 8],
}
const INTERFACE: Guid = Guid {
    a: 0xb4030c06,
    b: 0xdc5f,
    c: 0x4fcc,
    d: [0x87, 0xeb, 0xe5, 0x51, 0x5a, 0x09, 0x35, 0xc0],
};

#[link(name = "Cfgmgr32")]
unsafe extern "system" {
    fn CM_Get_Device_Interface_List_SizeW(
        length: *mut u32,
        guid: *const Guid,
        device: *const u16,
        flags: u32,
    ) -> u32;
    fn CM_Get_Device_Interface_ListW(
        guid: *const Guid,
        device: *const u16,
        buffer: *mut u16,
        length: u32,
        flags: u32,
    ) -> u32;
}
#[link(name = "Kernel32")]
unsafe extern "system" {
    fn CreateFileW(
        path: *const u16,
        access: u32,
        sharing: u32,
        security: *const c_void,
        disposition: u32,
        flags: u32,
        template: *mut c_void,
    ) -> *mut c_void;
    fn DeviceIoControl(
        handle: *mut c_void,
        code: u32,
        input: *mut c_void,
        input_bytes: u32,
        output: *mut c_void,
        output_bytes: u32,
        written: *mut u32,
        overlapped: *mut c_void,
    ) -> i32;
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

/// Enumerates the exact host-controller interface using Configuration Manager.
/// No device is opened or changed. A missing controller is distinct from a query
/// failure, and multiple controllers require an explicit selection by the owner.
pub fn interfaces() -> io::Result<Vec<String>> {
    for _ in 0..3 {
        let mut length = 0u32;
        // SAFETY: fixed GUID and valid writable output; no retained pointers.
        let status =
            unsafe { CM_Get_Device_Interface_List_SizeW(&mut length, &INTERFACE, ptr::null(), 0) };
        if status != 0 {
            return Err(io::Error::other(format!(
                "Windows USB controller query failed: {status:#x}"
            )));
        }
        if length > 65536 {
            return Err(invalid("USB interface directory exceeds bound"));
        }
        if length <= 1 {
            return Ok(Vec::new());
        }
        let mut buffer = vec![0u16; length as usize];
        // SAFETY: buffer has exactly the advertised number of UTF-16 code units.
        let status = unsafe {
            CM_Get_Device_Interface_ListW(&INTERFACE, ptr::null(), buffer.as_mut_ptr(), length, 0)
        };
        if status == 0x1a {
            continue;
        } // CR_BUFFER_SMALL: device list changed
        if status != 0 {
            return Err(io::Error::other(format!(
                "Windows USB interface query failed: {status:#x}"
            )));
        }
        if buffer.last() != Some(&0) {
            return Err(invalid("unterminated USB interface directory"));
        }
        return buffer
            .split(|v| *v == 0)
            .filter(|v| !v.is_empty())
            .map(|v| String::from_utf16(v).map_err(|_| invalid("invalid UTF-16 device interface")))
            .collect();
    }
    Err(io::Error::other("USB controller directory kept changing"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Location {
    port: u16,
    bus_id: String,
}
impl Location {
    pub fn new(port: u16, bus_id: String) -> io::Result<Self> {
        if port == 0
            || bus_id.is_empty()
            || bus_id.len() > 31
            || !bus_id.bytes().all(|b| b.is_ascii_alphanumeric())
        {
            return Err(invalid("explicit local port and USB bus ID required"));
        }
        Ok(Self { port, bus_id })
    }
    pub fn port(&self) -> u16 {
        self.port
    }
    pub fn bus_id(&self) -> &str {
        &self.bus_id
    }
    fn request(&self, size: usize) -> Vec<u8> {
        let mut b = vec![0u8; size];
        b[..4].copy_from_slice(&(size as u32).to_le_bytes());
        b[12..12 + self.bus_id.len()].copy_from_slice(self.bus_id.as_bytes());
        let service = self.port.to_string();
        b[44..44 + service.len()].copy_from_slice(service.as_bytes());
        b[76..76 + LOCAL_HOST.len()].copy_from_slice(LOCAL_HOST.as_bytes());
        b
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedDevice {
    pub port: i32,
    pub location_hash: u32,
    pub bus_id: String,
    pub service: String,
    pub host: String,
}
impl ImportedDevice {
    fn matches(&self, location: &Location) -> bool {
        self.host == LOCAL_HOST
            && self.service == location.port.to_string()
            && self.bus_id == location.bus_id
    }
}
fn c_string(bytes: &[u8]) -> io::Result<String> {
    let end = bytes
        .iter()
        .position(|v| *v == 0)
        .ok_or_else(|| invalid("unterminated driver location"))?;
    std::str::from_utf8(&bytes[..end])
        .map(str::to_owned)
        .map_err(|_| invalid("invalid driver location encoding"))
}
fn parse_devices(bytes: &[u8]) -> io::Result<Vec<ImportedDevice>> {
    if bytes.len() < 4
        || bytes.len() > 4 + MAX_PORTS * ROW_BYTES
        || !(bytes.len() - 4).is_multiple_of(ROW_BYTES)
    {
        return Err(invalid(
            "USB host controller returned an incompatible device table",
        ));
    }
    let mut devices = Vec::new();
    for row in bytes[4..].as_chunks::<ROW_BYTES>().0 {
        let port = i32::from_le_bytes(row[..4].try_into().unwrap());
        if !(1..=MAX_PORTS as i32).contains(&port)
            || devices.iter().any(|d: &ImportedDevice| d.port == port)
        {
            return Err(invalid(
                "USB controller returned an invalid or duplicate port",
            ));
        }
        devices.push(ImportedDevice {
            port,
            location_hash: u32::from_le_bytes(row[4..8].try_into().unwrap()),
            bus_id: c_string(&row[8..40])?,
            service: c_string(&row[40..72])?,
            host: c_string(&row[72..1097])?,
        });
    }
    Ok(devices)
}

pub struct Controller {
    handle: OwnedHandle,
}
impl Controller {
    /// Opens one currently enumerated controller and checks its ABI with a
    /// read-only listing before permitting any attach or detach operation.
    pub fn open(interface: &str) -> io::Result<Self> {
        if !interfaces()?.iter().any(|candidate| candidate == interface) {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "selected USB host controller is unavailable",
            ));
        }
        let path: Vec<u16> = interface.encode_utf16().chain([0]).collect();
        // SAFETY: NUL-terminated path; synchronous handle; no borrowed pointers
        // retained by CreateFile. OwnedHandle closes exactly this returned handle.
        let raw = unsafe {
            CreateFileW(
                path.as_ptr(),
                0xc000_0000,
                3,
                ptr::null(),
                3,
                0,
                ptr::null_mut(),
            )
        };
        if raw as isize == -1 {
            return Err(io::Error::last_os_error());
        }
        let controller = Self {
            handle: unsafe { OwnedHandle::from_raw_handle(raw) },
        };
        controller.devices()?;
        Ok(controller)
    }
    fn ioctl(&self, code: u32, buffer: &mut [u8]) -> io::Result<usize> {
        let mut written = 0;
        let size = u32::try_from(buffer.len()).map_err(|_| invalid("driver request too large"))?;
        let pointer = buffer.as_mut_ptr().cast();
        // SAFETY: METHOD_BUFFERED supports the same initialized input/output
        // allocation; synchronous call finishes before any Rust reference is used.
        let success = unsafe {
            DeviceIoControl(
                self.handle.as_raw_handle(),
                code,
                pointer,
                size,
                pointer,
                size,
                &mut written,
                ptr::null_mut(),
            )
        };
        if success == 0 {
            return Err(io::Error::last_os_error());
        }
        if written > size {
            return Err(invalid("driver completion exceeds request buffer"));
        }
        Ok(written as usize)
    }
    pub fn devices(&self) -> io::Result<Vec<ImportedDevice>> {
        let mut b = vec![0; 4 + MAX_PORTS * ROW_BYTES];
        // ABI size is sizeof(header + ONE row), not output buffer capacity.
        b[..4].copy_from_slice(&((4 + ROW_BYTES) as u32).to_le_bytes());
        let written = self.ioctl(GET_DEVICES, &mut b)?;
        parse_devices(&b[..written])
    }
    /// Attaches only the explicit local server, once. The caller must already
    /// serve its matching bus ID. Existing imports at that location are refused.
    pub fn attach(self, location: Location) -> io::Result<Attachment> {
        if self.devices()?.iter().any(|d| d.matches(&location)) {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "USB audio location already imported",
            ));
        }
        let mut request = location.request(ATTACH_BYTES);
        let result = self.ioctl(ATTACH_ONCE, &mut request);
        if let Err(error) = result {
            let _ = self.stop_reattach(&location);
            return Err(error);
        }
        // The pinned driver's plugin_hardware completion returns only size and
        // port (8 bytes), not the rest of the input structure or location hash.
        let port = match attached_port(&request[..result.unwrap()]) {
            Ok(port) => port,
            Err(error) => {
                let _ = self.stop_reattach(&location);
                return Err(error);
            }
        };
        Ok(Attachment {
            controller: self,
            location,
            port,
            closed: false,
        })
    }
    fn stop_reattach(&self, location: &Location) -> io::Result<()> {
        self.ioctl(STOP_REATTACH, &mut location.request(STOP_BYTES))
            .map(|_| ())
    }
}

/// Owns one attachment, never a global controller cleanup. Explicit close
/// reports failures to the platform lifecycle; Drop is only a final fallback.
pub struct Attachment {
    controller: Controller,
    location: Location,
    port: i32,
    closed: bool,
}
impl Attachment {
    pub fn close(&mut self) -> io::Result<()> {
        if self.closed {
            return Ok(());
        }
        self.controller.stop_reattach(&self.location)?;
        if let Some(device) = self
            .controller
            .devices()?
            .iter()
            .find(|d| d.port == self.port)
        {
            if !device.matches(&self.location) {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "USB port no longer belongs to this attachment",
                ));
            }
            let mut request = [0u8; 8];
            request[..4].copy_from_slice(&8u32.to_le_bytes());
            request[4..].copy_from_slice(&self.port.to_le_bytes());
            self.controller.ioctl(DETACH, &mut request)?;
        }
        self.controller.stop_reattach(&self.location)?;
        self.closed = true;
        Ok(())
    }
}
impl Drop for Attachment {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

fn attached_port(reply: &[u8]) -> io::Result<i32> {
    if reply.len() < 8 {
        return Err(invalid("truncated USB attachment response"));
    }
    let port = i32::from_le_bytes(reply[4..8].try_into().unwrap());
    if !(1..=MAX_PORTS as i32).contains(&port) {
        return Err(invalid("USB attachment returned an invalid port"));
    }
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn attach_completion_is_eight_bytes_and_cannot_select_all_ports() {
        let mut reply = [0u8; 8];
        reply[..4].copy_from_slice(&1124u32.to_le_bytes());
        reply[4..].copy_from_slice(&7i32.to_le_bytes());
        assert_eq!(attached_port(&reply).unwrap(), 7);
        assert!(attached_port(&reply[..7]).is_err());
        for port in [-2i32, -1, 0, 256] {
            reply[4..].copy_from_slice(&port.to_le_bytes());
            assert!(attached_port(&reply).is_err());
        }
    }
    #[test]
    fn native_requests_have_pinned_layout_and_local_identity() {
        let l = Location::new(43210, "OwnedBus".into()).unwrap();
        let a = l.request(ATTACH_BYTES);
        assert_eq!(a.len(), 1124);
        assert_eq!(&a[..4], &1124u32.to_le_bytes());
        assert_eq!(&a[12..21], b"OwnedBus\0");
        assert_eq!(&a[44..50], b"43210\0");
        assert_eq!(&a[76..86], b"127.0.0.1\0");
        assert!(a[1104..].iter().all(|v| *v == 0));
        let stop = l.request(STOP_BYTES);
        assert_eq!(&stop[..4], &1108u32.to_le_bytes());
        assert!(Location::new(0, "bus".into()).is_err());
        assert!(Location::new(1, "bad\0bus".into()).is_err());
    }
    #[test]
    fn device_table_requires_complete_unique_rows() {
        let mut bytes = vec![0; 4 + ROW_BYTES];
        bytes[4..8].copy_from_slice(&7i32.to_le_bytes());
        bytes[8..12].copy_from_slice(&123u32.to_le_bytes());
        bytes[12..15].copy_from_slice(b"bus");
        bytes[44..48].copy_from_slice(b"3240");
        bytes[76..85].copy_from_slice(b"127.0.0.1");
        let d = parse_devices(&bytes).unwrap();
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].location_hash, 123);
        assert!(d[0].matches(&Location::new(3240, "bus".into()).unwrap()));
        assert!(!d[0].matches(&Location::new(3241, "bus".into()).unwrap()));
        let mut duplicate = bytes.clone();
        duplicate.extend_from_slice(&bytes[4..]);
        assert!(parse_devices(&duplicate).is_err());
        assert!(parse_devices(&bytes[..bytes.len() - 1]).is_err());
        bytes[12..44].fill(b'x');
        assert!(parse_devices(&bytes).is_err());
    }
}
