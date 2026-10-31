//! Remote output routes share the media clock's existing authority boundary.
use super::{
    AppError,
    control_state::{AudioPolicy, TargetMode},
    media::{ControlGrant, MediaSessionKey},
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Instant,
};
use stream_kit_audio_target::{admission::Binding, sender::Sender};

struct Route {
    binding: Binding,
    controller: ControlGrant,
    url: String,
    issued: i64,
    sender: Sender,
}
#[derive(Clone, Default)]
pub struct Routes(Arc<Mutex<HashMap<MediaSessionKey, Route>>>);

pub fn matches(policy: &AudioPolicy, controller: Option<&ControlGrant>, binding: &Binding) -> bool {
    policy.microphone_enabled
        && policy.target.mode == TargetMode::Remote
        && policy.target.node_id == binding.target_node_id
        && policy.target.epoch == binding.target_epoch
        && binding.source_node_id == "primary"
        && controller.is_some_and(|c| c.matches_remote(binding))
}

struct Lifetime(Routes, MediaSessionKey);
impl Drop for Lifetime {
    fn drop(&mut self) {
        self.0.clear(&self.1);
    }
}
impl Routes {
    pub fn lifetime(&self, key: MediaSessionKey) -> impl Drop {
        Lifetime(self.clone(), key)
    }
    pub fn connected(&self, key: &MediaSessionKey, session_id: &str, epoch: u64) -> bool {
        self.0
            .lock()
            .expect("remote routes poisoned")
            .get(key)
            .is_some_and(|route| {
                route.binding.session_id == session_id
                    && route.binding.target_epoch == epoch
                    && !route.sender.is_closed()
            })
    }

    pub fn renew(
        &self,
        key: &MediaSessionKey,
        binding: &Binding,
        controller: &ControlGrant,
        url: &str,
        issued: i64,
        expires: Instant,
    ) -> Result<bool, AppError> {
        let mut routes = self.0.lock().expect("remote routes poisoned");
        if let Some(route) = routes.get_mut(key) {
            if issued <= route.issued {
                return Err(AppError::BadRequest);
            }
            if route.binding == *binding
                && route.controller == *controller
                && route.url == url
                && route.sender.renew(binding, expires)
            {
                route.issued = issued;
                return Ok(true);
            }
        }
        routes.remove(key);
        Ok(false)
    }
    pub fn install(
        &self,
        key: MediaSessionKey,
        binding: Binding,
        controller: ControlGrant,
        url: String,
        issued: i64,
        sender: Sender,
    ) -> Result<(), AppError> {
        let mut routes = self.0.lock().expect("remote routes poisoned");
        routes.retain(|_, route| !route.sender.is_closed());
        if routes.get(&key).is_some_and(|route| route.issued >= issued)
            || (!routes.contains_key(&key) && routes.len() >= 64)
        {
            return Err(AppError::BadRequest);
        }
        routes.insert(
            key,
            Route {
                binding,
                controller,
                url,
                issued,
                sender,
            },
        );
        Ok(())
    }
    pub fn submit(
        &self,
        key: &MediaSessionKey,
        policy: &AudioPolicy,
        controller: Option<&ControlGrant>,
        frame: Option<(&[f32], Instant)>,
    ) {
        let mut routes = self.0.lock().expect("remote routes poisoned");
        if let Some(route) = routes.get(key) {
            if !matches(policy, controller, &route.binding)
                || controller != Some(&route.controller)
                || route.sender.is_closed()
            {
                routes.remove(key);
                return;
            }
            if let Some((samples, captured)) = frame {
                route.sender.submit(&route.binding, samples, captured);
            }
        }
    }
    pub fn clear(&self, key: &MediaSessionKey) {
        self.0.lock().expect("remote routes poisoned").remove(key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::{
        control_state::{StateEnvelope, now_ms},
        host::{AppId, HostId},
        media::MediaSessionRegistry,
    };

    #[tokio::test]
    async fn remote_mode_requires_the_current_attached_controller_and_target_generation() {
        let registry = MediaSessionRegistry::new();
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../contracts/audio-devices/node-state-v1.fixture.json"
        ))
        .expect("fixture");
        let binding: Binding =
            serde_json::from_value(fixture["bindings"][0].clone()).expect("binding");
        let mut state: StateEnvelope =
            serde_json::from_value(fixture["state"].clone()).expect("state");
        let now = now_ms();
        state.issued_at_ms = now;
        state.expires_at_ms = now + 10000;
        for connection in &mut state.sessions[0].connections {
            connection.expires_at_ms = now + 10000;
        }
        state.sessions[0].audio.target.mode = TargetMode::Remote;
        state.sessions[0].audio.target.node_id = binding.target_node_id.clone();
        {
            let mut control = registry.control.write().await;
            control.required = true;
            control.apply(state, now).expect("remote snapshot");
        }
        let key = MediaSessionKey {
            host_id: HostId(binding.host_id),
            app_id: AppId(binding.app_id),
        };
        assert_eq!(
            registry
                .with_runtime(&key, |policy, c| matches(policy, c.as_ref(), &binding))
                .await,
            Some(false)
        );
        registry
            .attach(key.clone(), binding.connection_id.clone())
            .await
            .expect("attach");
        let original = registry
            .with_runtime(&key, |policy, c| {
                assert!(matches(policy, c.as_ref(), &binding));
                c.expect("controller")
            })
            .await
            .expect("session");
        for field in ["node", "target", "controller", "session"] {
            let mut wrong = binding.clone();
            match field {
                "node" => wrong.target_node_id = "another".into(),
                "target" => wrong.target_epoch += 1,
                "controller" => wrong.control_epoch += 1,
                _ => wrong.session_id = "other".into(),
            }
            assert_eq!(
                registry
                    .with_runtime(&key, |policy, c| matches(policy, c.as_ref(), &wrong))
                    .await,
                Some(false)
            );
        }
        registry.detach(&key, &binding.connection_id).await;
        registry
            .attach(key.clone(), binding.connection_id.clone())
            .await
            .expect("reattach");
        let replacement = registry
            .with_runtime(&key, |_, c| c.expect("new attachment"))
            .await
            .expect("session");
        assert_ne!(
            original, replacement,
            "same logical connection must not retain old sender ownership"
        );
    }
}
