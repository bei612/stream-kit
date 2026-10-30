use crate::app::{
    App, AppError,
    control_state::{SIGNING_CONTEXT, StateEnvelope, now_ms},
};
use actix_web::{
    HttpRequest, HttpResponse, post,
    web::{Bytes, Data},
};
use hmac::{Hmac, Mac};
use sha2::Sha256;

#[post("/internal/v1/media-state")]
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
        .get("x-stream-state-signature")
        .and_then(|s| s.to_str().ok())
        .ok_or(AppError::Unauthorized)?;
    let state = decode_signed_state(secret, signature, &body)?;
    let issued_at_ms = state.issued_at_ms;
    let sessions = state.sessions.clone();
    app.media_sessions()
        .control
        .write()
        .await
        .apply(state, now_ms())?;
    let acknowledgement = crate::app::media_observation::Acknowledgement {
        schema_version: 1,
        state_issued_at_ms: issued_at_ms,
        sessions: app.upstreams().observe(&sessions).await,
        observed_at_ms: now_ms(),
    };
    let body = serde_json::to_vec(&acknowledgement).map_err(|_| AppError::BadRequest)?;
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).map_err(|_| AppError::Unauthorized)?;
    mac.update(crate::app::media_observation::SIGNING_CONTEXT);
    mac.update(&body);
    Ok(HttpResponse::Ok()
        .insert_header((
            "x-stream-observation-signature",
            hex::encode(mac.finalize().into_bytes()),
        ))
        .insert_header(("cache-control", "no-store"))
        .content_type("application/json")
        .body(body))
}

fn decode_signed_state(
    secret: &str,
    signature: &str,
    body: &[u8],
) -> Result<StateEnvelope, AppError> {
    if secret.is_empty() || signature.len() != 64 {
        return Err(AppError::Unauthorized);
    }
    let signature = hex::decode(signature).map_err(|_| AppError::Unauthorized)?;
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).map_err(|_| AppError::Unauthorized)?;
    mac.update(SIGNING_CONTEXT);
    mac.update(body);
    mac.verify_slice(&signature)
        .map_err(|_| AppError::Unauthorized)?;
    serde_json::from_slice(body).map_err(|_| AppError::BadRequest)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cross_language_signature_rejects_tampering_and_wrong_domain() {
        let body = include_str!("../../../../contracts/media-state/v1.fixture.json")
            .trim()
            .as_bytes();
        let signature = "b3efbc5198168d4923d53aaca0cfc4453d773a349712e0249a0e4b556623d98c";
        let state = decode_signed_state("contract-test-secret", signature, body).unwrap();
        assert_eq!(state.sessions[0].host_id, 2636897928);
        assert!(decode_signed_state("other", signature, body).is_err());
        assert!(decode_signed_state("", signature, body).is_err());
        let mut changed = body.to_vec();
        changed.push(b' ');
        assert!(decode_signed_state("contract-test-secret", signature, &changed).is_err());
        let mut mac = Hmac::<Sha256>::new_from_slice(b"contract-test-secret").unwrap();
        mac.update(body);
        let no_context = hex::encode(mac.finalize().into_bytes());
        assert!(decode_signed_state("contract-test-secret", &no_context, body).is_err());
    }
}
