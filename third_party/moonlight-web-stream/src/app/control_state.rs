//! Versioned, leased control-plane projection. Only signed server snapshots
//! can replace it; browser tickets cannot grant or renew runtime authority.
use super::{AppError, media::MediaSessionKey};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    time::{SystemTime, UNIX_EPOCH},
};

pub const SIGNING_CONTEXT: &[u8] = b"stream-kit/media-state/v3\n";
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::host::{AppId, HostId};

    const NOW: i64 = 1700000000000;
    fn fixture() -> StateEnvelope {
        serde_json::from_str(include_str!(
            "../../../../contracts/media-state/v3.fixture.json"
        ))
        .expect("valid authority fixture must be accepted")
    }
    fn key() -> MediaSessionKey {
        MediaSessionKey {
            host_id: HostId(2636897928),
            app_id: AppId(609885969),
        }
    }

    #[test]
    fn lease_expiry_and_transfer_revoke_runtime_authority() {
        let mut state = ControlState::default();
        state
            .apply(fixture(), NOW)
            .expect("valid authority fixture must be accepted");
        assert!(state.controls(&key(), "client-a", NOW));
        assert!(!state.controls(&key(), "client-b", NOW));
        let mut transfer = fixture();
        transfer.issued_at_ms += 1;
        transfer.sessions[0].revision += 1;
        transfer.sessions[0].control_epoch += 1;
        transfer.sessions[0].controller_connection_id = "client-b".into();
        transfer.sessions[0].connections[1].expires_at_ms = NOW + 100;
        state
            .apply(transfer, NOW + 1)
            .expect("valid authority fixture must be accepted");
        assert!(!state.controls(&key(), "client-a", NOW + 1));
        assert!(state.controls(&key(), "client-b", NOW + 1));
        assert!(!state.controls(&key(), "client-b", NOW + 100));
        assert!(!state.admits(&key(), "client-a", NOW + 10000));
    }

    #[test]
    fn rejects_replay_rollback_and_invalid_snapshot_atomically() {
        let mut state = ControlState::default();
        state
            .apply(fixture(), NOW)
            .expect("valid authority fixture must be accepted");
        assert!(state.apply(fixture(), NOW).is_err());
        let mut rollback = fixture();
        rollback.issued_at_ms += 1;
        rollback.sessions[0].revision -= 1;
        assert!(state.apply(rollback, NOW + 1).is_err());
        let mut duplicate = fixture();
        duplicate.issued_at_ms += 1;
        duplicate.sessions.push(duplicate.sessions[0].clone());
        assert!(state.apply(duplicate, NOW + 1).is_err());
        let mut duplicate_peer = fixture();
        duplicate_peer.issued_at_ms += 1;
        let peer = duplicate_peer.sessions[0].connections[0].clone();
        duplicate_peer.sessions[0].connections.push(peer);
        assert!(state.apply(duplicate_peer, NOW + 1).is_err());
        let mut unknown = fixture();
        unknown.issued_at_ms += 1;
        unknown.sessions[0].controller_connection_id = "intruder".into();
        assert!(state.apply(unknown, NOW + 1).is_err());
        assert!(state.controls(&key(), "client-a", NOW + 1));
        let mut valid = fixture();
        valid.issued_at_ms += 1;
        valid.sessions.clear();
        state
            .apply(valid, NOW + 1)
            .expect("valid authority fixture must be accepted");
        assert!(!state.admits(&key(), "client-a", NOW + 1));
    }

    #[test]
    fn rejects_future_expired_and_excessive_leases() {
        for (issued, expires) in [(NOW + 2001, NOW + 10000), (NOW, NOW), (NOW, NOW + 15001)] {
            let mut envelope = fixture();
            envelope.issued_at_ms = issued;
            envelope.expires_at_ms = expires;
            assert!(ControlState::default().apply(envelope, NOW).is_err());
        }
    }

    #[test]
    fn rejects_old_schema_and_invalid_control_generations_atomically() {
        let mut state = ControlState::default();
        state.apply(fixture(), NOW).expect("initial state");
        for (epoch, revision, controller) in [
            (0, 8, "client-a"),
            (9, 8, "client-a"),
            (4, 8, "client-a"),
            (5, 8, "client-b"),
        ] {
            let mut next = fixture();
            next.issued_at_ms += 1;
            next.sessions[0].control_epoch = epoch;
            next.sessions[0].revision = revision;
            next.sessions[0].controller_connection_id = controller.into();
            assert!(state.apply(next, NOW + 1).is_err());
            assert!(state.controls(&key(), "client-a", NOW + 1));
        }
        let mut old = fixture();
        old.schema_version = 1;
        old.issued_at_ms += 1;
        assert!(state.apply(old, NOW + 1).is_err());
        let mut coalesced = fixture();
        coalesced.issued_at_ms += 1;
        coalesced.sessions[0].control_epoch += 2;
        coalesced.sessions[0].revision += 2;
        state
            .apply(coalesced, NOW + 1)
            .expect("coalesced A B A must retain new epoch");
        assert_eq!(
            state
                .session(&key(), NOW + 1)
                .expect("session")
                .control_epoch,
            7
        );
    }

    #[test]
    fn target_generation_and_native_reservations_are_atomic() {
        let mut state = ControlState::default();
        state.apply(fixture(), NOW).expect("initial");
        for (epoch, revision, render) in [
            (0, 8, "test-render-not-opened"),
            (2, 8, "test-render-not-opened"),
            (3, 8, "different"),
            (4, 8, "different"),
            (9, 8, "different"),
        ] {
            let mut next = fixture();
            next.issued_at_ms += 1;
            next.sessions[0].revision = revision;
            next.sessions[0].audio.target.epoch = epoch;
            next.sessions[0].audio.target.render_device_id = render.into();
            assert!(state.apply(next, NOW + 1).is_err());
            assert_eq!(
                state
                    .session(&key(), NOW + 1)
                    .expect("unchanged")
                    .audio
                    .target
                    .epoch,
                3
            );
        }
        let mut duplicate = fixture();
        duplicate.issued_at_ms += 1;
        let mut other = duplicate.sessions[0].clone();
        other.app_id += 1;
        other.session_id = "other".into();
        std::mem::swap(
            &mut other.audio.target.render_device_id,
            &mut other.audio.target.capture_device_id,
        );
        duplicate.sessions.push(other);
        assert!(state.apply(duplicate, NOW + 1).is_err());
        let mut next = fixture();
        next.issued_at_ms += 1;
        next.sessions[0].revision = 8;
        next.sessions[0].audio.target.epoch = 8;
        next.sessions[0].audio.target.render_device_id = "new-render".into();
        state.apply(next, NOW + 1).expect("new route generation");
        assert_eq!(
            state
                .session(&key(), NOW + 1)
                .expect("committed")
                .audio
                .target
                .epoch,
            8
        );
        let mut old = fixture();
        old.schema_version = 2;
        old.issued_at_ms += 2;
        assert!(state.apply(old, NOW + 2).is_err());
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct AudioPolicy {
    pub target: AudioTarget,
    pub program_gain_db: f32,
    pub microphone_gain_db: f32,
    pub microphone_enabled: bool,
    pub broadcast_controller_microphone: bool,
}
impl Default for AudioPolicy {
    fn default() -> Self {
        Self {
            target: AudioTarget::default(),
            program_gain_db: 0.0,
            microphone_gain_db: 0.0,
            microphone_enabled: true,
            broadcast_controller_microphone: true,
        }
    }
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TargetMode {
    Disabled,
    #[default]
    Upstream,
    Local,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AudioTarget {
    pub epoch: u64,
    pub mode: TargetMode,
    pub render_device_id: String,
    pub capture_device_id: String,
}
impl AudioTarget {
    pub fn endpoint(&self) -> Option<stream_kit_audio_target::EndpointPair> {
        (self.mode == TargetMode::Local).then(|| stream_kit_audio_target::EndpointPair {
            render_device_id: self.render_device_id.clone(),
            capture_device_id: self.capture_device_id.clone(),
        })
    }
    fn valid(&self, revision: u64) -> bool {
        let id = |value: &str| {
            !value.is_empty()
                && value.len() <= 4096
                && value.trim() == value
                && !value.chars().any(char::is_control)
        };
        self.epoch > 0
            && self.epoch <= revision
            && match self.mode {
                TargetMode::Local => {
                    id(&self.render_device_id)
                        && id(&self.capture_device_id)
                        && self.render_device_id != self.capture_device_id
                }
                _ => self.render_device_id.is_empty() && self.capture_device_id.is_empty(),
            }
    }
}
#[derive(Clone, Debug, Deserialize)]
pub struct ConnectionAuthority {
    pub connection_id: String,
    pub expires_at_ms: i64,
}
#[derive(Clone, Debug, Deserialize)]
pub struct SessionAuthority {
    pub control_epoch: u64,
    pub session_id: String,
    pub revision: u64,
    pub host_id: u32,
    pub app_id: u32,
    pub controller_connection_id: String,
    pub connections: Vec<ConnectionAuthority>,
    pub audio: AudioPolicy,
}
#[derive(Debug, Deserialize)]
pub struct StateEnvelope {
    pub schema_version: u32,
    pub issued_at_ms: i64,
    pub expires_at_ms: i64,
    pub sessions: Vec<SessionAuthority>,
}
#[derive(Debug, Default)]
pub struct ControlState {
    pub required: bool,
    issued_at_ms: i64,
    expires_at_ms: i64,
    sessions: HashMap<(u32, u32), SessionAuthority>,
}
impl ControlState {
    pub fn apply(&mut self, envelope: StateEnvelope, now: i64) -> Result<(), AppError> {
        if envelope.schema_version != 3
            || envelope.issued_at_ms <= self.issued_at_ms
            || envelope.issued_at_ms > now + 2000
            || envelope.expires_at_ms <= now
            || envelope.expires_at_ms <= envelope.issued_at_ms
            || envelope.expires_at_ms - envelope.issued_at_ms > 15000
        {
            return Err(AppError::BadRequest);
        }
        let mut sessions = HashMap::new();
        let mut endpoints = HashSet::new();
        for session in envelope.sessions {
            if session.session_id.is_empty()
                || session.revision == 0
                || session.control_epoch == 0
                || session.control_epoch > session.revision
                || !session.audio.target.valid(session.revision)
                || !(-60.0..=12.0).contains(&session.audio.program_gain_db)
                || !(-60.0..=12.0).contains(&session.audio.microphone_gain_db)
            {
                return Err(AppError::BadRequest);
            }
            if let Some(pair) = session.audio.target.endpoint()
                && (!endpoints.insert(pair.render_device_id)
                    || !endpoints.insert(pair.capture_device_id))
            {
                return Err(AppError::BadRequest);
            }
            let mut connections = HashSet::new();
            for connection in &session.connections {
                if connection.connection_id.is_empty()
                    || !connections.insert(connection.connection_id.as_str())
                {
                    return Err(AppError::BadRequest);
                }
            }
            if !session.controller_connection_id.is_empty()
                && !connections.contains(session.controller_connection_id.as_str())
            {
                return Err(AppError::BadRequest);
            }
            let key = (session.host_id, session.app_id);
            if let Some(old) = self.sessions.get(&key)
                && old.session_id == session.session_id
                && (old.revision > session.revision
                    || old.audio.target.epoch > session.audio.target.epoch
                    || (old.audio.target.epoch != session.audio.target.epoch
                        && session.audio.target.epoch <= old.revision)
                    || (old.audio.target.epoch == session.audio.target.epoch
                        && old.audio.target != session.audio.target)
                    || old.control_epoch > session.control_epoch
                    || (!session.controller_connection_id.is_empty()
                        && old.controller_connection_id != session.controller_connection_id
                        && old.control_epoch == session.control_epoch))
            {
                return Err(AppError::BadRequest);
            }
            if sessions.insert(key, session).is_some() {
                return Err(AppError::BadRequest);
            }
        }
        self.sessions = sessions;
        self.issued_at_ms = envelope.issued_at_ms;
        self.expires_at_ms = envelope.expires_at_ms;
        Ok(())
    }
    pub fn session(&self, key: &MediaSessionKey, now: i64) -> Option<&SessionAuthority> {
        if now >= self.expires_at_ms {
            return None;
        }
        self.sessions.get(&(key.host_id.0, key.app_id.0))
    }
    pub fn active_sessions(&self, now: i64) -> impl Iterator<Item = &SessionAuthority> {
        self.sessions
            .values()
            .filter(move |_| now < self.expires_at_ms)
    }
    pub fn admits(&self, key: &MediaSessionKey, peer: &str, now: i64) -> bool {
        self.session(key, now).is_some_and(|s| {
            s.connections
                .iter()
                .any(|c| c.connection_id == peer && c.expires_at_ms > now)
        })
    }
    pub fn controls(&self, key: &MediaSessionKey, peer: &str, now: i64) -> bool {
        self.admits(key, peer, now)
            && self
                .session(key, now)
                .is_some_and(|s| s.controller_connection_id == peer)
    }
}
