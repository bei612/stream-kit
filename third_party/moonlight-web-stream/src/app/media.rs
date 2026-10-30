use std::{collections::HashMap, sync::Arc, time::SystemTime};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::Sha256;

use tokio::sync::RwLock;


use super::{host::{AppId, HostId}, AppError};

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct MediaSessionKey {
    pub host_id: HostId,
    pub app_id: AppId,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PeerRole {
    Viewer,
    Controller,
}

#[derive(Clone, Debug, Deserialize)]
pub struct MediaTicketClaims {
    pub purpose: String,
    pub session_id: String,
    pub connection_id: String,
    pub host_id: i64,
    pub app_id: i64,
    pub role: String,
    pub exp: i64,
    pub iat: i64,
}

#[derive(Deserialize)]
struct MediaTicketHeader {
    alg: String,
    typ: String,
}

pub fn verify_media_ticket(token: &str, secret: &str) -> Result<MediaTicketClaims, AppError> {
    if secret.is_empty() || token.len() > 8192 {
        return Err(AppError::Unauthorized);
    }
    let mut parts = token.split('.');
    let (header, payload, signature) = match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(header), Some(payload), Some(signature), None) => (header, payload, signature),
        _ => return Err(AppError::Unauthorized),
    };
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).map_err(|_| AppError::Unauthorized)?;
    mac.update(format!("{header}.{payload}").as_bytes());
    let provided = URL_SAFE_NO_PAD.decode(signature).map_err(|_| AppError::Unauthorized)?;
    mac.verify_slice(&provided).map_err(|_| AppError::Unauthorized)?;
    let header: MediaTicketHeader = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(header).map_err(|_| AppError::Unauthorized)?)
        .map_err(|_| AppError::Unauthorized)?;
    if header.alg != "HS256" || header.typ != "MEDIA" { return Err(AppError::Unauthorized); }
    let claims: MediaTicketClaims = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).map_err(|_| AppError::Unauthorized)?)
        .map_err(|_| AppError::Unauthorized)?;
    if claims.purpose != "stream-media" || claims.session_id.is_empty() || claims.connection_id.is_empty() || claims.exp <= chrono_like_now()
        || !matches!(claims.role.as_str(), "controller" | "viewer") {
        return Err(AppError::Unauthorized);
    }
    Ok(claims)
}

fn chrono_like_now() -> i64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_secs() as i64
}

#[derive(Clone, Debug)]
pub struct MediaPeer {
    pub id: String,
    pub role: PeerRole,
    pub attached_at: SystemTime,
}

#[derive(Clone, Debug)]
pub struct MediaSessionSnapshot {
    pub key: MediaSessionKey,
    pub peers: Vec<MediaPeer>,
    pub controller_id: Option<String>,
}

#[derive(Debug)]
struct MediaSessionState {
    peers: HashMap<String, MediaPeer>,
    controller_id: Option<String>,
}

#[derive(Clone, Debug)]
pub struct MediaSessionRegistry {
    sessions: Arc<RwLock<HashMap<MediaSessionKey, MediaSessionState>>>,
}

impl Default for MediaSessionRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl MediaSessionRegistry {
    pub fn new() -> Self {
        Self { sessions: Arc::new(RwLock::new(HashMap::new())) }
    }

    pub async fn attach(&self, key: MediaSessionKey, peer_id: String) -> Result<MediaSessionSnapshot, AppError> {
		self.attach_as(key, peer_id, PeerRole::Viewer).await
	}

	pub async fn attach_as(&self, key: MediaSessionKey, peer_id: String, role: PeerRole) -> Result<MediaSessionSnapshot, AppError> {
        let mut sessions = self.sessions.write().await;
        let session = sessions.entry(key.clone()).or_insert_with(|| MediaSessionState {
            peers: HashMap::new(),
            controller_id: None,
        });
        if session.peers.contains_key(&peer_id) {
            return Err(AppError::BadRequest);
        }
        session.peers.insert(peer_id.clone(), MediaPeer {
            id: peer_id.clone(),
            role,
            attached_at: SystemTime::now(),
        });

        Ok(snapshot(&key, session))
    }

    pub async fn detach(&self, key: &MediaSessionKey, peer_id: &str) -> Option<MediaSessionSnapshot> {
        let mut sessions = self.sessions.write().await;
        let session = sessions.get_mut(key)?;
        session.peers.remove(peer_id)?;

        if session.controller_id.as_deref() == Some(peer_id) {
            session.controller_id = None;
        }
        let result = snapshot(key, session);
        if session.peers.is_empty() {
            sessions.remove(key);
        }
        Some(result)
    }

    pub async fn claim_controller(&self, key: &MediaSessionKey, peer_id: &str, force: bool) -> Result<MediaSessionSnapshot, AppError> {
        let mut sessions = self.sessions.write().await;
        let session = sessions.get_mut(key).ok_or(AppError::StreamClosed)?;
        if !session.peers.contains_key(peer_id) {
            return Err(AppError::StreamClosed);
        }
        if let Some(current) = session.controller_id.as_deref() {
            if current != peer_id && !force {
                return Err(AppError::Forbidden);
            }
            if let Some(peer) = session.peers.get_mut(current) {
                peer.role = PeerRole::Viewer;
            }
        }
        session.controller_id = Some(peer_id.to_owned());
        session.peers.get_mut(peer_id).expect("peer checked above").role = PeerRole::Controller;
        Ok(snapshot(key, session))
    }

    pub async fn can_control(&self, key: &MediaSessionKey, peer_id: &str) -> bool {
        self.sessions.read().await.get(key).and_then(|s| s.controller_id.as_deref()).is_some_and(|id| id == peer_id)
    }

    /// Keep the read lock until the synchronous transport operation completes,
    /// so a controller transfer cannot race an already checked queued command.
    pub async fn with_controller<T>(&self, key: &MediaSessionKey, peer_id: &str, action: impl FnOnce() -> T) -> Option<T> {
        let sessions = self.sessions.read().await;
        if sessions.get(key).and_then(|s| s.controller_id.as_deref()) == Some(peer_id) {
            Some(action())
        } else {
            None
        }
    }

    pub async fn snapshot(&self, key: &MediaSessionKey) -> Option<MediaSessionSnapshot> {
        self.sessions.read().await.get(key).map(|s| snapshot(key, s))
    }
}

fn snapshot(key: &MediaSessionKey, session: &MediaSessionState) -> MediaSessionSnapshot {
    MediaSessionSnapshot {
        key: key.clone(),
        peers: session.peers.values().cloned().collect(),
        controller_id: session.controller_id.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;



    fn signed_ticket(exp: i64, role: &str) -> String {
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","typ":"MEDIA"}"#);
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&serde_json::json!({
            "purpose": "stream-media", "session_id": "session", "connection_id": "peer",
            "host_id": 1, "app_id": 2, "role": role, "exp": exp, "iat": 1
        })).unwrap());
        let input = format!("{header}.{payload}");
        let mut mac = Hmac::<Sha256>::new_from_slice(b"test-secret").unwrap();
        mac.update(input.as_bytes());
        format!("{input}.{}", URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
    }

    #[test]
    fn ticket_admission_rejects_expired_forged_and_invalid_roles() {
        let now = chrono_like_now();
        let valid = signed_ticket(now + 120, "controller");
        assert!(verify_media_ticket(&valid, "test-secret").is_ok());
        assert!(verify_media_ticket(&valid, "wrong-secret").is_err());
        assert!(verify_media_ticket(&valid, "").is_err());
        assert!(verify_media_ticket(&signed_ticket(now, "viewer"), "test-secret").is_err());
        assert!(verify_media_ticket(&signed_ticket(now + 120, "admin"), "test-secret").is_err());
        assert!(verify_media_ticket(&(valid + ".extra"), "test-secret").is_err());
    }

    fn key() -> MediaSessionKey { MediaSessionKey { host_id: HostId(1), app_id: AppId(2) } }

    #[tokio::test]
    async fn only_one_controller_is_active() {
        let registry = MediaSessionRegistry::new();
        registry.attach(key(), "a".into()).await.unwrap();
        registry.attach(key(), "b".into()).await.unwrap();
        registry.claim_controller(&key(), "a", false).await.unwrap();
        assert!(registry.claim_controller(&key(), "b", false).await.is_err());
        assert!(!registry.can_control(&key(), "b").await);
        registry.claim_controller(&key(), "b", true).await.unwrap();
        assert!(registry.can_control(&key(), "b").await);
        assert!(!registry.can_control(&key(), "a").await);
    }

    #[tokio::test]
    async fn queued_input_is_rejected_after_controller_transfer_or_detach() {
        let registry = MediaSessionRegistry::new();
        registry.attach(key(), "a".into()).await.unwrap();
        registry.attach(key(), "b".into()).await.unwrap();
        registry.claim_controller(&key(), "a", false).await.unwrap();
        assert_eq!(registry.with_controller(&key(), "a", || 1).await, Some(1));
        registry.claim_controller(&key(), "b", true).await.unwrap();
        assert!(registry.with_controller(&key(), "a", || panic!("revoked input sent")).await.is_none());
        assert_eq!(registry.with_controller(&key(), "b", || 2).await, Some(2));
        registry.detach(&key(), "b").await.unwrap();
        assert!(registry.with_controller(&key(), "b", || panic!("detached microphone sent")).await.is_none());
    }

    #[tokio::test]
    async fn detaching_controller_releases_session_control() {
        let registry = MediaSessionRegistry::new();
        registry.attach(key(), "a".into()).await.unwrap();
        registry.claim_controller(&key(), "a", false).await.unwrap();
        registry.detach(&key(), "a").await.unwrap();
        assert!(registry.snapshot(&key()).await.is_none());
    }

}
