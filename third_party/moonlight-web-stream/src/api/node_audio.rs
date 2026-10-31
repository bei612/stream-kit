//! Control-plane-only receiver grants. Browser credentials never authorize this endpoint.
use crate::app::{App, AppError, control_state::now_ms, node_audio::Envelope};
use actix_web::{
    HttpRequest, HttpResponse, post,
    web::{Bytes, Data},
};
use std::time::Instant;

const REQUEST_CONTEXT: &[u8] = b"stream-kit/node-audio-state/request/v1\n";
const RESPONSE_CONTEXT: &[u8] = b"stream-kit/node-audio-state/response/v1\n";

#[post("/internal/v1/node-audio-state")]
pub async fn apply(
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
    if body.len() > 256 * 1024 {
        return Err(AppError::BadRequest);
    }
    super::signed::verify(secret, REQUEST_CONTEXT, signature, &body)?;
    let envelope: Envelope = serde_json::from_slice(&body).map_err(|_| AppError::BadRequest)?;
    let issued = envelope.state.issued_at_ms;
    let node_id = envelope.node_id.clone();
    let sessions: Vec<_> = envelope
        .bindings
        .iter()
        .map(|b| b.session_id.clone())
        .collect();
    let now_ms = now_ms();
    let now = Instant::now();
    let instance = crate::node_identity::instance_id();
    let mut authority = app.node_audio().write().await;
    authority.apply(envelope, instance, now_ms, now)?;
    let active = sessions
        .iter()
        .filter(|id| authority.current(id, now_ms, now).is_some())
        .count();
    drop(authority);
    let body = serde_json::to_vec(&serde_json::json!({
        "schema_version":1,"node_id":node_id,"instance_id":instance,
        "state_issued_at_ms":issued,"observed_at_ms":now_ms,"authorized_sessions":active
    }))
    .map_err(|_| AppError::BadRequest)?;
    let signature = super::signed::sign(secret, RESPONSE_CONTEXT, &body)?;
    Ok(HttpResponse::Ok()
        .insert_header(("x-stream-control-signature", signature))
        .insert_header(("cache-control", "no-store"))
        .content_type("application/json")
        .body(body))
}
