//! Bounded, one-connection microphone sender. Admission renewal/reconnection is
//! owned by the control plane; this transport never reuses a consumed ticket.
use crate::{
    FRAME_SAMPLES,
    admission::Binding,
    wire::{self, FRAME_BYTES, Generation},
};
use futures::{SinkExt, StreamExt};
use std::{
    net::IpAddr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{
    sync::{Notify, mpsc},
    task::JoinHandle,
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{Message, client::IntoClientRequest, protocol::WebSocketConfig},
};

#[cfg(test)]
#[path = "sender_tests.rs"]
mod tests;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid microphone transport configuration")]
    Configuration,
    #[error("microphone transport connection failed")]
    Connection,
}

struct State {
    closed: AtomicBool,
    expires: Mutex<Instant>,
    revoke: Notify,
}
impl State {
    fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.revoke.notify_one();
    }
    fn deadline(&self) -> Instant {
        *self.expires.lock().expect("sender lease poisoned")
    }
}
struct Packet {
    bytes: Box<[u8; FRAME_BYTES]>,
    captured: Instant,
}
struct CloseOnExit(Arc<State>);
impl Drop for CloseOnExit {
    fn drop(&mut self) {
        self.0.close();
    }
}

pub struct Sender {
    binding: Binding,
    state: Arc<State>,
    sequence: AtomicU64,
    frames: mpsc::Sender<Packet>,
    task: JoinHandle<()>,
}

impl Sender {
    /// URL and binding must originate from signed server routing. The caller
    /// must recheck current session authority after this asynchronous handshake.
    pub async fn connect(
        url: &str,
        token: &str,
        binding: Binding,
        expires: Instant,
    ) -> Result<Self, Error> {
        let mut request = url
            .into_client_request()
            .map_err(|_| Error::Configuration)?;
        let uri = request.uri();
        let host = uri
            .host()
            .ok_or(Error::Configuration)?
            .trim_matches(['[', ']']);
        let localhost = host.eq_ignore_ascii_case("localhost");
        let loopback = host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback()) || localhost;
        let port = uri.port_u16().unwrap_or(80);
        if !(uri.scheme_str() == Some("wss") || uri.scheme_str() == Some("ws") && loopback)
            || uri.authority().is_some_and(|v| v.as_str().contains('@'))
            || uri.query().is_some()
            || url.contains('#')
            || token.is_empty()
            || token.len() > 8192
            || binding.target_epoch == 0
            || binding.control_epoch == 0
            || expires <= Instant::now()
        {
            return Err(Error::Configuration);
        }
        let mut credential = format!("Bearer {token}")
            .parse::<tokio_tungstenite::tungstenite::http::HeaderValue>()
            .map_err(|_| Error::Configuration)?;
        credential.set_sensitive(true);
        request.headers_mut().insert("authorization", credential);
        let config = WebSocketConfig::default()
            .read_buffer_size(1024)
            .write_buffer_size(0)
            .max_write_buffer_size(FRAME_BYTES + 128)
            .max_message_size(Some(125))
            .max_frame_size(Some(125));
        let connect_deadline = expires.min(Instant::now() + Duration::from_secs(2));
        let connection = async {
            if localhost && request.uri().scheme_str() == Some("ws") {
                let addresses = tokio::net::lookup_host(("localhost", port))
                    .await
                    .map_err(|_| Error::Connection)?;
                for address in addresses.filter(|address| address.ip().is_loopback()) {
                    if let Ok(stream) = tokio::net::TcpStream::connect(address).await {
                        stream.set_nodelay(true).map_err(|_| Error::Connection)?;
                        return tokio_tungstenite::client_async_tls_with_config(
                            request,
                            stream,
                            Some(config),
                            None,
                        )
                        .await
                        .map_err(|_| Error::Connection);
                    }
                }
                Err(Error::Connection)
            } else {
                connect_async_with_config(request, Some(config), true)
                    .await
                    .map_err(|_| Error::Connection)
            }
        };
        let (mut socket, _) = tokio::time::timeout_at(connect_deadline.into(), connection)
            .await
            .map_err(|_| Error::Connection)??;
        let state = Arc::new(State {
            closed: AtomicBool::new(false),
            expires: Mutex::new(expires),
            revoke: Notify::new(),
        });
        let (frames, mut receiver) = mpsc::channel::<Packet>(1);
        let worker_state = state.clone();
        let task = tokio::spawn(async move {
            let _close = CloseOnExit(worker_state.clone());
            loop {
                let deadline = worker_state.deadline();
                if worker_state.closed.load(Ordering::Acquire) || Instant::now() >= deadline {
                    break;
                }
                tokio::select! {
                    biased;
                    _ = worker_state.revoke.notified() => break,
                    _ = tokio::time::sleep_until(deadline.into()) => continue,
                    incoming = socket.next() => {
                        match incoming {
                            Some(Ok(Message::Ping(_))) => {
                                // Tungstenite queues the protocol pong. Bound its flush too.
                                if !matches!(tokio::time::timeout(Duration::from_millis(20), socket.flush()).await, Ok(Ok(()))) { break; }
                            }
                            Some(Ok(Message::Pong(_))) => {},
                            _ => break,
                        }
                    }
                    packet = receiver.recv() => {
                        let Some(packet) = packet else { break; };
                        let deadline = worker_state.deadline().min(packet.captured + Duration::from_millis(wire::MAX_AGE_MS));
                        if Instant::now() >= deadline { continue; }
                        tokio::select! {
                            biased;
                            _ = worker_state.revoke.notified() => break,
                            result = tokio::time::timeout_at(deadline.into(), socket.send(Message::Binary(packet.bytes.to_vec().into()))) => {
                                if !matches!(result, Ok(Ok(()))) { break; }
                            }
                        }
                    }
                }
            }
            // Drop the socket immediately; never flush queued microphone frames
            // during shutdown and never reconnect using this admission token.
        });
        Ok(Self {
            binding,
            state,
            sequence: AtomicU64::new(0),
            frames,
            task,
        })
    }

    /// Nonblocking media-clock submission, called under the session authority
    /// lock. Full queues discard this packet without delaying audience audio.
    pub fn submit(&self, binding: &Binding, samples: &[f32], captured: Instant) -> bool {
        let now = Instant::now();
        if self.state.closed.load(Ordering::Acquire)
            || now >= self.state.deadline()
            || binding != &self.binding
            || samples.len() != FRAME_SAMPLES
        {
            return false;
        }
        let Some(age) = now
            .checked_duration_since(captured)
            .filter(|age| *age < Duration::from_millis(wire::MAX_AGE_MS))
        else {
            return false;
        };
        let Ok(wall) = SystemTime::now().duration_since(UNIX_EPOCH) else {
            return false;
        };
        // Round age upwards: converting clocks must never renew sample lifetime.
        let Some(captured_ms) =
            (wall.as_millis() as u64).checked_sub(age.as_nanos().div_ceil(1_000_000) as u64)
        else {
            return false;
        };
        let Ok(previous) = self
            .sequence
            .try_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_add(1))
        else {
            self.close();
            return false;
        };
        let mut bytes = Box::new([0; FRAME_BYTES]);
        if wire::encode(
            Generation {
                target: binding.target_epoch,
                controller: binding.control_epoch,
            },
            previous + 1,
            captured_ms,
            samples,
            &mut bytes,
        )
        .is_err()
        {
            return false;
        }
        self.frames.try_send(Packet { bytes, captured }).is_ok()
    }

    /// Only a fresh verified authority snapshot can renew the same connection.
    /// Any binding change closes it permanently and requires a new admission.
    pub fn renew(&self, binding: &Binding, expires: Instant) -> bool {
        let now = Instant::now();
        let mut old = self.state.expires.lock().expect("sender lease poisoned");
        if self.state.closed.load(Ordering::Acquire)
            || binding != &self.binding
            || now >= *old
            || now >= expires
        {
            self.state.close();
            return false;
        }
        *old = expires;
        true
    }
    pub fn is_closed(&self) -> bool {
        self.state.closed.load(Ordering::Acquire)
    }
    pub fn close(&self) {
        self.state.close();
    }
}
impl Drop for Sender {
    fn drop(&mut self) {
        self.close();
        self.task.abort();
    }
}
