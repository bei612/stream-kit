//! A transport belongs to a rendering session, never to an individual browser.
use super::{
    AppError,
    media::{MediaSessionKey, MediaSessionRegistry},
};
use moonlight_common::stream::{
    HostFeatures,
    audio::{AudioFrame, OpusMultistreamConfig},
    proto::{audio::AudioStreamEvent, control::packet::ControlPacket, video::VideoStreamEvent},
    tokio::{MoonlightStream, MoonlightStreamEvent},
    video::VideoSetup,
};
use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, Weak},
    time::Duration,
};
use tokio::sync::{Mutex, broadcast, mpsc};

enum Command {
    Packet(String, ControlPacket),
    Microphone(String, Duration, Vec<u8>),
}

struct Shared {
    _slot: Arc<SessionSlot>,
    commands: mpsc::Sender<Command>,
    events: broadcast::Sender<Arc<MoonlightStreamEvent>>,
    audio: OpusMultistreamConfig,
    video: VideoSetup,
    features: HostFeatures,
    target: Option<Arc<stream_kit_audio_target::AudioTarget>>,
    remote_microphone: bool,
}

#[derive(Default)]
struct SessionSlot {
    launch: Mutex<()>,
    current: std::sync::Mutex<Weak<Shared>>,
}

#[derive(Default)]
pub struct UpstreamPool {
    sessions: Mutex<HashMap<MediaSessionKey, Weak<SessionSlot>>>,
    local_targets: Vec<crate::config::LocalAudioTarget>,
}

pub struct UpstreamPeer {
    peer_id: String,
    shared: Arc<Shared>,
    events: broadcast::Receiver<Arc<MoonlightStreamEvent>>,
}

impl UpstreamPool {
    pub async fn observe(
        &self,
        sessions: &[super::control_state::SessionAuthority],
    ) -> Vec<super::media_observation::SessionObservation> {
        use super::media_observation::{SessionObservation, TargetObservation, TargetState};
        let index = self.sessions.lock().await;
        sessions
            .iter()
            .map(|session| {
                let key = MediaSessionKey {
                    host_id: super::host::HostId(session.host_id),
                    app_id: super::host::AppId(session.app_id),
                };
                let shared = index.get(&key).and_then(Weak::upgrade).and_then(|slot| {
                    slot.current
                        .lock()
                        .expect("session slot mutex poisoned")
                        .upgrade()
                });
                let active = shared.as_ref().is_some_and(|s| !s.commands.is_closed());
                let configured = self.local_targets.iter().any(|route| {
                    route.host_id == session.host_id && route.app_id == session.app_id
                });
                let device = shared
                    .as_ref()
                    .and_then(|s| s.target.as_ref().map(|t| t.status()));
                let state = match &device {
                    Some(status) if !status.device_open => TargetState::DeviceFailed,
                    Some(_) if active => TargetState::DeviceOpen,
                    _ if configured => TargetState::Idle,
                    _ if active && shared.as_ref().is_some_and(|s| s.remote_microphone) => {
                        TargetState::UpstreamTransport
                    }
                    _ => TargetState::Unconfigured,
                };
                SessionObservation {
                    session_id: session.session_id.clone(),
                    revision: session.revision,
                    upstream_active: active,
                    subscribers: shared.as_ref().map_or(0, |s| s.events.receiver_count()),
                    microphone_target: TargetObservation { state, device },
                }
            })
            .collect()
    }

    pub fn new(local_targets: Vec<crate::config::LocalAudioTarget>) -> Self {
        Self {
            local_targets,
            ..Default::default()
        }
    }
    pub async fn connect<F, Fut>(
        &self,
        key: MediaSessionKey,
        authority: MediaSessionRegistry,
        peer_id: String,
        start: F,
    ) -> Result<UpstreamPeer, AppError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<MoonlightStream, AppError>>,
    {
        // Serialize only this application's launch. Network/device startup must
        // never hold the pool index lock or block control-plane observations.
        let slot = {
            let mut sessions = self.sessions.lock().await;
            sessions.retain(|_, entry| entry.strong_count() > 0);
            match sessions.get(&key).and_then(Weak::upgrade) {
                Some(slot) => slot,
                None => {
                    let slot = Arc::new(SessionSlot::default());
                    sessions.insert(key.clone(), Arc::downgrade(&slot));
                    slot
                }
            }
        };
        let _launch = slot.launch.lock().await;
        if let Some(shared) = slot
            .current
            .lock()
            .expect("session slot mutex poisoned")
            .upgrade()
            && !shared.commands.is_closed()
        {
            return Ok(UpstreamPeer {
                peer_id,
                events: shared.events.subscribe(),
                shared,
            });
        }
        let target = if let Some(route) = self
            .local_targets
            .iter()
            .find(|route| route.host_id == key.host_id.0 && route.app_id == key.app_id.0)
        {
            let endpoint = route.endpoint.clone();
            let opened = tokio::task::spawn_blocking(move || {
                stream_kit_audio_target::AudioTarget::open(&endpoint)
            })
            .await
            .map_err(|_| AppError::AudioTargetUnavailable)?;
            Some(Arc::new(opened.map_err(|error| {
                tracing::error!(%error, host_id = key.host_id.0, app_id = key.app_id.0, "configured audio target is unavailable");
                AppError::AudioTargetUnavailable
            })?))
        } else {
            None
        };
        let mut stream = start().await?;
        let remote_microphone = stream.host_features().microphone;
        let setup = stream.audio_setup();
        if setup.sample_rate != 48_000
            || setup.channel_count != 2
            || setup.streams != 1
            || setup.coupled_streams != 1
            || setup.mapping[..2] != [0, 1]
        {
            return Err(AppError::WebRtcClientCodecNotSupported);
        }
        let mut mixer = super::mixer::AudioMixer::new().map_err(|error| {
            tracing::error!(%error, "cannot initialize session mixer");
            AppError::StreamClosed
        })?;
        let mut microphone_peer: Option<String> = None;
        let (commands, mut receiver) = mpsc::channel(256);
        let (events, _) = broadcast::channel(256);
        let mut features = stream.host_features();
        // The gateway's session bus accepts microphone independently of the
        // upstream host's Foundation extension. Target delivery is separate.
        features.microphone = true;
        let shared = Arc::new(Shared {
            _slot: slot.clone(),
            commands,
            events: events.clone(),
            // The session bus emits 20 ms stereo packets independently of the host.
            audio: OpusMultistreamConfig::STEREO,
            video: stream.video_setup(),
            features,
            target: target.clone(),
            remote_microphone,
        });
        let peer = UpstreamPeer {
            peer_id,
            events: events.subscribe(),
            shared: shared.clone(),
        };
        *slot.current.lock().expect("session slot mutex poisoned") = Arc::downgrade(&shared);
        tokio::spawn(async move {
            let mut audio_clock = super::mixer::AudioClock::new();
            let mut target_fault_reported = false;
            loop {
                tokio::select! {
                    timestamp = audio_clock.tick() => {
                        let result = authority.with_audio_output(&key, |policy, controller| {
                            mixer.configure(policy)?;
                            if microphone_peer.as_deref() != controller {
                                mixer.clear_microphone()?;
                                if let Some(target) = &target { target.clear(); }
                                microphone_peer = controller.map(str::to_owned);
                            }
                            if !policy.microphone_enabled && let Some(target) = &target {
                                target.clear();
                            }
                            let buffer = mixer.render(timestamp, std::time::Instant::now())?.into();
                            if let Some(target) = &target {
                                target.submit(mixer.target_pcm());
                                if !target_fault_reported && !target.status().device_open {
                                    tracing::error!(target = ?target.status(), "microphone target failed during session");
                                    target_fault_reported = true;
                                }
                            }
                            let _ = events.send(Arc::new(MoonlightStreamEvent::Audio(AudioStreamEvent::OnFrame(AudioFrame { timestamp, buffer }))));
                            Ok::<_, opus::Error>(())
                        }).await;
                        match result {
                            Some(Ok(())) => {},
                            Some(Err(error)) => { tracing::warn!(%error, "session audio rendering failed"); break; },
                            None => {
                                let _ = mixer.clear_microphone(); microphone_peer = None;
                                if let Some(target) = &target { target.clear(); }
                            },
                        }
                    },
                    command = receiver.recv() => match command {
                        Some(Command::Packet(peer_id, packet)) => {
                            // Viewers may request decoder recovery but cannot send input.
                            let result = if matches!(packet, ControlPacket::RequestIdr) {
                                Some(stream.send_raw(packet))
                            } else {
                                authority.with_controller(&key, &peer_id, || stream.send_raw(packet)).await
                            };
                            if matches!(result, Some(Err(_))) { break; }
                        }
                        Some(Command::Microphone(peer_id, timestamp, bytes)) => {
                            authority.with_microphone(&key, &peer_id, |policy| {
                                if let Err(error) = mixer.configure(policy) {
                                    tracing::warn!(%error, "cannot apply microphone policy");
                                    return;
                                }
                                if microphone_peer.as_deref() != Some(&peer_id) {
                                    if let Err(error) = mixer.clear_microphone() {
                                        tracing::warn!(%error, "cannot clear previous microphone");
                                        return;
                                    }
                                    if let Some(target) = &target { target.clear(); }
                                    microphone_peer = Some(peer_id.clone());
                                }
                                if let Err(error) = mixer.microphone(&bytes, std::time::Instant::now()) {
                                    tracing::warn!(%error, "invalid microphone Opus packet");
                                    return;
                                }
                                if target.is_none() && remote_microphone {
                                    stream.send_microphone_opus_data(timestamp, &bytes);
                                }
                            }).await;
                        }
                        None => { let _ = stream.disconnect(); break; }
                    },
                    result = stream.drive() => match result {
                        Ok(MoonlightStreamEvent::Audio(AudioStreamEvent::OnFrame(frame))) => {
                            if let Err(error) = mixer.program(&frame.buffer, std::time::Instant::now()) {
                                tracing::warn!(%error, "dropping invalid program audio packet");
                            }
                        }
                        Ok(MoonlightStreamEvent::Video(VideoStreamEvent::SignalIdr)) => {
                            let _ = stream.send_raw(ControlPacket::RequestIdr);
                        }
                        Ok(event) => { let _ = events.send(Arc::new(event)); }
                        Err(error) => { tracing::warn!(%error, "shared upstream ended"); break; }
                    }
                }
            }
        });
        Ok(peer)
    }
}

impl UpstreamPeer {
    pub fn target_status(&self) -> Option<stream_kit_audio_target::TargetStatus> {
        self.shared.target.as_ref().map(|target| target.status())
    }
    pub fn audio_setup(&self) -> OpusMultistreamConfig {
        self.shared.audio.clone()
    }
    pub fn video_setup(&self) -> VideoSetup {
        self.shared.video
    }
    pub fn host_features(&self) -> HostFeatures {
        self.shared.features.clone()
    }
    pub fn is_alive(&self) -> bool {
        !self.shared.commands.is_closed()
    }
    pub fn send_raw(&mut self, packet: ControlPacket) -> Result<(), AppError> {
        self.shared
            .commands
            .try_send(Command::Packet(self.peer_id.clone(), packet))
            .map_err(|_| AppError::StreamClosed)
    }
    pub fn send_microphone_opus_data(&mut self, timestamp: Duration, bytes: &[u8]) -> bool {
        self.shared
            .commands
            .try_send(Command::Microphone(
                self.peer_id.clone(),
                timestamp,
                bytes.to_vec(),
            ))
            .is_ok()
    }
    pub async fn drive(&mut self) -> Result<Arc<MoonlightStreamEvent>, AppError> {
        loop {
            tokio::select! {
                _ = self.shared.commands.closed() => return Err(AppError::StreamClosed),
                event = self.events.recv() => match event {
                    Ok(event) => return Ok(event),
                    Err(broadcast::error::RecvError::Lagged(_)) => { self.send_raw(ControlPacket::RequestIdr)?; }
                    Err(broadcast::error::RecvError::Closed) => return Err(AppError::StreamClosed),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::host::{AppId, HostId};
    use moonlight_common::stream::video::VideoFormat;

    fn observed_session() -> super::super::control_state::SessionAuthority {
        let mut state: super::super::control_state::StateEnvelope = serde_json::from_str(
            include_str!("../../../../contracts/media-state/v1.fixture.json"),
        )
        .expect("upstream test setup or assertion failed");
        let mut session = state.sessions.remove(0);
        session.host_id = 1;
        session.app_id = 2;
        session
    }

    #[tokio::test]
    async fn slow_launch_does_not_block_other_applications_or_observation() {
        let pool = Arc::new(UpstreamPool::default());
        let (entered, waiting) = tokio::sync::oneshot::channel();
        let task_pool = pool.clone();
        let first = tokio::spawn(async move {
            task_pool
                .connect(
                    MediaSessionKey {
                        host_id: HostId(1),
                        app_id: AppId(2),
                    },
                    MediaSessionRegistry::new(),
                    "first".into(),
                    || async {
                        let _ = entered.send(());
                        std::future::pending().await
                    },
                )
                .await
        });
        waiting
            .await
            .expect("upstream test setup or assertion failed");
        let work = async {
            let snapshot = pool.observe(&[observed_session()]).await;
            assert!(!snapshot[0].upstream_active);
            assert_eq!(
                snapshot[0].microphone_target.state,
                super::super::media_observation::TargetState::Unconfigured
            );
            assert!(
                pool.connect(
                    MediaSessionKey {
                        host_id: HostId(1),
                        app_id: AppId(3)
                    },
                    MediaSessionRegistry::new(),
                    "second".into(),
                    || async { Err(AppError::StreamClosed) }
                )
                .await
                .is_err()
            );
        };
        tokio::time::timeout(Duration::from_secs(1), work)
            .await
            .expect("upstream test setup or assertion failed");
        first.abort();
        let _ = first.await;
        assert!(
            pool.connect(
                MediaSessionKey {
                    host_id: HostId(1),
                    app_id: AppId(2)
                },
                MediaSessionRegistry::new(),
                "retry".into(),
                || async { Err(AppError::StreamClosed) }
            )
            .await
            .is_err()
        );
    }

    #[tokio::test]
    async fn subscribers_reuse_transport_until_last_peer_leaves() {
        let pool = UpstreamPool::default();
        let key = MediaSessionKey {
            host_id: HostId(1),
            app_id: AppId(2),
        };
        let (commands, mut receiver) = mpsc::channel(256);
        let (events, _) = broadcast::channel(256);
        let slot = Arc::new(SessionSlot::default());
        let shared = Arc::new(Shared {
            _slot: slot.clone(),
            commands,
            events,
            audio: OpusMultistreamConfig::STEREO,
            video: VideoSetup {
                format: VideoFormat::H264,
                width: 1280,
                height: 720,
                redraw_rate: 60,
            },
            features: HostFeatures::default(),
            target: None,
            remote_microphone: false,
        });
        *slot
            .current
            .lock()
            .expect("upstream test setup or assertion failed") = Arc::downgrade(&shared);
        pool.sessions
            .lock()
            .await
            .insert(key.clone(), Arc::downgrade(&slot));
        let first = pool
            .connect(
                key.clone(),
                MediaSessionRegistry::new(),
                "first".into(),
                || async { panic!("must reuse existing upstream") },
            )
            .await
            .expect("upstream test setup or assertion failed");
        let mut second = pool
            .connect(
                key,
                MediaSessionRegistry::new(),
                "second".into(),
                || async { panic!("must reuse existing upstream") },
            )
            .await
            .expect("upstream test setup or assertion failed");
        drop(shared);
        drop(first);
        assert!(second.is_alive());
        let snapshot = pool.observe(&[observed_session()]).await;
        assert!(snapshot[0].upstream_active);
        assert_eq!(snapshot[0].subscribers, 1);
        // Gateway microphone capture capability does not imply target support.
        assert_eq!(
            snapshot[0].microphone_target.state,
            super::super::media_observation::TargetState::Unconfigured
        );
        second
            .send_raw(ControlPacket::RequestIdr)
            .expect("upstream test setup or assertion failed");
        assert!(matches!(
            receiver.recv().await,
            Some(Command::Packet(_, ControlPacket::RequestIdr))
        ));
        drop(second);
        assert!(
            receiver.recv().await.is_none(),
            "last peer must release upstream driver"
        );
        assert!(!pool.observe(&[observed_session()]).await[0].upstream_active);
    }

    #[tokio::test]
    async fn failed_launch_does_not_poison_pool() {
        let pool = UpstreamPool::default();
        let key = MediaSessionKey {
            host_id: HostId(1),
            app_id: AppId(2),
        };
        for _ in 0..2 {
            assert!(
                pool.connect(
                    key.clone(),
                    MediaSessionRegistry::new(),
                    "first".into(),
                    || async { Err(AppError::StreamClosed) }
                )
                .await
                .is_err()
            );
        }
        assert!(
            pool.sessions
                .lock()
                .await
                .values()
                .all(|slot| slot.upgrade().is_none())
        );
    }
    #[tokio::test]
    async fn invalid_target_fails_before_launch_without_default_device_fallback() {
        let pool = UpstreamPool::new(vec![crate::config::LocalAudioTarget {
            host_id: 1,
            app_id: 2,
            endpoint: stream_kit_audio_target::EndpointPair {
                render_device_id: "invalid".into(),
                capture_device_id: "invalid".into(),
            },
        }]);
        let result = pool
            .connect(
                MediaSessionKey {
                    host_id: HostId(1),
                    app_id: AppId(2),
                },
                MediaSessionRegistry::new(),
                "a".into(),
                || async { panic!("must not launch with invalid target") },
            )
            .await;
        assert!(matches!(result, Err(AppError::AudioTargetUnavailable)));
        assert!(
            pool.sessions
                .lock()
                .await
                .values()
                .all(|slot| slot.upgrade().is_none())
        );
    }
}
