//! Owned lifetime of one local audio server and its native USB attachment.
//! A deployment must first provision the pinned, signed host controller. There
//! is no implicit driver download/installation or fallback to a physical device.
use super::{
    audio_class::{AudioClass, Identity},
    controller::{self, Attachment, Controller, Location},
    export::Export,
    transport::{self, ConnectionOutcome},
};
use std::{
    ffi::c_void,
    io,
    net::{Shutdown, TcpListener, TcpStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::Duration,
};

#[link(name = "Bcrypt")]
unsafe extern "system" {
    fn BCryptGenRandom(algorithm: *mut c_void, buffer: *mut u8, bytes: u32, flags: u32) -> i32;
}
fn bus_id() -> io::Result<String> {
    let mut random = [0u8; 15];
    // SAFETY: fixed writable array; system-preferred RNG requires a null handle.
    let status = unsafe { BCryptGenRandom(std::ptr::null_mut(), random.as_mut_ptr(), 15, 2) };
    if status < 0 {
        return Err(io::Error::other(format!(
            "Windows random generator failed: {status:#x}"
        )));
    }
    let mut id = String::from("S");
    for b in random {
        use std::fmt::Write;
        write!(&mut id, "{b:02x}").unwrap();
    }
    Ok(id)
}

struct LocalServer {
    location: Location,
    stopped: Arc<AtomicBool>,
    connection: Arc<Mutex<Option<TcpStream>>>,
    worker: Option<JoinHandle<io::Result<()>>>,
}

// Notify the owner on every transport exit, including unwinding. This runs on
// the existing transport thread; it never adds an idle watcher or polling loop.
struct ExitNotification<F: FnOnce()>(Option<F>);
impl<F: FnOnce()> Drop for ExitNotification<F> {
    fn drop(&mut self) {
        if let Some(notify) = self.0.take() {
            notify();
        }
    }
}

impl LocalServer {
    fn start(identity: Identity, on_exit: impl FnOnce() + Send + 'static) -> io::Result<Self> {
        // Validate before opening any socket or spawning any thread.
        AudioClass::new(identity.clone()).map_err(io::Error::other)?;
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let location = Location::new(listener.local_addr()?.port(), bus_id()?)?;
        let stopped = Arc::new(AtomicBool::new(false));
        let connection = Arc::new(Mutex::new(None::<TcpStream>));
        let worker_stop = stopped.clone();
        let worker_socket = connection.clone();
        let worker_location = location.clone();
        let worker = thread::Builder::new()
            .name("virtual-audio-local-server".into())
            .spawn(move || {
                let _notification = ExitNotification(Some(on_exit));
                while !worker_stop.load(Ordering::Acquire) {
                    let (stream, _) = listener.accept()?;
                    {
                        let mut socket = worker_socket.lock().map_err(|_| {
                            io::Error::other("virtual audio lifecycle lock poisoned")
                        })?;
                        // Serializes stop with publishing the currently active socket.
                        if worker_stop.load(Ordering::Acquire) {
                            break;
                        }
                        *socket = Some(stream.try_clone()?);
                    }
                    let class = AudioClass::new(identity.clone()).map_err(io::Error::other)?;
                    let export = Export::new(worker_location.bus_id().to_owned(), class)
                        .map_err(io::Error::other)?;
                    let result = transport::serve_connection(stream, export);
                    worker_socket
                        .lock()
                        .map_err(|_| io::Error::other("virtual audio lifecycle lock poisoned"))?
                        .take();
                    if worker_stop.load(Ordering::Acquire) {
                        return Ok(());
                    }
                    match result {
                        Ok(ConnectionOutcome::NotImported) => {}
                        Ok(ConnectionOutcome::Imported) => {
                            return Err(io::Error::new(
                                io::ErrorKind::ConnectionAborted,
                                "virtual audio host-controller connection ended",
                            ));
                        }
                        Err(error) => return Err(error),
                    }
                }
                Ok(())
            })?;
        Ok(Self {
            location,
            stopped,
            connection,
            worker: Some(worker),
        })
    }
    fn finished(&self) -> bool {
        self.worker
            .as_ref()
            .is_none_or(|worker| worker.is_finished())
    }
    fn stop(&mut self) -> io::Result<()> {
        self.stopped.store(true, Ordering::Release);
        if let Ok(connection) = self.connection.lock()
            && let Some(stream) = connection.as_ref()
        {
            let _ = stream.shutdown(Shutdown::Both);
        }
        if let Some(worker) = self.worker.take() {
            // Wake only this listener. No busy poll and no periodic idle thread.
            if !worker.is_finished() {
                let address = std::net::SocketAddr::from(([127, 0, 0, 1], self.location.port()));
                let _ = TcpStream::connect_timeout(&address, Duration::from_secs(1));
            }
            worker
                .join()
                .map_err(|_| io::Error::other("virtual audio server terminated unexpectedly"))??;
        }
        Ok(())
    }
}
impl Drop for LocalServer {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

/// The platform owns this object for exactly the lifetime of its audio provider.
/// `start` does not install software. Missing/ambiguous controllers are reported;
/// it never attaches through another driver or chooses default audio endpoints.
pub struct ManagedDevice {
    attachment: Attachment,
    server: LocalServer,
}
impl ManagedDevice {
    pub fn start(identity: Identity) -> io::Result<Self> {
        Self::start_observed(identity, || {})
    }

    /// Notify once when the transport ends, including normal close. The callback
    /// must be nonblocking and must not panic. Owners can use it to drain their
    /// service on device failure; `close` still joins and returns the cause.
    pub fn start_observed(
        identity: Identity,
        on_exit: impl FnOnce() + Send + 'static,
    ) -> io::Result<Self> {
        let interfaces = controller::interfaces()?;
        if interfaces.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "signed USB audio host controller is not installed",
            ));
        }
        if interfaces.len() != 1 {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "multiple USB host controllers require explicit deployment selection",
            ));
        }
        let controller = Controller::open(&interfaces[0])?;
        let server = LocalServer::start(identity, on_exit)?;
        let attachment = controller.attach(server.location.clone())?;
        let mut device = Self { attachment, server };
        if device.server.finished() {
            let _ = device.close();
            return Err(io::Error::new(
                io::ErrorKind::ConnectionAborted,
                "virtual audio transport ended during attachment",
            ));
        }
        Ok(device)
    }
    /// Transport health only: Windows endpoint presence and actual recording
    /// must be checked through the existing native device inventory separately.
    pub fn transport_running(&self) -> bool {
        !self.server.finished()
    }
    pub fn close(&mut self) -> io::Result<()> {
        // Detach before dropping the connection to avoid triggering reconnect;
        // repeat exact-location cleanup after socket shutdown if detach failed.
        self.server.stopped.store(true, Ordering::Release);
        let detached = self.attachment.close();
        let stopped = self.server.stop();
        if detached.is_err() {
            self.attachment.close()?;
        }
        stopped
    }
}
impl Drop for ManagedDevice {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn identity() -> Identity {
        Identity {
            vendor: 0xfffe,
            product: 1,
            serial: "TestOnly".into(),
        }
    }
    #[test]
    fn idle_local_server_stops_and_releases_listener_without_driver() {
        let mut server = LocalServer::start(identity(), || {}).unwrap();
        assert_eq!(server.location.bus_id().len(), 31);
        let port = server.location.port();
        server.stop().unwrap();
        server.stop().unwrap();
        assert!(server.finished());
        // The owning thread has joined; the listening endpoint is released.
        TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).unwrap();
    }
    #[test]
    fn stop_interrupts_an_imported_idle_peer() {
        use std::io::{Read, Write};
        let mut server = LocalServer::start(identity(), || {}).unwrap();
        let mut peer =
            TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, server.location.port())).unwrap();
        peer.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let mut request = vec![1, 0x11, 0x80, 3, 0, 0, 0, 0];
        let mut bus = [0u8; 32];
        bus[..server.location.bus_id().len()].copy_from_slice(server.location.bus_id().as_bytes());
        request.extend(bus);
        peer.write_all(&request).unwrap();
        let mut reply = [0u8; 320];
        peer.read_exact(&mut reply).unwrap();
        assert_eq!(&reply[..8], &[1, 0x11, 0, 3, 0, 0, 0, 0]);
        server.stop().unwrap();
        assert!(server.finished());
    }
    #[test]
    fn invalid_identity_does_not_create_a_provider() {
        assert!(
            LocalServer::start(
                Identity {
                    vendor: 0,
                    product: 1,
                    serial: "TestOnly".into()
                },
                || {}
            )
            .is_err()
        );
    }

    #[test]
    fn transport_failure_notifies_owner_and_preserves_cleanup_error() {
        let (sender, receiver) = std::sync::mpsc::channel();
        let mut server = LocalServer::start(identity(), move || {
            let _ = sender.send(());
        })
        .unwrap();
        let peer =
            TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, server.location.port())).unwrap();
        // A truncated import fails the transport without any driver installation.
        peer.shutdown(Shutdown::Both).unwrap();
        receiver.recv_timeout(Duration::from_secs(3)).unwrap();
        assert!(server.stop().is_err());
        assert!(receiver.try_recv().is_err());
        server.stop().unwrap();
        TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, server.location.port())).unwrap();
    }

    #[test]
    fn normal_close_notifies_once_without_reporting_failure() {
        let (sender, receiver) = std::sync::mpsc::channel();
        let mut server = LocalServer::start(identity(), move || {
            let _ = sender.send(());
        })
        .unwrap();
        server.stop().unwrap();
        receiver.recv_timeout(Duration::from_secs(3)).unwrap();
        server.stop().unwrap();
        assert!(receiver.try_recv().is_err());
    }
}
