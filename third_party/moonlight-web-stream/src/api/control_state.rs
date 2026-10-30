use crate::app::{
    App, AppError,
    control_state::{SIGNING_CONTEXT, StateEnvelope, now_ms},
};
use actix_web::{
    HttpRequest, HttpResponse, post,
    web::{Bytes, Data},
};

#[post("/internal/v2/media-state")]
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
    let signature = super::signed::sign(
        secret,
        crate::app::media_observation::SIGNING_CONTEXT,
        &body,
    )?;
    Ok(HttpResponse::Ok()
        .insert_header(("x-stream-observation-signature", signature))
        .insert_header(("cache-control", "no-store"))
        .content_type("application/json")
        .body(body))
}

fn decode_signed_state(
    secret: &str,
    signature: &str,
    body: &[u8],
) -> Result<StateEnvelope, AppError> {
    super::signed::verify(secret, SIGNING_CONTEXT, signature, body)?;
    serde_json::from_slice(body).map_err(|_| AppError::BadRequest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    #[test]
    fn cross_language_signature_rejects_tampering_and_wrong_domain() {
        let body = include_str!("../../../../contracts/media-state/v2.fixture.json")
            .trim()
            .as_bytes();
        let signature = "ba1977d27b1515dcba31b19028d754620ab0d7ec29b03eb2d67446edf915c427";
        let state = decode_signed_state("contract-test-secret", signature, body)
            .expect("signed state test setup must succeed");
        assert_eq!(state.sessions[0].host_id, 2636897928);
        assert!(decode_signed_state("other", signature, body).is_err());
        assert!(decode_signed_state("", signature, body).is_err());
        let mut changed = body.to_vec();
        changed.push(b' ');
        assert!(decode_signed_state("contract-test-secret", signature, &changed).is_err());
        let mut mac = Hmac::<Sha256>::new_from_slice(b"contract-test-secret")
            .expect("signed state test setup must succeed");
        mac.update(body);
        let no_context = hex::encode(mac.finalize().into_bytes());
        assert!(decode_signed_state("contract-test-secret", &no_context, body).is_err());
    }
}
