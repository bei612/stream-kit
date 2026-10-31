use crate::app::{
    App, AppError,
    control_state::now_ms,
    host::{AppId, HostId},
    media::MediaSessionKey,
    remote_routes,
};
use actix_web::{
    HttpRequest, HttpResponse, post,
    web::{Bytes, Data},
};
use serde::Deserialize;
use std::time::{Duration, Instant};
use stream_kit_audio_target::{admission::Binding, sender::Sender};

const REQUEST: &[u8] = b"stream-kit/node-microphone-route/request/v1\n";
const RESPONSE: &[u8] = b"stream-kit/node-microphone-route/response/v1\n";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    schema_version: u32,
    issued_at_ms: i64,
    expires_at_ms: i64,
    binding: Binding,
    url: String,
    token: String,
}

#[post("/internal/v1/node-microphone-route")]
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
        .ok_or(AppError::Unauthorized)?;
    let signature = req
        .headers()
        .get("x-stream-control-signature")
        .and_then(|v| v.to_str().ok())
        .ok_or(AppError::Unauthorized)?;
    if body.len() > 16384 {
        return Err(AppError::BadRequest);
    }
    super::signed::verify(secret, REQUEST, signature, &body)?;
    let request: Request = serde_json::from_slice(&body).map_err(|_| AppError::BadRequest)?;
    let now = now_ms();
    if request.schema_version != 1
        || request.issued_at_ms < now - 5000
        || request.issued_at_ms > now + 2000
        || request.expires_at_ms <= now
        || request.expires_at_ms <= request.issued_at_ms
        || request.expires_at_ms - request.issued_at_ms > 15000
    {
        return Err(AppError::BadRequest);
    }
    let expires = Instant::now() + Duration::from_millis((request.expires_at_ms - now) as u64);
    let key = MediaSessionKey {
        host_id: HostId(request.binding.host_id),
        app_id: AppId(request.binding.app_id),
    };
    let routes = &app.upstreams().remote_routes;
    let (controller, renewed) = app
        .media_sessions()
        .with_runtime(&key, |policy, controller| {
            let controller = controller
                .filter(|c| remote_routes::matches(policy, Some(c), &request.binding))
                .ok_or(AppError::Unauthorized)?;
            let renewed = routes
                .renew(
                    &key,
                    &request.binding,
                    &controller,
                    &request.url,
                    request.issued_at_ms,
                    expires,
                )
                .map_err(|_| AppError::BadRequest)?;
            Ok::<_, AppError>((controller, renewed))
        })
        .await
        .ok_or(AppError::Unauthorized)??;
    if !renewed {
        let sender = Sender::connect(
            &request.url,
            &request.token,
            request.binding.clone(),
            expires,
        )
        .await
        .map_err(|_| AppError::AudioTargetUnavailable)?;
        app.media_sessions()
            .with_runtime(&key, |policy, current| {
                if current.as_ref() != Some(&controller)
                    || !remote_routes::matches(policy, current.as_ref(), &request.binding)
                {
                    return Err(AppError::Unauthorized);
                }
                routes
                    .install(
                        key.clone(),
                        request.binding.clone(),
                        controller.clone(),
                        request.url,
                        request.issued_at_ms,
                        sender,
                    )
                    .map_err(|_| AppError::BadRequest)
            })
            .await
            .ok_or(AppError::Unauthorized)??;
    }
    let body = serde_json::to_vec(&serde_json::json!({"schema_version":1,"issued_at_ms":request.issued_at_ms,"target_instance_id":request.binding.target_instance_id,"session_id":request.binding.session_id,"target_epoch":request.binding.target_epoch,"control_epoch":request.binding.control_epoch,"connected":true})).map_err(|_| AppError::BadRequest)?;
    let signature = super::signed::sign(secret, RESPONSE, &body)?;
    Ok(HttpResponse::Ok()
        .insert_header(("x-stream-control-signature", signature))
        .insert_header(("cache-control", "no-store"))
        .content_type("application/json")
        .body(body))
}
