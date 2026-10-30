use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::SystemTime,
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::Sha256;

use tokio::sync::RwLock;

use super::{
    AppError,
    host::{AppId, HostId},
};

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
    let (header, payload, signature) =
        match (parts.next(), parts.next(), parts.next(), parts.next()) {
            (Some(header), Some(payload), Some(signature), None) => (header, payload, signature),
            _ => return Err(AppError::Unauthorized),
        };
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).map_err(|_| AppError::Unauthorized)?;
    mac.update(format!("{header}.{payload}").as_bytes());
    let provided = URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|_| AppError::Unauthorized)?;
    mac.verify_slice(&provided)
        .map_err(|_| AppError::Unauthorized)?;
    let header: MediaTicketHeader = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(header)
            .map_err(|_| AppError::Unauthorized)?,
    )
    .map_err(|_| AppError::Unauthorized)?;
    if header.alg != "HS256" || header.typ != "MEDIA" {
        return Err(AppError::Unauthorized);
    }
    let claims: MediaTicketClaims = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(payload)
            .map_err(|_| AppError::Unauthorized)?,
    )
    .map_err(|_| AppError::Unauthorized)?;
    if claims.purpose != "stream-media"
        || claims.session_id.is_empty()
        || claims.connection_id.is_empty()
        || claims.exp <= chrono_like_now()
        || claims.iat <= 0
        || claims.iat > chrono_like_now() + 5
        || claims.exp <= claims.iat
        || claims.exp.saturating_sub(claims.iat) > 120
        || !matches!(claims.role.as_str(), "controller" | "viewer")
    {
        return Err(AppError::Unauthorized);
    }
    Ok(claims)
}

fn chrono_like_now() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

#[derive(Debug)]
struct MediaSessionState {
    // Membership and controller identity are independent. Managed authority is
    // always read from the signed projection, never a cached per-peer role.
    peers: HashSet<String>,
    controller_id: Option<String>,
}

#[derive(Clone, Debug)]
pub struct MediaSessionRegistry {
    pub control: Arc<RwLock<super::control_state::ControlState>>,
    sessions: Arc<RwLock<HashMap<MediaSessionKey, MediaSessionState>>>,
}

impl Default for MediaSessionRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl MediaSessionRegistry {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            control: Default::default(),
        }
    }

    pub async fn attach(&self, key: MediaSessionKey, peer_id: String) -> Result<(), AppError> {
        let mut sessions = self.sessions.write().await;
        let session = sessions.entry(key).or_insert_with(|| MediaSessionState {
            peers: HashSet::new(),
            controller_id: None,
        });
        if !session.peers.insert(peer_id) {
            return Err(AppError::BadRequest);
        }
        Ok(())
    }

    pub async fn detach(&self, key: &MediaSessionKey, peer_id: &str) -> Option<()> {
        let mut sessions = self.sessions.write().await;
        let session = sessions.get_mut(key)?;
        if !session.peers.remove(peer_id) {
            return None;
        }

        if session.controller_id.as_deref() == Some(peer_id) {
            session.controller_id = None;
        }
        if session.peers.is_empty() {
            sessions.remove(key);
        }
        Some(())
    }

    pub async fn claim_controller(
        &self,
        key: &MediaSessionKey,
        peer_id: &str,
        force: bool,
    ) -> Result<(), AppError> {
        let mut sessions = self.sessions.write().await;
        let session = sessions.get_mut(key).ok_or(AppError::StreamClosed)?;
        if !session.peers.contains(peer_id) {
            return Err(AppError::StreamClosed);
        }
        if let Some(current) = session.controller_id.as_deref()
            && current != peer_id
            && !force
        {
            return Err(AppError::Forbidden);
        }
        session.controller_id = Some(peer_id.to_owned());
        Ok(())
    }

    pub async fn can_control(&self, key: &MediaSessionKey, peer_id: &str) -> bool {
        let control = self.control.read().await;
        if control.required {
            return control.controls(key, peer_id, super::control_state::now_ms());
        }
        self.sessions
            .read()
            .await
            .get(key)
            .and_then(|s| s.controller_id.as_deref())
            .is_some_and(|id| id == peer_id)
    }

    /// Keep the read lock until the synchronous transport operation completes,
    /// so a controller transfer cannot race an already checked queued command.
    pub async fn with_controller<T>(
        &self,
        key: &MediaSessionKey,
        peer_id: &str,
        action: impl FnOnce() -> T,
    ) -> Option<T> {
        self.with_authority(key, peer_id, false, |_| action()).await
    }

    pub async fn with_microphone<T>(
        &self,
        key: &MediaSessionKey,
        peer_id: &str,
        action: impl FnOnce(&super::control_state::AudioPolicy) -> T,
    ) -> Option<T> {
        self.with_authority(key, peer_id, true, action).await
    }

    async fn with_authority<T>(
        &self,
        key: &MediaSessionKey,
        peer_id: &str,
        microphone: bool,
        action: impl FnOnce(&super::control_state::AudioPolicy) -> T,
    ) -> Option<T> {
        let control = self.control.read().await;
        if control.required {
            let now = super::control_state::now_ms();
            if !control.controls(key, peer_id, now) {
                return None;
            }
            // A logical lease cannot authorize queued input from a detached
            // transport. Hold both read locks through delivery so detach and
            // control transfer share the same boundary.
            let sessions = self.sessions.read().await;
            if !sessions.get(key).is_some_and(|s| s.peers.contains(peer_id)) {
                return None;
            }
            let policy = &control.session(key, now)?.audio;
            return if !microphone || policy.microphone_enabled {
                Some(action(policy))
            } else {
                None
            };
        }
        let sessions = self.sessions.read().await;
        if sessions.get(key).and_then(|s| s.controller_id.as_deref()) == Some(peer_id) {
            Some(action(&Default::default()))
        } else {
            None
        }
    }

    pub async fn admitted(&self, key: &MediaSessionKey, peer_id: &str) -> bool {
        let control = self.control.read().await;
        !control.required || control.admits(key, peer_id, super::control_state::now_ms())
    }
    /// Select policy and controller atomically, and hold authority through
    /// publishing the mixed frame so transfer cannot race buffered microphone.
    pub async fn with_audio_output<T>(
        &self,
        key: &MediaSessionKey,
        action: impl FnOnce(&super::control_state::AudioPolicy, Option<&str>) -> T,
    ) -> Option<T> {
        let control = self.control.read().await;
        if control.required {
            let now = super::control_state::now_ms();
            let session = control.session(key, now)?;
            let controller = session.controller_connection_id.as_str();
            let sessions = self.sessions.read().await;
            let attached = sessions
                .get(key)
                .is_some_and(|s| s.peers.contains(controller));
            return Some(action(
                &session.audio,
                (attached && control.controls(key, controller, now)).then_some(controller),
            ));
        }
        let sessions = self.sessions.read().await;
        let session = sessions.get(key)?;
        Some(action(
            &Default::default(),
            session.controller_id.as_deref(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signed_ticket(exp: i64, role: &str) -> String {
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","typ":"MEDIA"}"#);
        let payload = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&serde_json::json!({
                "purpose": "stream-media", "session_id": "session", "connection_id": "peer",
            "host_id": 1, "app_id": 2, "role": role, "exp": exp, "iat": chrono_like_now()
            }))
            .expect("media authority test setup must succeed"),
        );
        let input = format!("{header}.{payload}");
        let mut mac = Hmac::<Sha256>::new_from_slice(b"test-secret")
            .expect("media authority test setup must succeed");
        mac.update(input.as_bytes());
        format!(
            "{input}.{}",
            URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
        )
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

    fn key() -> MediaSessionKey {
        MediaSessionKey {
            host_id: HostId(1),
            app_id: AppId(2),
        }
    }

    #[tokio::test]
    async fn only_one_controller_is_active() {
        let registry = MediaSessionRegistry::new();
        registry
            .attach(key(), "a".into())
            .await
            .expect("media authority test setup must succeed");
        registry
            .attach(key(), "b".into())
            .await
            .expect("media authority test setup must succeed");
        registry
            .claim_controller(&key(), "a", false)
            .await
            .expect("media authority test setup must succeed");
        assert!(registry.claim_controller(&key(), "b", false).await.is_err());
        assert!(!registry.can_control(&key(), "b").await);
        registry
            .claim_controller(&key(), "b", true)
            .await
            .expect("media authority test setup must succeed");
        assert!(registry.can_control(&key(), "b").await);
        assert!(!registry.can_control(&key(), "a").await);
    }

    #[tokio::test]
    async fn queued_input_is_rejected_after_controller_transfer_or_detach() {
        let registry = MediaSessionRegistry::new();
        registry
            .attach(key(), "a".into())
            .await
            .expect("media authority test setup must succeed");
        registry
            .attach(key(), "b".into())
            .await
            .expect("media authority test setup must succeed");
        registry
            .claim_controller(&key(), "a", false)
            .await
            .expect("media authority test setup must succeed");
        assert_eq!(registry.with_controller(&key(), "a", || 1).await, Some(1));
        registry
            .claim_controller(&key(), "b", true)
            .await
            .expect("media authority test setup must succeed");
        assert!(
            registry
                .with_controller(&key(), "a", || panic!("revoked input sent"))
                .await
                .is_none()
        );
        assert_eq!(registry.with_controller(&key(), "b", || 2).await, Some(2));
        registry
            .detach(&key(), "b")
            .await
            .expect("media authority test setup must succeed");
        assert!(
            registry
                .with_controller(&key(), "b", || panic!("detached microphone sent"))
                .await
                .is_none()
        );
    }

    #[tokio::test]
    async fn audio_output_uses_live_authority_under_the_publication_lock() {
        use super::super::control_state::{StateEnvelope, now_ms};
        let registry = MediaSessionRegistry::new();
        let now = now_ms();
        let mut state: StateEnvelope = serde_json::from_str(include_str!(
            "../../../../contracts/media-state/v1.fixture.json"
        ))
        .expect("media authority test setup must succeed");
        state.issued_at_ms = now;
        state.expires_at_ms = now + 10000;
        state.sessions[0].host_id = 1;
        state.sessions[0].app_id = 2;
        for connection in &mut state.sessions[0].connections {
            connection.expires_at_ms = now + 10000;
        }
        {
            let mut control = registry.control.write().await;
            control.required = true;
            control
                .apply(state, now)
                .expect("media authority test setup must succeed");
        }
        assert_eq!(
            registry
                .with_audio_output(&key(), |_, controller| controller.map(str::to_owned))
                .await,
            Some(None)
        );
        registry
            .attach(key(), "client-a".into())
            .await
            .expect("attach controller transport");
        assert_eq!(
            registry
                .with_audio_output(&key(), |policy, controller| {
                    assert!(
                        registry.control.try_write().is_err(),
                        "publication must retain authority lock"
                    );
                    assert!(policy.microphone_enabled);
                    assert!(
                        registry.sessions.try_write().is_err(),
                        "publication must retain membership lock"
                    );
                    controller.map(str::to_owned)
                })
                .await,
            Some(Some("client-a".to_owned()))
        );

        assert_eq!(
            registry.with_controller(&key(), "client-a", || 1).await,
            Some(1)
        );
        registry
            .detach(&key(), "client-a")
            .await
            .expect("detach controller transport");
        assert!(
            registry
                .with_controller(&key(), "client-a", || panic!("detached input delivered"))
                .await
                .is_none()
        );
        assert!(
            registry
                .with_microphone(&key(), "client-a", |_| panic!(
                    "detached microphone delivered"
                ))
                .await
                .is_none()
        );
        assert_eq!(
            registry
                .with_audio_output(&key(), |_, controller| controller.map(str::to_owned))
                .await,
            Some(None)
        );

        // Removing a session in the next signed projection prevents output;
        // no old buffered microphone can be published after this boundary.
        registry
            .control
            .write()
            .await
            .apply(
                StateEnvelope {
                    schema_version: 1,
                    issued_at_ms: now + 1,
                    expires_at_ms: now + 10000,
                    sessions: vec![],
                },
                now + 1,
            )
            .expect("media authority test setup must succeed");
        assert!(
            registry
                .with_audio_output(&key(), |_, _| panic!("revoked session published audio"))
                .await
                .is_none()
        );
    }

    #[tokio::test]
    async fn detaching_controller_releases_session_control() {
        let registry = MediaSessionRegistry::new();
        registry
            .attach(key(), "a".into())
            .await
            .expect("media authority test setup must succeed");
        registry
            .claim_controller(&key(), "a", false)
            .await
            .expect("media authority test setup must succeed");
        registry
            .detach(&key(), "a")
            .await
            .expect("media authority test setup must succeed");
        assert!(registry.sessions.read().await.is_empty());
    }
}
