//! Receiver-side authority, independent of sender tickets and media traffic.
//! Reuses the session projection's validation and generation rules.
use super::{
    AppError,
    control_state::{ControlState, StateEnvelope},
    host::{AppId, HostId},
    media::MediaSessionKey,
};
use serde::Deserialize;
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
use stream_kit_audio_target::{EndpointPair, admission::Binding, remote::LiveAuthority};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub schema_version: u32,
    pub node_id: String,
    pub instance_id: String,
    pub state: StateEnvelope,
    pub bindings: Vec<Binding>,
}

struct Grant {
    binding: Binding,
    endpoint: EndpointPair,
    expires: Instant,
}

#[derive(Default)]
pub struct Authority {
    node_id: Option<String>,
    state: ControlState,
    grants: HashMap<String, Grant>,
}

impl Authority {
    pub fn apply(
        &mut self,
        envelope: Envelope,
        instance: &str,
        now_ms: i64,
        now: Instant,
    ) -> Result<(), AppError> {
        if envelope.schema_version != 1
            || envelope.instance_id != instance
            || self
                .node_id
                .as_ref()
                .is_some_and(|id| id != &envelope.node_id)
            || envelope.bindings.len() > 64
            || envelope.state.sessions.len() > 64
        {
            return Err(AppError::BadRequest);
        }
        let valid_id = |id: &str| {
            !id.is_empty()
                && id.len() <= 128
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        };
        if !valid_id(&envelope.node_id) {
            return Err(AppError::BadRequest);
        }
        // Prepare all projections before replacing state; a malformed final
        // binding must not apply the earlier bindings or consume the revision.
        let mut grants = HashMap::new();
        for binding in envelope.bindings {
            if binding.target_node_id != envelope.node_id
                || binding.target_instance_id != instance
                || binding.source_node_id == binding.target_node_id
                || !valid_id(&binding.source_node_id)
                || !valid_id(&binding.session_id)
                || !valid_id(&binding.connection_id)
            {
                return Err(AppError::BadRequest);
            }
            let session = envelope
                .state
                .sessions
                .iter()
                .find(|s| {
                    s.session_id == binding.session_id
                        && s.host_id == binding.host_id
                        && s.app_id == binding.app_id
                })
                .ok_or(AppError::BadRequest)?;
            if !session.audio.microphone_enabled
                || session.controller_connection_id != binding.connection_id
                || session.control_epoch != binding.control_epoch
                || session.audio.target.epoch != binding.target_epoch
            {
                return Err(AppError::BadRequest);
            }
            let connection = session
                .connections
                .iter()
                .find(|c| c.connection_id == binding.connection_id)
                .ok_or(AppError::BadRequest)?;
            let remaining = envelope
                .state
                .expires_at_ms
                .min(connection.expires_at_ms)
                .checked_sub(now_ms)
                .filter(|ms| *ms > 0 && *ms <= 17000)
                .ok_or(AppError::BadRequest)?;
            let endpoint = session
                .audio
                .target
                .endpoint()
                .ok_or(AppError::BadRequest)?;
            if let Some(old) = self.grants.get(&binding.session_id)
                && old.binding.source_node_id != binding.source_node_id
                && binding.target_epoch <= old.binding.target_epoch
            {
                return Err(AppError::BadRequest);
            }
            let id = binding.session_id.clone();
            if grants
                .insert(
                    id,
                    Grant {
                        binding,
                        endpoint,
                        expires: now + Duration::from_millis(remaining as u64),
                    },
                )
                .is_some()
            {
                return Err(AppError::BadRequest);
            }
        }
        self.state.apply(envelope.state, now_ms)?;
        self.node_id = Some(envelope.node_id);
        self.grants = grants;
        Ok(())
    }

    /// Call while holding the read lock through device submission. Both clocks
    /// must permit the grant; wall-clock rollback cannot extend its deadline.
    pub fn current(
        &self,
        session_id: &str,
        now_ms: i64,
        now: Instant,
    ) -> Option<(LiveAuthority, EndpointPair)> {
        let grant = self.grants.get(session_id)?;
        let key = MediaSessionKey {
            host_id: HostId(grant.binding.host_id),
            app_id: AppId(grant.binding.app_id),
        };
        if now >= grant.expires
            || !self
                .state
                .controls(&key, &grant.binding.connection_id, now_ms)
        {
            return None;
        }
        Some((
            LiveAuthority {
                binding: grant.binding.clone(),
                expires: grant.expires,
            },
            grant.endpoint.clone(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const NOW: i64 = 1700000000000;
    const INSTANCE: &str = "0123456789abcdef0123456789abcdef";
    fn fixture() -> Envelope {
        serde_json::from_str(include_str!(
            "../../../../contracts/audio-devices/node-state-v1.fixture.json"
        ))
        .expect("node state fixture")
    }

    #[test]
    fn authority_expires_on_both_clocks_and_empty_snapshot_revokes() {
        let now = Instant::now();
        let mut authority = Authority::default();
        authority
            .apply(fixture(), INSTANCE, NOW, now)
            .expect("initial grant");
        let (live, endpoint) = authority
            .current("session-test", NOW, now)
            .expect("authorized session");
        assert_eq!(live.binding.connection_id, "client-a");
        assert_eq!(endpoint.render_device_id, "test-render-not-opened");
        assert!(authority.current("unknown", NOW, now).is_none());
        assert!(
            authority
                .current("session-test", NOW + 10000, now)
                .is_none()
        );
        assert!(
            authority
                .current("session-test", NOW - 5000, now + Duration::from_secs(10))
                .is_none()
        );
        let mut revoked = fixture();
        revoked.state.issued_at_ms += 1;
        revoked.state.sessions.clear();
        revoked.bindings.clear();
        authority
            .apply(revoked, INSTANCE, NOW + 1, now)
            .expect("revocation");
        assert!(authority.current("session-test", NOW + 1, now).is_none());
        assert!(authority.apply(fixture(), INSTANCE, NOW + 2, now).is_err());
    }

    #[test]
    fn invalid_projection_is_atomic_and_does_not_consume_revision() {
        for case in [
            "instance",
            "node",
            "controller",
            "microphone",
            "target",
            "source",
            "epoch",
            "duplicate",
            "connection-expired",
            "rollback",
        ] {
            let now = Instant::now();
            let mut authority = Authority::default();
            authority
                .apply(fixture(), INSTANCE, NOW, now)
                .expect("initial grant");
            let mut next = fixture();
            next.state.issued_at_ms += 1;
            match case {
                "instance" => next.instance_id = "other".into(),
                "node" => next.node_id = "other".into(),
                "controller" => next.bindings[0].connection_id = "client-b".into(),
                "microphone" => next.state.sessions[0].audio.microphone_enabled = false,
                "target" => next.bindings[0].target_node_id = "other".into(),
                "source" => next.bindings[0].source_node_id = "other".into(),
                "epoch" => next.bindings[0].control_epoch += 1,
                "duplicate" => next.bindings.push(next.bindings[0].clone()),
                "connection-expired" => next.state.sessions[0].connections[0].expires_at_ms = NOW,
                "rollback" => next.state.sessions[0].revision -= 1,
                _ => unreachable!(),
            }
            assert!(
                authority.apply(next, INSTANCE, NOW + 1, now).is_err(),
                "{case}"
            );
            assert!(
                authority.current("session-test", NOW + 1, now).is_some(),
                "{case}"
            );
            let mut valid = fixture();
            valid.state.issued_at_ms += 1;
            authority
                .apply(valid, INSTANCE, NOW + 1, now)
                .expect("invalid update must not consume revision");
        }
    }
}
