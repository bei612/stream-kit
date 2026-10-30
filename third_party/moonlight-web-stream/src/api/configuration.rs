//! Native configuration is available only to the signed control plane.
use crate::{
    app::{App, AppError, control_state::now_ms},
    configuration::{Error, Settings},
};
use actix_web::{
    HttpRequest, HttpResponse, post,
    web::{Bytes, Data},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;

const REQUEST: &[u8] = b"stream-kit/gateway-configuration/request/v1\n";
const RESPONSE: &[u8] = b"stream-kit/gateway-configuration/response/v1\n";
static OPERATIONS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    schema_version: u32,
    request_id: String,
    issued_at_ms: i64,
    operation: String,
    #[serde(default)]
    revision: Option<String>,
    #[serde(default)]
    changes: BTreeMap<String, Value>,
}

#[post("/internal/v1/configuration")]
pub async fn manage(
    req: HttpRequest,
    body: Bytes,
    app: Data<App>,
    settings: Data<Settings>,
) -> Result<HttpResponse, AppError> {
    let secret = app
        .config()
        .web_server
        .media_ticket_secret
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or(AppError::Unauthorized)?;
    if body.len() > 1024 * 1024 {
        return Err(AppError::BadRequest);
    }
    let signature = req
        .headers()
        .get("x-stream-control-signature")
        .and_then(|s| s.to_str().ok())
        .ok_or(AppError::Unauthorized)?;
    super::signed::verify(secret, REQUEST, signature, &body)?;
    let request: Request = serde_json::from_slice(&body).map_err(|_| AppError::BadRequest)?;
    let now = now_ms();
    if request.schema_version != 1
        || request.request_id.len() != 32
        || !request.request_id.bytes().all(|b| b.is_ascii_hexdigit())
        || request.issued_at_ms < now.saturating_sub(5000)
        || request.issued_at_ms > now.saturating_add(2000)
    {
        return Err(AppError::BadRequest);
    }
    let permit = OPERATIONS
        .try_acquire()
        .map_err(|_| AppError::AudioTargetUnavailable)?;
    let result = match request.operation.as_str() {
        "read" if request.revision.is_none() && request.changes.is_empty() => {
            tokio::task::spawn_blocking(move || {
                let _permit = permit;
                settings.view()
            })
            .await
        }
        "save" if request.revision.is_some() => {
            tokio::task::spawn_blocking(move || {
                let _permit = permit;
                settings.save(
                    request.revision.as_deref().unwrap_or_default(),
                    request.changes,
                )
            })
            .await
        }
        _ => return Err(AppError::BadRequest),
    }
    .map_err(|_| AppError::AudioTargetUnavailable)?;
    let (status, value) = match result {
        Ok(view) => (
            actix_web::http::StatusCode::OK,
            json!({"status":"ok", "data":view}),
        ),
        Err(error) => {
            let (status, code) = match error {
                Error::Conflict => (
                    actix_web::http::StatusCode::CONFLICT,
                    "CONFIGURATION_CONFLICT",
                ),
                Error::Invalid => (
                    actix_web::http::StatusCode::BAD_REQUEST,
                    "CONFIGURATION_INVALID",
                ),
                Error::Unavailable => (
                    actix_web::http::StatusCode::SERVICE_UNAVAILABLE,
                    "CONFIGURATION_UNAVAILABLE",
                ),
            };
            (
                status,
                json!({"status":"error", "code":code, "message":error.to_string()}),
            )
        }
    };
    let body = serde_json::to_vec(&json!({"schema_version":1,"request_id":request.request_id,"request_issued_at_ms":request.issued_at_ms,"result":value})).map_err(|_| AppError::BadRequest)?;
    let signature = super::signed::sign(secret, RESPONSE, &body)?;
    Ok(HttpResponse::build(status)
        .insert_header(("x-stream-control-signature", signature))
        .insert_header(("cache-control", "no-store"))
        .content_type("application/json")
        .body(body))
}
