//! Explicit, authenticated and replay-resistant endpoint-pair verification.
use crate::app::{App, AppError, control_state::now_ms};
use actix_web::{
    HttpRequest, HttpResponse, post,
    web::{Bytes, Data},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
};
use stream_kit_audio_target::EndpointPair;
use tokio::sync::Semaphore;

const REQUEST_CONTEXT: &[u8] = b"stream-kit/audio-pair-check/request/v1\n";
const RESPONSE_CONTEXT: &[u8] = b"stream-kit/audio-pair-check/response/v1\n";
static VERIFY: Semaphore = Semaphore::const_new(1);
static NONCES: LazyLock<Mutex<HashMap<String, i64>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    schema_version: u32,
    request_id: String,
    issued_at_ms: i64,
    endpoint: EndpointPair,
}
#[derive(Serialize)]
struct Response {
    schema_version: u32,
    request_id: String,
    request_issued_at_ms: i64,
    observed_at_ms: i64,
    result: serde_json::Value,
}
fn decode(secret: &str, signature: &str, body: &[u8], now: i64) -> Result<Request, AppError> {
    if body.len() > 65536 {
        return Err(AppError::BadRequest);
    }
    super::signed::verify(secret, REQUEST_CONTEXT, signature, body)?;
    let request: Request = serde_json::from_slice(body).map_err(|_| AppError::BadRequest)?;
    let valid_id = |id: &str| {
        !id.is_empty() && id.len() <= 4096 && id.trim() == id && !id.chars().any(char::is_control)
    };
    if request.schema_version != 1
        || request.request_id.len() != 32
        || !request.request_id.bytes().all(|b| b.is_ascii_hexdigit())
        || request.issued_at_ms < now.saturating_sub(5000)
        || request.issued_at_ms > now.saturating_add(2000)
        || !valid_id(&request.endpoint.render_device_id)
        || !valid_id(&request.endpoint.capture_device_id)
        || request.endpoint.render_device_id == request.endpoint.capture_device_id
    {
        return Err(AppError::BadRequest);
    }
    Ok(request)
}
fn reserve_nonce(cache: &mut HashMap<String, i64>, id: &str, expiry: i64, now: i64) -> bool {
    cache.retain(|_, until| *until >= now);
    if cache.len() >= 1024 || cache.contains_key(id) {
        return false;
    }
    cache.insert(id.to_owned(), expiry);
    true
}
#[post("/internal/v1/audio-pair-check")]
pub async fn verify(
    req: HttpRequest,
    body: Bytes,
    app: Data<App>,
) -> Result<HttpResponse, AppError> {
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
    let now = now_ms();
    let request = decode(secret, signature, &body, now)?;
    {
        let mut cache = NONCES
            .lock()
            .map_err(|_| AppError::AudioTargetUnavailable)?;
        if !reserve_nonce(
            &mut cache,
            &request.request_id.to_ascii_lowercase(),
            request.issued_at_ms.saturating_add(5000),
            now,
        ) {
            return Err(AppError::Unauthorized);
        }
    }
    let permit = VERIFY
        .try_acquire()
        .map_err(|_| AppError::AudioTargetUnavailable)?;
    let result = app
        .upstreams()
        .verify_audio_pair(request.endpoint, permit)
        .await
        .map_err(|_| AppError::AudioTargetUnavailable)?;
    let body = serde_json::to_vec(&Response {
        schema_version: 1,
        request_id: request.request_id,
        request_issued_at_ms: request.issued_at_ms,
        observed_at_ms: now_ms(),
        result,
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
    fn request_is_authenticated_fresh_and_single_use() {
        let body = br#"{"schema_version":1,"request_id":"0123456789abcdef0123456789abcdef","issued_at_ms":1700000000000,"endpoint":{"render_device_id":"output","capture_device_id":"input"}}"#;
        let signature =
            super::super::signed::sign("key", REQUEST_CONTEXT, body).expect("fixture signature");
        let request = decode("key", &signature, body, 1700000000000).expect("valid fixture");
        assert!(decode("other", &signature, body, 1700000000000).is_err());
        assert!(decode("key", &signature, body, 1700000005001).is_err());
        let mut cache = HashMap::new();
        assert!(reserve_nonce(
            &mut cache,
            &request.request_id,
            1700000005000,
            1700000000000
        ));
        assert!(!reserve_nonce(
            &mut cache,
            &request.request_id,
            1700000005000,
            1700000000000
        ));
        assert!(reserve_nonce(
            &mut cache,
            &request.request_id,
            1700000011000,
            1700000005001
        ));
    }
}
