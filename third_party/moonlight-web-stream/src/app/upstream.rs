//! A transport belongs to a rendering session, never to an individual browser.
use super::{
    AppError,
    media::{ControlGrant, MediaSessionKey, MediaSessionRegistry},
};
use moonlight_common::stream::{
    HostFeatures,
    audio::{AudioFrame, OpusMultistreamConfig},
    proto::{
        audio::AudioStreamEvent,
        control::{ControlStreamEvent, packet::ControlPacket},
        video::VideoStreamEvent,
    },
    tokio::{MoonlightStream, MoonlightStreamEvent},
    video::VideoSetup,
};
use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, Weak},
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, broadcast, mpsc};

enum Command {
    Recovery,
    Packet(ControlGrant, ControlPacket),
    Microphone(ControlGrant, Instant, Duration, Vec<u8>),
}

struct Shared {
    authority: MediaSessionRegistry,
    key: MediaSessionKey,
    _slot: Arc<SessionSlot>,
    commands: mpsc::Sender<Command>,
    events: broadcast::Sender<Arc<MoonlightStreamEvent>>,
    audio: OpusMultistreamConfig,
    video: VideoSetup,
    features: HostFeatures,
    target: Option<stream_kit_audio_target::TargetMonitor>,
    remote_microphone: bool,
}

#[derive(Default)]
struct SessionSlot {
    launch: Arc<Mutex<()>>,
    current: std::sync::Mutex<Weak<Shared>>,
    // Keep the join handle in the slot while awaiting it: cancellation of a
    // reconnect must not detach cleanup and allow a second driver to start.
    driver: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

struct LaunchLease {
    _permit: tokio::sync::OwnedMutexGuard<()>,
    _slot: Arc<SessionSlot>,
}

// Field order is intentional: a cancelled blocking open destroys the resource
// before releasing launch ownership and the pool index entry.
struct PreparedResource<T> {
    resource: T,
    lease: LaunchLease,
}

// Browser handles hold telemetry only. Native resources belong exclusively to
// the driver; even panic/cancellation drops them before the index lifetime.
struct DriverResources {
    target: Option<stream_kit_audio_target::AudioTarget>,
    stream: MoonlightStream,
    _slot: Arc<SessionSlot>,
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

// An ingress task may enqueue authorized microphone data, but must not keep
// the shared upstream or native audio device alive after its viewer leaves.
pub struct MicrophoneSender {
    peer_id: String,
    shared: Weak<Shared>,
}

impl MicrophoneSender {
    pub async fn send_opus(&self, timestamp: Duration, bytes: &[u8]) -> bool {
        let arrived = Instant::now();
        let Some(shared) = self.shared.upgrade() else {
            return false;
        };
        shared
            .authority
            .with_microphone(&shared.key, &self.peer_id, |_, grant| {
                shared
                    .commands
                    .try_reserve()
                    .map(|permit| {
                        permit.send(Command::Microphone(
                            grant,
                            arrived,
                            timestamp,
                            bytes.to_vec(),
                        ))
                    })
                    .is_ok()
            })
            .await
            .unwrap_or(false)
    }
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
                    Some(status) if !status.device_open && status.error.is_some() => {
                        TargetState::DeviceFailed
                    }
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
        let mut lease = LaunchLease {
            _permit: slot.launch.clone().lock_owned().await,
            _slot: slot.clone(),
        };
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
        let mut previous_driver = slot.driver.lock().await;
        if let Some(driver) = previous_driver.as_mut()
            && let Err(error) = driver.await
        {
            tracing::warn!(%error, "previous shared upstream driver failed");
        }
        *previous_driver = None;
        let target = if let Some(route) = self
            .local_targets
            .iter()
            .find(|route| route.host_id == key.host_id.0 && route.app_id == key.app_id.0)
        {
            let endpoint = route.endpoint.clone();
            let prepared = tokio::task::spawn_blocking(move || PreparedResource {
                resource: stream_kit_audio_target::AudioTarget::open(&endpoint),
                lease,
            })
            .await
            .map_err(|_| AppError::AudioTargetUnavailable)?;
            lease = prepared.lease;
            let opened = prepared.resource;
            Some(opened.map_err(|error| {
                tracing::error!(%error, host_id = key.host_id.0, app_id = key.app_id.0, "configured audio target is unavailable");
                AppError::AudioTargetUnavailable
            })?)
        } else {
            None
        };
        let stream = start().await?;
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
        let mut microphone_peer: Option<ControlGrant> = None;
        let mut input = super::input::InputRuntime::default();
        let (commands, mut receiver) = mpsc::channel(256);
        let (events, _) = broadcast::channel(256);
        let mut features = stream.host_features();
        // The gateway's session bus accepts microphone independently of the
        // upstream host's Foundation extension. Target delivery is separate.
        features.microphone = true;
        let shared = Arc::new(Shared {
            authority: authority.clone(),
            key: key.clone(),
            _slot: slot.clone(),
            commands,
            events: events.clone(),
            // The session bus emits 20 ms stereo packets independently of the host.
            audio: OpusMultistreamConfig::STEREO,
            video: stream.video_setup(),
            features,
            target: target.as_ref().map(|target| target.monitor()),
            remote_microphone,
        });
        let peer = UpstreamPeer {
            peer_id,
            events: events.subscribe(),
            shared: shared.clone(),
        };
        *slot.current.lock().expect("session slot mutex poisoned") = Arc::downgrade(&shared);
        let resources = DriverResources {
            target,
            stream,
            _slot: slot.clone(),
        };
        *previous_driver = Some(tokio::spawn(async move {
            // Keep the index entry alive through actual resource destruction,
            // including after the last browser has dropped its Shared handle.
            let mut resources = resources;
            let mut audio_clock = super::mixer::AudioClock::new();
            let mut target_fault_reported = false;
            loop {
                if events.receiver_count() == 0 {
                    break;
                }
                tokio::select! {
                    timestamp = audio_clock.tick() => {
                        let result = authority.with_runtime(&key, |policy, controller| {
                            for packet in input.reconcile(controller.clone()) {
                                resources.stream.send_raw(packet).map_err(|e| e.to_string())?;
                            }
                            mixer.configure(policy).map_err(|e| e.to_string())?;
                            if microphone_peer != controller {
                                mixer.clear_microphone().map_err(|e| e.to_string())?;
                                if let Some(target) = &resources.target { target.clear(); }
                                microphone_peer = controller;
                            }
                            if !policy.microphone_enabled && let Some(target) = &resources.target {
                                target.clear();
                            }
                            let buffer = mixer.render(timestamp, Instant::now()).map_err(|e| e.to_string())?.into();
                            if let Some(target) = &resources.target {
                                target.submit(mixer.target_pcm());
                                if !target_fault_reported && !target.status().device_open {
                                    tracing::error!(target = ?target.status(), "microphone target failed during session");
                                    target_fault_reported = true;
                                }
                            }
                            let _ = events.send(Arc::new(MoonlightStreamEvent::Audio(AudioStreamEvent::OnFrame(AudioFrame { timestamp, buffer }))));
                            Ok::<_, String>(())
                        }).await;
                        match result {
                            Some(Ok(())) => {},
                            Some(Err(error)) => { tracing::warn!(%error, "session audio rendering failed"); break; },
                            None => {
                                if input.reconcile(None).into_iter().any(|p| resources.stream.send_raw(p).is_err()) { break; }
                                let _ = mixer.clear_microphone(); microphone_peer = None;
                                if let Some(target) = &resources.target { target.clear(); }
                            },
                        }
                    },
                    command = receiver.recv() => match command {
                        Some(Command::Recovery) => {
                            if resources.stream.send_raw(ControlPacket::RequestIdr).is_err() { break; }
                        }
                        Some(Command::Packet(grant, packet)) => {
                            let result = authority.with_controller(&key, &grant.peer_id, |current| {
                                if current != grant { return Ok(()); }
                                let mut packets = input.reconcile(Some(current));
                                packets.extend(input.accept(packet));
                                for packet in packets { resources.stream.send_raw(packet)?; }
                                Ok::<_, moonlight_common::error::Error>(())
                            }).await;
                            if matches!(result, Some(Err(_))) { break; }
                        }
                        Some(Command::Microphone(grant, arrived, timestamp, bytes)) => {
                            authority.with_microphone(&key, &grant.peer_id, |policy, current| {
                                // Age is measured at ingress, never at queue consumption.
                                if current != grant || arrived.elapsed() >= Duration::from_millis(60) { return; }
                                if let Err(error) = mixer.configure(policy) {
                                    tracing::warn!(%error, "cannot apply microphone policy");
                                    return;
                                }
                                if microphone_peer.as_ref() != Some(&current) {
                                    if let Err(error) = mixer.clear_microphone() {
                                        tracing::warn!(%error, "cannot clear previous microphone");
                                        return;
                                    }
                                    if let Some(target) = &resources.target { target.clear(); }
                                    microphone_peer = Some(current);
                                }
                                if let Err(error) = mixer.microphone(&bytes, arrived) {
                                    tracing::warn!(%error, "invalid microphone Opus packet");
                                    return;
                                }
                                if resources.target.is_none() && remote_microphone {
                                    resources.stream.send_microphone_opus_data(timestamp, &bytes);
                                }
                            }).await;
                        }
                        None => break,
                    },
                    result = resources.stream.drive() => match result {
                        Ok(MoonlightStreamEvent::Audio(AudioStreamEvent::OnFrame(frame))) => {
                            if let Err(error) = mixer.program(&frame.buffer, std::time::Instant::now()) {
                                tracing::warn!(%error, "dropping invalid program audio packet");
                            }
                        }
                        Ok(MoonlightStreamEvent::Video(VideoStreamEvent::SignalIdr)) => {
                            let _ = resources.stream.send_raw(ControlPacket::RequestIdr);
                        }
                        Ok(event @ MoonlightStreamEvent::Control(ControlStreamEvent::Disconnect)) => {
                            let _ = events.send(Arc::new(event));
                            break;
                        }
                        Ok(event) => { let _ = events.send(Arc::new(event)); }
                        Err(error) => { tracing::warn!(%error, "shared upstream ended"); break; }
                    }
                }
            }
            receiver.close();
            for packet in input.reconcile(None) {
                if let Err(error) = resources.stream.send_raw(packet) {
                    tracing::debug!(%error, "input cleanup ended with transport error");
                }
            }
            if let Some(target) = &resources.target {
                target.clear();
            }
            // Stop native output before waiting for the remote disconnect ack.
            drop(resources.target.take());
            match tokio::time::timeout(Duration::from_secs(1), resources.stream.shutdown()).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    tracing::debug!(%error, "upstream disconnect ended with transport error")
                }
                Err(_) => tracing::warn!("upstream disconnect timed out; closing local transport"),
            }
            drop(resources);
        }));
        drop(lease);
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
    pub async fn send_raw(&mut self, packet: ControlPacket) -> Result<(), AppError> {
        if matches!(packet, ControlPacket::RequestIdr) {
            return self
                .shared
                .commands
                .try_send(Command::Recovery)
                .map_err(|_| AppError::StreamClosed);
        }
        self.shared
            .authority
            .with_controller(&self.shared.key, &self.peer_id, |grant| {
                self.shared
                    .commands
                    .try_send(Command::Packet(grant, packet))
                    .map_err(|_| AppError::StreamClosed)
            })
            .await
            .unwrap_or(Err(AppError::Forbidden))
    }
    pub fn microphone_sender(&self) -> MicrophoneSender {
        MicrophoneSender {
            peer_id: self.peer_id.clone(),
            shared: Arc::downgrade(&self.shared),
        }
    }
    pub async fn drive(&mut self) -> Result<Arc<MoonlightStreamEvent>, AppError> {
        loop {
            tokio::select! {
                _ = self.shared.commands.closed() => return Err(AppError::StreamClosed),
                event = self.events.recv() => match event {
                    Ok(event) => return Ok(event),
                    Err(broadcast::error::RecvError::Lagged(_)) => { self.send_raw(ControlPacket::RequestIdr).await?; }
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
    use std::sync::atomic::{AtomicBool, Ordering};

    struct LiveResource(Arc<AtomicBool>);
    impl Drop for LiveResource {
        fn drop(&mut self) {
            self.0.store(false, Ordering::Release);
        }
    }

    #[tokio::test]
    async fn cancelled_reconnect_preserves_cleanup_join_and_exclusive_launch() {
        let pool = Arc::new(UpstreamPool::default());
        let key = MediaSessionKey {
            host_id: HostId(1),
            app_id: AppId(2),
        };
        let slot = Arc::new(SessionSlot::default());
        pool.sessions
            .lock()
            .await
            .insert(key.clone(), Arc::downgrade(&slot));
        let alive = Arc::new(AtomicBool::new(true));
        let (release, cleanup) = tokio::sync::oneshot::channel();
        let old_slot = slot.clone();
        let resource = LiveResource(alive.clone());
        *slot.driver.lock().await = Some(tokio::spawn(async move {
            let _slot_lifetime = old_slot;
            let _resource = resource;
            cleanup.await.expect("release old transport cleanup");
        }));
        let task_pool = pool.clone();
        let task_key = key.clone();
        let cancelled = tokio::spawn(async move {
            task_pool
                .connect(
                    task_key,
                    MediaSessionRegistry::new(),
                    "cancelled".into(),
                    || async { panic!("new launch preceded old cleanup") },
                )
                .await
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while slot.driver.try_lock().is_ok() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("reconnect must start waiting on driver");
        cancelled.abort();
        assert!(matches!(cancelled.await, Err(error) if error.is_cancelled()));
        assert!(
            slot.driver.lock().await.is_some(),
            "cancelled waiter lost the cleanup handle"
        );

        let started = Arc::new(AtomicBool::new(false));
        let new_started = started.clone();
        let mut next = std::pin::pin!(pool.connect(
            key,
            MediaSessionRegistry::new(),
            "retry".into(),
            || async {
                assert!(
                    !alive.load(Ordering::Acquire),
                    "two native transports overlapped"
                );
                new_started.store(true, Ordering::Release);
                Err(AppError::StreamClosed)
            }
        ));
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut next)
                .await
                .is_err()
        );
        assert!(!started.load(Ordering::Acquire));
        release.send(()).expect("finish old cleanup");
        assert!(next.await.is_err());
        assert!(started.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn cancelled_blocking_open_retains_slot_and_permit_until_resource_drop() {
        let slot = Arc::new(SessionSlot::default());
        let weak = Arc::downgrade(&slot);
        let lease = LaunchLease {
            _permit: slot.launch.clone().lock_owned().await,
            _slot: slot.clone(),
        };
        let alive = Arc::new(AtomicBool::new(true));
        let resource = LiveResource(alive.clone());
        let (entered, entered_rx) = tokio::sync::oneshot::channel();
        let (release, opening) = std::sync::mpsc::channel();
        let waiter = tokio::spawn(async move {
            tokio::task::spawn_blocking(move || {
                entered.send(()).expect("signal blocking open started");
                opening
                    .recv_timeout(Duration::from_secs(2))
                    .expect("release blocking open");
                PreparedResource { resource, lease }
            })
            .await
            .expect("blocking open task")
        });
        entered_rx.await.expect("blocking open entered");
        waiter.abort();
        // Awaiting the cancelled wrapper drops its detached result receiver.
        assert!(waiter.await.is_err());
        drop(slot);
        assert!(
            weak.upgrade()
                .expect("in-flight open must retain index")
                .launch
                .try_lock()
                .is_err()
        );
        release.send(()).expect("finish blocking open");
        tokio::time::timeout(Duration::from_secs(1), async {
            while weak.upgrade().is_some() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("cancelled open must eventually release index");
        assert!(
            !alive.load(Ordering::Acquire),
            "index released before native resource"
        );
    }

    fn observed_session() -> super::super::control_state::SessionAuthority {
        let mut state: super::super::control_state::StateEnvelope = serde_json::from_str(
            include_str!("../../../../contracts/media-state/v2.fixture.json"),
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
        let authority = MediaSessionRegistry::new();
        let (commands, mut receiver) = mpsc::channel(256);
        let (events, _) = broadcast::channel(256);
        let slot = Arc::new(SessionSlot::default());
        let shared = Arc::new(Shared {
            authority: authority.clone(),
            key: key.clone(),
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
            .await
            .expect("upstream test setup or assertion failed");
        assert!(matches!(receiver.recv().await, Some(Command::Recovery)));
        let microphone = second.microphone_sender();
        let key = second.shared.key.clone();
        authority
            .attach(key.clone(), "second".into())
            .await
            .expect("attach speaker");
        authority
            .attach(key.clone(), "other".into())
            .await
            .expect("attach viewer");
        assert!(!microphone.send_opus(Duration::ZERO, b"viewer").await);
        assert!(
            receiver.try_recv().is_err(),
            "viewer must not enter the command queue"
        );
        authority
            .claim_controller(&key, "second", false)
            .await
            .expect("grant speaker");
        assert!(microphone.send_opus(Duration::ZERO, b"controller").await);
        let Some(Command::Microphone(before, _, _, _)) = receiver.recv().await else {
            panic!("authorized microphone command missing");
        };
        authority
            .claim_controller(&key, "other", true)
            .await
            .expect("transfer away");
        assert!(!microphone.send_opus(Duration::ZERO, b"revoked").await);
        authority
            .claim_controller(&key, "second", true)
            .await
            .expect("transfer back");
        assert!(
            microphone
                .send_opus(Duration::ZERO, b"new generation")
                .await
        );
        let Some(Command::Microphone(after, _, _, _)) = receiver.recv().await else {
            panic!("new microphone command missing");
        };
        assert_ne!(
            before, after,
            "queued packets retain their original control generation"
        );
        for _ in 0..256 {
            assert!(microphone.send_opus(Duration::ZERO, b"bounded").await);
        }
        assert!(!microphone.send_opus(Duration::ZERO, b"overflow").await);
        while receiver.try_recv().is_ok() {}
        drop(second);
        assert!(!microphone.send_opus(Duration::ZERO, b"closed").await);
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
