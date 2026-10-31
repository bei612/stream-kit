//! Authenticated node-to-node PCM ingress. No browser-facing device selection.
use crate::app::{App, AppError, control_state::now_ms, node_audio::Authority};
use actix_web::{
    HttpRequest, HttpResponse, get,
    web::{Data, Path, Payload},
};
use futures::StreamExt;
use std::{
    sync::{LazyLock, Mutex, mpsc},
    time::{Duration, Instant},
};
use stream_kit_audio_target::{
    admission::{Admissions, node_key},
    remote::{Output, RemoteOutput},
    wire::FRAME_BYTES,
};
use tokio::sync::{RwLock, Semaphore, oneshot};

static CONNECTIONS: Semaphore = Semaphore::const_new(16);
static ADMISSIONS: LazyLock<Mutex<Admissions>> =
    LazyLock::new(|| Mutex::new(Admissions::new(4096)));

#[cfg(test)]
#[path = "node_microphone_tests.rs"]
mod tests;

struct Frame {
    bytes: actix_web::web::Bytes,
    unix_ms: u64,
    received: Instant,
}

// Device ownership never leaves this blocking worker. Idle checks revoke even
// if the sender stops sending; dropping the socket sender also ends the worker.
fn run_output<O: Output>(
    mut output: RemoteOutput<O>,
    authority: &RwLock<Authority>,
    session: &str,
    frames: mpsc::Receiver<Frame>,
) {
    loop {
        let frame = match frames.recv_timeout(Duration::from_millis(20)) {
            Ok(frame) => Some(frame),
            Err(mpsc::RecvTimeoutError::Timeout) => None,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        let state = authority.blocking_read();
        let now = Instant::now();
        let current = state.current(session, now_ms(), now);
        let live = current.as_ref().map(|(live, _)| live);
        // Keep the authority lock until submission/clear finishes.
        if let Some(frame) = frame {
            if output
                .receive(&frame.bytes, live, frame.unix_ms, frame.received, now)
                .is_err()
            {
                break;
            }
        } else if !output.check(live, now) {
            break;
        }
    }
}

#[get("/internal/v1/node-microphone/{session_id}")]
pub async fn connect(
    req: HttpRequest,
    payload: Payload,
    session_id: Path<String>,
    app: Data<App>,
) -> Result<HttpResponse, actix_web::Error> {
    // Do not trust X-Forwarded-Proto as evidence of transport protection.
    if !req.app_config().secure() && !req.peer_addr().is_some_and(|peer| peer.ip().is_loopback()) {
        return Err(AppError::Forbidden.into());
    }
    let secret = app
        .config()
        .web_server
        .media_ticket_secret
        .as_deref()
        .ok_or(AppError::Unauthorized)?;
    let token = req
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(AppError::Unauthorized)?;
    let session_id = session_id.into_inner();
    let (live, endpoint) = app
        .node_audio()
        .read()
        .await
        .current(&session_id, now_ms(), Instant::now())
        .ok_or(AppError::Unauthorized)?;
    let key = node_key(secret.as_bytes(), &live.binding.target_node_id)
        .map_err(|_| AppError::Unauthorized)?;
    let permit = CONNECTIONS
        .try_acquire()
        .map_err(|_| AppError::AudioTargetUnavailable)?;
    let admitted = ADMISSIONS
        .lock()
        .map_err(|_| AppError::AudioTargetUnavailable)?
        .admit(token, &key, &live.binding, now_ms() / 1000)
        .map_err(|_| AppError::Unauthorized)?;
    let (response, mut socket, stream) = actix_ws::handle(&req, payload)?;
    let mut stream = stream.max_frame_size(FRAME_BYTES);
    let (sender, receiver) = mpsc::sync_channel(1);
    let (ready_sender, ready) = oneshot::channel();
    let worker_app = app.clone();
    let mut worker = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        // Recheck before and after the potentially slow native open. A route
        // revoked while opening cannot receive even one frame.
        if !worker_app
            .node_audio()
            .blocking_read()
            .current(&session_id, now_ms(), Instant::now())
            .is_some_and(|(current, pair)| current.binding == live.binding && pair == endpoint)
        {
            return;
        }
        let Ok(device) = worker_app.upstreams().open_remote_audio(&endpoint) else {
            return;
        };
        let mut output = RemoteOutput::new(admitted, device);
        {
            let state = worker_app.node_audio().blocking_read();
            let current = state.current(&session_id, now_ms(), Instant::now());
            if !output.check(current.as_ref().map(|(live, _)| live), Instant::now()) {
                return;
            }
        }
        if ready_sender.send(()).is_err() {
            return;
        }
        run_output(output, worker_app.node_audio(), &session_id, receiver);
    });
    tokio::time::timeout(Duration::from_secs(2), ready)
        .await
        .map_err(|_| AppError::AudioTargetUnavailable)?
        .map_err(|_| AppError::AudioTargetUnavailable)?;
    actix_web::rt::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut worker => break,
                message = stream.next() => {
                    match message {
                        Some(Ok(actix_ws::Message::Binary(bytes))) if bytes.len() == FRAME_BYTES => {
                            let received = Instant::now();
                            let unix_ms = now_ms();
                            if unix_ms < 0 || sender.try_send(Frame {bytes, unix_ms: unix_ms as u64, received}).is_err() { break; }
                        }
                        Some(Ok(actix_ws::Message::Ping(bytes))) => {
                            if !matches!(tokio::time::timeout(Duration::from_millis(100), socket.pong(&bytes)).await, Ok(Ok(()))) { break; }
                        }
                        Some(Ok(actix_ws::Message::Pong(_))) => {}
                        _ => break,
                    }
                }
            }
        }
        drop(sender);
        let _ = tokio::time::timeout(Duration::from_millis(100), socket.close(None)).await;
    });
    Ok(response)
}
