//! On-demand native device inventory, in the media process's OS user context.
//! Enumeration opens no streams and changes no system or session routing.
use crate::app::{App, AppError, control_state::now_ms};
use actix_web::{
    HttpRequest, HttpResponse, post,
    web::{Bytes, Data},
};
use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;

const REQUEST_CONTEXT: &[u8] = b"stream-kit/audio-devices/request/v2\n";
const RESPONSE_CONTEXT: &[u8] = b"stream-kit/audio-devices/response/v2\n";
// The blocking job retains this permit even if the HTTP request is cancelled.
static ENUMERATION: Semaphore = Semaphore::const_new(1);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    schema_version: u32,
    request_id: String,
    issued_at_ms: i64,
}

#[derive(Serialize)]
struct Inventory {
    instance_id: String,
    schema_version: u32,
    request_id: String,
    request_issued_at_ms: i64,
    observed_at_ms: i64,
    devices: Vec<stream_kit_audio_target::DeviceInfo>,
    configured_routes: Vec<crate::config::LocalAudioTarget>,
}

fn decode(secret: &str, signature: &str, body: &[u8], now: i64) -> Result<Request, AppError> {
    if body.len() > 2048 {
        return Err(AppError::BadRequest);
    }
    super::signed::verify(secret, REQUEST_CONTEXT, signature, body)?;
    let request: Request = serde_json::from_slice(body).map_err(|_| AppError::BadRequest)?;
    if request.schema_version != 2
        || request.request_id.len() != 32
        || !request.request_id.bytes().all(|b| b.is_ascii_hexdigit())
        || request.issued_at_ms < now.saturating_sub(5000)
        || request.issued_at_ms > now.saturating_add(2000)
    {
        return Err(AppError::BadRequest);
    }
    Ok(request)
}

#[post("/internal/v2/audio-devices")]
pub async fn list(req: HttpRequest, body: Bytes, app: Data<App>) -> Result<HttpResponse, AppError> {
    let secret = app
        .config()
        .web_server
        .media_ticket_secret
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or(AppError::Unauthorized)?;
    let signature = req
        .headers()
        .get("x-stream-control-signature")
        .and_then(|v| v.to_str().ok())
        .ok_or(AppError::Unauthorized)?;
    let request = decode(secret, signature, &body, now_ms())?;
    let permit = ENUMERATION
        .try_acquire()
        .map_err(|_| AppError::AudioTargetUnavailable)?;
    let devices = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        stream_kit_audio_target::devices()
    })
    .await
    .map_err(|_| AppError::AudioTargetUnavailable)?
    .map_err(|_| AppError::AudioTargetUnavailable)?;
    let control = app.media_sessions().control.read().await;
    let configured_routes =
        if control.required {
            control
                .active_sessions(now_ms())
                .filter_map(|session| {
                    session.audio.target.endpoint().map(|endpoint| {
                        crate::config::LocalAudioTarget {
                            host_id: session.host_id,
                            app_id: session.app_id,
                            endpoint,
                        }
                    })
                })
                .collect()
        } else {
            app.config().local_audio_targets.clone()
        };
    drop(control);
    let body = serde_json::to_vec(&Inventory {
        instance_id: crate::node_identity::instance_id().to_owned(),
        schema_version: 2,
        request_id: request.request_id,
        request_issued_at_ms: request.issued_at_ms,
        observed_at_ms: now_ms(),
        devices,
        configured_routes,
    })
    .map_err(|_| AppError::BadRequest)?;
    let signature = super::signed::sign(secret, RESPONSE_CONTEXT, &body)?;
    Ok(HttpResponse::Ok()
        .insert_header(("x-stream-control-signature", signature))
        .insert_header(("cache-control", "no-store"))
        .content_type("application/json")
        .body(body))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inventory_requires_its_own_fresh_signed_request() {
        let body = br#"{"schema_version":2,"request_id":"0123456789abcdef0123456789abcdef","issued_at_ms":1700000000000}"#;
        let signature =
            super::super::signed::sign("fixture", REQUEST_CONTEXT, body).expect("signature");
        assert!(decode("fixture", &signature, body, 1700000000000).is_ok());
        assert!(decode("other", &signature, body, 1700000000000).is_err());
        assert!(decode("fixture", &signature, body, 1700000005001).is_err());
        assert!(decode("fixture", &signature, body, 1699999997999).is_err());
        let other =
            super::super::signed::sign("fixture", RESPONSE_CONTEXT, body).expect("signature");
        assert!(decode("fixture", &other, body, 1700000000000).is_err());
        let mut tampered = body.to_vec();
        tampered.push(b' ');
        assert!(decode("fixture", &signature, &tampered, 1700000000000).is_err());
    }
}
