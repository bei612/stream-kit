//! Domain-separated control-plane messages; credentials never enter URLs.
use crate::app::AppError;
use hmac::{Hmac, Mac};
use sha2::Sha256;

pub fn verify(secret: &str, context: &[u8], signature: &str, body: &[u8]) -> Result<(), AppError> {
    if secret.is_empty() || signature.len() != 64 {
        return Err(AppError::Unauthorized);
    }
    let signature = hex::decode(signature).map_err(|_| AppError::Unauthorized)?;
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).map_err(|_| AppError::Unauthorized)?;
    mac.update(context);
    mac.update(body);
    mac.verify_slice(&signature)
        .map_err(|_| AppError::Unauthorized)
}

pub fn sign(secret: &str, context: &[u8], body: &[u8]) -> Result<String, AppError> {
    if secret.is_empty() {
        return Err(AppError::Unauthorized);
    }
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).map_err(|_| AppError::Unauthorized)?;
    mac.update(context);
    mac.update(body);
    Ok(hex::encode(mac.finalize().into_bytes()))
}
