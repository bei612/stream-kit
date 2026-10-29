use std::{collections::HashMap, sync::Arc, time::SystemTime};

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
        let mut sessions = self.sessions.write().await;
        let session = sessions.entry(key.clone()).or_insert_with(|| MediaSessionState {
            peers: HashMap::new(),
            controller_id: None,
        });
        if session.peers.contains_key(&peer_id) {
            return Err(AppError::BadRequest);
        }
        session.peers.insert(peer_id.clone(), MediaPeer {
            id: peer_id,
            role: PeerRole::Viewer,
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

    pub async fn snapshot(&self, key: &MediaSessionKey) -> Option<MediaSessionSnapshot> {
        self.sessions.read().await.get(key).map(|s| snapshot(key, s))
    }
}

fn snapshot(key: &MediaSessionKey, session: &MediaSessionState) -> MediaSessionSnapshot {
    MediaSessionSnapshot { key: key.clone(), peers: session.peers.values().cloned().collect(), controller_id: session.controller_id.clone() }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    async fn detaching_controller_releases_session_control() {
        let registry = MediaSessionRegistry::new();
        registry.attach(key(), "a".into()).await.unwrap();
        registry.claim_controller(&key(), "a", false).await.unwrap();
        registry.detach(&key(), "a").await.unwrap();
        assert!(registry.snapshot(&key()).await.is_none());
    }
}
