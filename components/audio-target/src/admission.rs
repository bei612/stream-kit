//! Node-bound microphone admission. Cryptographic admission is not a runtime
//! lease: the transport must check the live signed session snapshot per frame.
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::Sha256;
use std::collections::HashMap;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct Binding {
    pub source_node_id: String,
    pub target_node_id: String,
    pub target_instance_id: String,
    pub session_id: String,
    pub connection_id: String,
    pub host_id: u32,
    pub app_id: u32,
    pub target_epoch: u64,
    pub control_epoch: u64,
}

#[derive(Deserialize)]
struct Header {
    alg: String,
    typ: String,
}

#[derive(Deserialize)]
struct Claims {
    #[serde(flatten)]
    binding: Binding,
    purpose: String,
    jti: String,
    iat: i64,
    exp: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum AdmissionError {
    #[error("invalid or expired microphone admission")]
    Credential,
    #[error("microphone admission was already consumed")]
    Replay,
    #[error("microphone admission capacity exhausted")]
    Capacity,
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

impl Binding {
    fn valid(&self) -> bool {
        [
            &self.source_node_id,
            &self.target_node_id,
            &self.target_instance_id,
            &self.session_id,
            &self.connection_id,
        ]
        .into_iter()
        .all(|id| valid_id(id))
            && self.source_node_id != self.target_node_id
            && self.target_epoch != 0
            && self.control_epoch != 0
    }
}

fn verify(token: &str, key: &[u8], expected: &Binding, now: i64) -> Result<Claims, AdmissionError> {
    let invalid = || AdmissionError::Credential;
    if key.len() < 32 || token.len() > 8192 || !expected.valid() {
        return Err(invalid());
    }
    let parts: Vec<_> = token.split('.').take(4).collect();
    if parts.len() != 3 {
        return Err(invalid());
    }
    let mut mac = Hmac::<Sha256>::new_from_slice(key).map_err(|_| invalid())?;
    mac.update(parts[0].as_bytes());
    mac.update(b".");
    mac.update(parts[1].as_bytes());
    mac.verify_slice(&URL_SAFE_NO_PAD.decode(parts[2]).map_err(|_| invalid())?)
        .map_err(|_| invalid())?;
    let header: Header =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[0]).map_err(|_| invalid())?)
            .map_err(|_| invalid())?;
    if header.alg != "HS256" || header.typ != "STREAM-MICROPHONE" {
        return Err(invalid());
    }
    let claims: Claims =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).map_err(|_| invalid())?)
            .map_err(|_| invalid())?;
    if &claims.binding != expected
        || claims.purpose != "stream-kit/remote-microphone/v1"
        || claims.iat <= 0
        || claims.iat > now
        || claims.exp <= now
        || claims.exp <= claims.iat
        || claims.exp.saturating_sub(claims.iat) > 5
        || claims.jti.len() != 32
        || !claims
            .jti
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(invalid());
    }
    Ok(claims)
}

/// One ledger per receiver process, shared across all connections behind the
/// same mutex. Never evict a live nonce to admit another connection. A fresh
/// random target_instance_id on every process start invalidates older tickets.
pub struct Admissions {
    used: HashMap<String, i64>,
    capacity: usize,
    last_time: i64,
}

/// Non-cloneable proof of one consumed admission. It conveys no ongoing lease.
pub struct Admitted {
    pub(crate) binding: Binding,
}

impl Admissions {
    pub fn admit(
        &mut self,
        token: &str,
        node_key: &[u8],
        expected: &Binding,
        now: i64,
    ) -> Result<Admitted, AdmissionError> {
        self.consume(token, node_key, expected, now)?;
        Ok(Admitted {
            binding: expected.clone(),
        })
    }
    pub fn new(capacity: usize) -> Self {
        Self {
            used: HashMap::new(),
            capacity,
            last_time: 0,
        }
    }

    /// expected must come from independently verified current node/session
    /// state, including this receiver's actual boot ID, never from the token.
    /// The caller must verify TLS peer identity before consuming a credential.
    pub fn consume(
        &mut self,
        token: &str,
        node_key: &[u8],
        expected: &Binding,
        now: i64,
    ) -> Result<(), AdmissionError> {
        if now < self.last_time {
            return Err(AdmissionError::Credential);
        }
        let claims = verify(token, node_key, expected, now)?;
        self.last_time = now;
        self.used.retain(|_, expires| *expires > now);
        if self.used.contains_key(&claims.jti) {
            return Err(AdmissionError::Replay);
        }
        if self.used.len() >= self.capacity {
            return Err(AdmissionError::Capacity);
        }
        self.used.insert(claims.jti, claims.exp);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (String, Vec<u8>, Binding, i64) {
        let value: serde_json::Value = serde_json::from_str(include_str!(
            "../../../contracts/audio-devices/remote-microphone-v1.fixture.json"
        ))
        .unwrap();
        let key = value["node_key_hex"]
            .as_str()
            .unwrap()
            .as_bytes()
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect();
        (
            value["token"].as_str().unwrap().to_owned(),
            key,
            serde_json::from_value(value["claims"].clone()).unwrap(),
            value["now"].as_i64().unwrap(),
        )
    }

    fn signed(key: &[u8], kind: &str, nonce: &str, issued: i64) -> String {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../contracts/audio-devices/remote-microphone-v1.fixture.json"
        ))
        .unwrap();
        let mut claims = fixture["claims"].clone();
        claims["jti"] = nonce.into();
        claims["iat"] = issued.into();
        claims["exp"] = (issued + 5).into();
        let header = serde_json::json!({"alg":"HS256", "typ":kind});
        let input = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).unwrap()),
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap())
        );
        let mut mac = Hmac::<Sha256>::new_from_slice(key).unwrap();
        mac.update(input.as_bytes());
        format!(
            "{input}.{}",
            URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
        )
    }

    #[test]
    fn capacity_never_evicts_live_nonce_and_expiry_reclaims_space() {
        let (token, key, binding, now) = fixture();
        let mut ledger = Admissions::new(1);
        ledger.consume(&token, &key, &binding, now).unwrap();
        let next = signed(
            &key,
            "STREAM-MICROPHONE",
            "100102030405060708090a0b0c0d0e0f",
            now,
        );
        assert_eq!(
            ledger.consume(&next, &key, &binding, now),
            Err(AdmissionError::Capacity)
        );
        assert_eq!(
            ledger.consume(&token, &key, &binding, now),
            Err(AdmissionError::Replay)
        );
        let fresh = signed(
            &key,
            "STREAM-MICROPHONE",
            "200102030405060708090a0b0c0d0e0f",
            now + 5,
        );
        assert_eq!(ledger.consume(&fresh, &key, &binding, now + 5), Ok(()));
        assert_eq!(ledger.used.len(), 1);
        assert_eq!(
            ledger.consume(&token, &key, &binding, now),
            Err(AdmissionError::Credential)
        );
    }

    #[test]
    fn malformed_and_other_audience_tokens_cannot_consume_a_slot() {
        let (token, key, binding, now) = fixture();
        let mut ledger = Admissions::new(1);
        for kind in ["MEDIA", "JWT", "STREAM-INVITE", "STREAM-CONNECTION"] {
            let other = signed(&key, kind, "000102030405060708090a0b0c0d0e0f", now);
            assert_eq!(
                ledger.consume(&other, &key, &binding, now),
                Err(AdmissionError::Credential)
            );
        }
        for bad in [
            String::new(),
            "a.b.c".into(),
            format!("{token}.extra"),
            "x".repeat(8193),
        ] {
            assert_eq!(
                ledger.consume(&bad, &key, &binding, now),
                Err(AdmissionError::Credential)
            );
        }
        assert_eq!(ledger.consume(&token, &key, &binding, now), Ok(()));
    }

    #[test]
    fn go_fixture_consumes_once_and_rejects_restarted_receiver() {
        let (token, key, binding, now) = fixture();
        let mut ledger = Admissions::new(2);
        assert_eq!(ledger.consume(&token, &key, &binding, now), Ok(()));
        assert_eq!(
            ledger.consume(&token, &key, &binding, now),
            Err(AdmissionError::Replay)
        );
        let mut restarted = binding.clone();
        restarted.target_instance_id = "new-boot".into();
        assert_eq!(
            Admissions::new(2).consume(&token, &key, &restarted, now),
            Err(AdmissionError::Credential)
        );
    }

    #[test]
    fn failures_do_not_consume_capacity_and_clock_rollback_fails_closed() {
        let (token, key, binding, now) = fixture();
        let mut ledger = Admissions::new(1);
        assert_eq!(
            ledger.consume(&token, &[0; 32], &binding, now),
            Err(AdmissionError::Credential)
        );
        assert_eq!(
            ledger.consume(&token, &key, &binding, now - 1),
            Err(AdmissionError::Credential)
        );
        assert_eq!(
            ledger.consume(&token, &key, &binding, now + 5),
            Err(AdmissionError::Credential)
        );
        assert_eq!(ledger.consume(&token, &key, &binding, now + 1), Ok(()));
        assert_eq!(
            ledger.consume(&token, &key, &binding, now),
            Err(AdmissionError::Credential)
        );
        assert_eq!(
            Admissions::new(0).consume(&token, &key, &binding, now),
            Err(AdmissionError::Capacity)
        );
        assert_eq!(ledger.used.len(), 1);
    }

    #[test]
    fn all_route_bindings_are_checked() {
        let (token, key, binding, now) = fixture();
        for field in [
            "source_node_id",
            "target_node_id",
            "session_id",
            "connection_id",
        ] {
            let mut expected = binding.clone();
            match field {
                "source_node_id" => expected.source_node_id = "other".into(),
                "target_node_id" => expected.target_node_id = "other".into(),
                "session_id" => expected.session_id = "other".into(),
                _ => expected.connection_id = "other".into(),
            }
            assert!(
                Admissions::new(1)
                    .consume(&token, &key, &expected, now)
                    .is_err()
            );
        }
        for index in 0..4 {
            let mut expected = binding.clone();
            match index {
                0 => expected.host_id += 1,
                1 => expected.app_id += 1,
                2 => expected.target_epoch += 1,
                _ => expected.control_epoch += 1,
            }
            assert!(
                Admissions::new(1)
                    .consume(&token, &key, &expected, now)
                    .is_err()
            );
        }
    }
}
