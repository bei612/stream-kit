use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
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
    peers: HashMap<String, u64>,
    control_epoch: u64,
    controller_id: Option<String>,
}

/// A command is bound to both durable ownership and a physical attachment.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ControlGrant {
    pub peer_id: String,
    session_id: String,
    epoch: u64,
    attachment: u64,
}

#[derive(Clone, Debug)]
pub struct MediaSessionRegistry {
    pub control: Arc<RwLock<super::control_state::ControlState>>,
    generation: Arc<AtomicU64>,
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
            generation: Arc::new(AtomicU64::new(1)),
        }
    }

    pub async fn attach(&self, key: MediaSessionKey, peer_id: String) -> Result<(), AppError> {
        let mut sessions = self.sessions.write().await;
        let session = sessions.entry(key).or_insert_with(|| MediaSessionState {
            peers: HashMap::new(),
            control_epoch: 0,
            controller_id: None,
        });
        if session.peers.contains_key(&peer_id) {
            return Err(AppError::BadRequest);
        }
        session.peers.insert(peer_id, self.next_generation()?);
        Ok(())
    }

    pub async fn detach(&self, key: &MediaSessionKey, peer_id: &str) -> Option<()> {
        let mut sessions = self.sessions.write().await;
        let session = sessions.get_mut(key)?;
        session.peers.remove(peer_id)?;

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
        if !session.peers.contains_key(peer_id) {
            return Err(AppError::StreamClosed);
        }
        if let Some(current) = session.controller_id.as_deref()
            && current != peer_id
            && !force
        {
            return Err(AppError::Forbidden);
        }
        if session.controller_id.as_deref() != Some(peer_id) {
            session.control_epoch = self.next_generation()?;
            session.controller_id = Some(peer_id.to_owned());
        }
        Ok(())
    }

    fn next_generation(&self) -> Result<u64, AppError> {
        self.generation
            .try_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_add(1))
            .map_err(|_| AppError::StreamClosed)
    }

    pub async fn can_control(&self, key: &MediaSessionKey, peer_id: &str) -> bool {
        self.with_controller(key, peer_id, |_| ()).await.is_some()
    }

    pub async fn with_controller<T>(
        &self,
        key: &MediaSessionKey,
        peer_id: &str,
        action: impl FnOnce(ControlGrant) -> T,
    ) -> Option<T> {
        self.with_runtime(key, |_, grant| {
            grant.filter(|g| g.peer_id == peer_id).map(action)
        })
        .await
        .flatten()
    }

    pub async fn with_microphone<T>(
        &self,
        key: &MediaSessionKey,
        peer_id: &str,
        action: impl FnOnce(&super::control_state::AudioPolicy, ControlGrant) -> T,
    ) -> Option<T> {
        self.with_runtime(key, |policy, grant| {
            grant
                .filter(|g| g.peer_id == peer_id && policy.microphone_enabled)
                .map(|grant| action(policy, grant))
        })
        .await
        .flatten()
    }

    pub async fn admitted(&self, key: &MediaSessionKey, peer_id: &str) -> bool {
        let control = self.control.read().await;
        !control.required || control.admits(key, peer_id, super::control_state::now_ms())
    }

    /// One atomic boundary for input, microphone and output. Both projection
    /// and attachment locks remain held until the synchronous operation ends.
    pub async fn with_runtime<T>(
        &self,
        key: &MediaSessionKey,
        action: impl FnOnce(&super::control_state::AudioPolicy, Option<ControlGrant>) -> T,
    ) -> Option<T> {
        let control = self.control.read().await;
        let sessions = self.sessions.read().await;
        if control.required {
            let now = super::control_state::now_ms();
            let session = control.session(key, now)?;
            let controller = &session.controller_connection_id;
            let grant = sessions
                .get(key)
                .and_then(|s| s.peers.get(controller))
                .filter(|_| control.controls(key, controller, now))
                .map(|attachment| ControlGrant {
                    peer_id: controller.clone(),
                    session_id: session.session_id.clone(),
                    epoch: session.control_epoch,
                    attachment: *attachment,
                });
            return Some(action(&session.audio, grant));
        }
        let session = sessions.get(key)?;
        let grant = session.controller_id.as_ref().and_then(|id| {
            session.peers.get(id).map(|attachment| ControlGrant {
                peer_id: id.clone(),
                session_id: String::new(),
                epoch: session.control_epoch,
                attachment: *attachment,
            })
        });
        Some(action(&Default::default(), grant))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn grants_distinguish_reattach_and_coalesced_managed_transfer() {
        use super::super::control_state::{StateEnvelope, now_ms};
        let registry = MediaSessionRegistry::new();
        let now = now_ms();
        let fixture = || {
            let mut state: StateEnvelope = serde_json::from_str(include_str!(
                "../../../../contracts/media-state/v3.fixture.json"
            ))
            .expect("fixture");
            state.issued_at_ms = now;
            state.expires_at_ms = now + 10000;
            state.sessions[0].host_id = 1;
            state.sessions[0].app_id = 2;
            for c in &mut state.sessions[0].connections {
                c.expires_at_ms = now + 10000;
            }
            state
        };
        registry.control.write().await.required = true;
        registry
            .control
            .write()
            .await
            .apply(fixture(), now)
            .expect("initial state");
        registry
            .attach(key(), "client-a".into())
            .await
            .expect("attach");
        let old = registry
            .with_controller(&key(), "client-a", |g| g)
            .await
            .expect("grant");
        let mut heartbeat = fixture();
        heartbeat.issued_at_ms += 1;
        heartbeat.sessions[0].revision += 1;
        registry
            .control
            .write()
            .await
            .apply(heartbeat, now + 1)
            .expect("heartbeat");
        assert_eq!(
            registry.with_controller(&key(), "client-a", |g| g).await,
            Some(old.clone())
        );
        let mut transfer = fixture();
        transfer.issued_at_ms += 2;
        transfer.sessions[0].revision += 3;
        transfer.sessions[0].control_epoch += 2;
        registry
            .control
            .write()
            .await
            .apply(transfer, now + 2)
            .expect("coalesced transfer");
        let new = registry
            .with_controller(&key(), "client-a", |g| g)
            .await
            .expect("new grant");
        assert_ne!(
            old, new,
            "same controller ID must not revive old queued commands"
        );
        registry.detach(&key(), "client-a").await.expect("detach");
        registry
            .attach(key(), "client-a".into())
            .await
            .expect("reattach");
        let reattached = registry
            .with_controller(&key(), "client-a", |g| g)
            .await
            .expect("reattached grant");
        assert_ne!(
            new, reattached,
            "old physical transport must not survive reconnect"
        );
        assert_eq!(reattached.epoch, new.epoch);
    }

    #[tokio::test]
    async fn standalone_transfer_also_invalidates_queued_grants() {
        let registry = MediaSessionRegistry::new();
        registry.attach(key(), "a".into()).await.expect("attach a");
        registry.attach(key(), "b".into()).await.expect("attach b");
        registry
            .claim_controller(&key(), "a", false)
            .await
            .expect("claim a");
        let old = registry
            .with_controller(&key(), "a", |g| g)
            .await
            .expect("grant");
        registry
            .claim_controller(&key(), "b", true)
            .await
            .expect("transfer b");
        registry
            .claim_controller(&key(), "a", true)
            .await
            .expect("transfer a");
        let new = registry
            .with_controller(&key(), "a", |g| g)
            .await
            .expect("grant");
        assert_ne!(old, new);
    }

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
        assert_eq!(registry.with_controller(&key(), "a", |_| 1).await, Some(1));
        registry
            .claim_controller(&key(), "b", true)
            .await
            .expect("media authority test setup must succeed");
        assert!(
            registry
                .with_controller(&key(), "a", |_| panic!("revoked input sent"))
                .await
                .is_none()
        );
        assert_eq!(registry.with_controller(&key(), "b", |_| 2).await, Some(2));
        registry
            .detach(&key(), "b")
            .await
            .expect("media authority test setup must succeed");
        assert!(
            registry
                .with_controller(&key(), "b", |_| panic!("detached microphone sent"))
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
            "../../../../contracts/media-state/v3.fixture.json"
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
                .with_runtime(&key(), |_, controller| controller.map(|g| g.peer_id))
                .await,
            Some(None)
        );
        registry
            .attach(key(), "client-a".into())
            .await
            .expect("attach controller transport");
        assert_eq!(
            registry
                .with_runtime(&key(), |policy, controller| {
                    assert!(
                        registry.control.try_write().is_err(),
                        "publication must retain authority lock"
                    );
                    assert!(policy.microphone_enabled);
                    assert!(
                        registry.sessions.try_write().is_err(),
                        "publication must retain membership lock"
                    );
                    controller.map(|g| g.peer_id)
                })
                .await,
            Some(Some("client-a".to_owned()))
        );

        assert_eq!(
            registry.with_controller(&key(), "client-a", |_| 1).await,
            Some(1)
        );
        registry
            .detach(&key(), "client-a")
            .await
            .expect("detach controller transport");
        assert!(
            registry
                .with_controller(&key(), "client-a", |_| panic!("detached input delivered"))
                .await
                .is_none()
        );
        assert!(
            registry
                .with_microphone(&key(), "client-a", |_, _| panic!(
                    "detached microphone delivered"
                ))
                .await
                .is_none()
        );
        assert_eq!(
            registry
                .with_runtime(&key(), |_, controller| controller.map(|g| g.peer_id))
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
                    schema_version: 3,
                    issued_at_ms: now + 1,
                    expires_at_ms: now + 10000,
                    sessions: vec![],
                },
                now + 1,
            )
            .expect("media authority test setup must succeed");
        assert!(
            registry
                .with_runtime(&key(), |_, _| panic!("revoked session published audio"))
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
