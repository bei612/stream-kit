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
mod recovery;
mod target;

enum Command {
    Packet(ControlGrant, ControlPacket),
    Microphone(ControlGrant, Instant, Duration, Vec<u8>),
}

struct Shared {
    authority: MediaSessionRegistry,
    key: MediaSessionKey,
    _slot: Arc<SessionSlot>,
    commands: mpsc::Sender<Command>,
    recovery: recovery::Requests,
    events: broadcast::Sender<Arc<MoonlightStreamEvent>>,
    audio: OpusMultistreamConfig,
    video: VideoSetup,
    features: HostFeatures,
    target: Option<target::Monitor>,
    remote_microphone: bool,
}

#[derive(Default)]
struct SessionSlot {
    launch: Arc<Mutex<()>>,
    native: Arc<Mutex<()>>,
    current: std::sync::Mutex<Weak<Shared>>,
    // Keep the join handle in the slot while awaiting it: cancellation of a
    // reconnect must not detach cleanup and allow a second driver to start.
    driver: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

struct LaunchLease {
    _permit: tokio::sync::OwnedMutexGuard<()>,
    _slot: Arc<SessionSlot>,
}

// Browser handles hold telemetry only. Native resources belong exclusively to
// the driver; even panic/cancellation drops them before the index lifetime.
struct DriverResources {
    target: Option<target::Runtime>,
    stream: MoonlightStream,
    _slot: Arc<SessionSlot>,
}

#[derive(Default)]
pub struct UpstreamPool {
    sessions: Mutex<HashMap<MediaSessionKey, Weak<SessionSlot>>>,
    local_targets: Vec<crate::config::LocalAudioTarget>,
    endpoints: target::EndpointRegistry,
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

// Desired configuration and runtime resources are distinct. In particular,
// absence of an error string is never evidence that a device remains open.
fn observe_target(
    target: &super::control_state::AudioTarget,
    active: bool,
    remote_microphone: bool,
    snapshot: Option<&target::Snapshot>,
) -> super::media_observation::TargetObservation {
    use super::{
        control_state::TargetMode,
        media_observation::{TargetObservation, TargetState},
    };
    let matching = snapshot.filter(|s| active && s.epoch == target.epoch && !s.pending);
    let device = matching.and_then(|s| s.device.clone());
    let mut error = matching
        .and_then(|s| s.error.clone())
        .or_else(|| device.as_ref().and_then(|s| s.error.clone()));
    if matching.is_some() && target.mode == TargetMode::Local && device.is_none() && error.is_none()
    {
        error = Some("configured local audio target is unavailable".into());
    }
    let state = match &device {
        _ if !active => TargetState::Idle,
        _ if matching.is_none() => TargetState::Pending,
        _ if error.is_some() => TargetState::DeviceFailed,
        Some(status) if !status.device_open => TargetState::DeviceFailed,
        Some(_) => TargetState::DeviceOpen,
        _ if target.mode == TargetMode::Disabled => TargetState::Disabled,
        _ if target.mode == TargetMode::Upstream && remote_microphone => {
            TargetState::UpstreamTransport
        }
        _ => TargetState::Unconfigured,
    };
    TargetObservation {
        epoch: target.epoch,
        state,
        device,
        error,
    }
}

impl UpstreamPool {
    /// Run an explicit endpoint-pair check while holding the same ownership
    /// reservation used by live output. Blocking audio work stays off the executor.
    pub async fn verify_audio_pair(
        &self,
        pair: stream_kit_audio_target::EndpointPair,
        permit: tokio::sync::SemaphorePermit<'static>,
    ) -> Result<serde_json::Value, String> {
        let registry = self.endpoints.clone();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            registry.verify_pair(&pair)
        })
        .await
        .map_err(|_| "audio verification task failed".to_string())?
    }

    pub async fn observe(
        &self,
        sessions: &[super::control_state::SessionAuthority],
    ) -> Vec<super::media_observation::SessionObservation> {
        use super::media_observation::SessionObservation;
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
                let target = &session.audio.target;
                let snapshot = shared
                    .as_ref()
                    .and_then(|s| s.target.as_ref().map(|t| t.snapshot()));
                SessionObservation {
                    session_id: session.session_id.clone(),
                    revision: session.revision,
                    upstream_active: active,
                    subscribers: shared.as_ref().map_or(0, |s| s.events.receiver_count()),
                    microphone_target: observe_target(
                        target,
                        active,
                        shared.as_ref().is_some_and(|s| s.remote_microphone),
                        snapshot.as_ref(),
                    ),
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
        local_host: bool,
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
        let lease = LaunchLease {
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
        let legacy_target = if let Some(route) = self
            .local_targets
            .iter()
            .find(|route| route.host_id == key.host_id.0 && route.app_id == key.app_id.0)
        {
            super::control_state::AudioTarget {
                epoch: 0,
                mode: super::control_state::TargetMode::Local,
                render_device_id: route.endpoint.render_device_id.clone(),
                capture_device_id: route.endpoint.capture_device_id.clone(),
            }
        } else {
            super::control_state::AudioTarget::default()
        };
        let projected = authority
            .with_runtime(&key, |policy, _| policy.target.clone())
            .await;
        if projected.is_none() && authority.control.read().await.required {
            return Err(AppError::Unauthorized);
        }
        let initial_target = projected
            .filter(|t| t.epoch != 0)
            .unwrap_or_else(|| legacy_target.clone());
        let target = target::Runtime::native(initial_target.epoch, initial_target.endpoint(), slot.clone(), self.endpoints.clone(), local_host)
            .await.map_err(|error| {
                tracing::error!(%error, host_id = key.host_id.0, app_id = key.app_id.0, "configured audio target is unavailable");
                AppError::AudioTargetUnavailable
            })?;
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
        let (recovery, mut recoveries) = recovery::channel();
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
            recovery,
            events: events.clone(),
            // The session bus emits 20 ms stereo packets independently of the host.
            audio: OpusMultistreamConfig::STEREO,
            video: stream.video_setup(),
            features,
            target: Some(target.monitor()),
            remote_microphone,
        });
        let peer = UpstreamPeer {
            peer_id,
            events: events.subscribe(),
            shared: shared.clone(),
        };
        *slot.current.lock().expect("session slot mutex poisoned") = Arc::downgrade(&shared);
        let resources = DriverResources {
            target: Some(target),
            stream,
            _slot: slot.clone(),
        };
        *previous_driver = Some(tokio::spawn(async move {
            // Keep the index entry alive through actual resource destruction,
            // including after the last browser has dropped its Shared handle.
            let mut resources = resources;
            let mut audio_clock = super::mixer::AudioClock::new();
            loop {
                if events.receiver_count() == 0 {
                    break;
                }
                tokio::select! {
                    timestamp = audio_clock.tick() => {
                        let result = authority.with_runtime(&key, |policy, controller| {
                            let route = if policy.target.epoch == 0 { &legacy_target } else { &policy.target };
                            if let Some(target) = resources.target.as_mut() { target.reconcile(route.epoch, route.endpoint()); }
                            for packet in input.reconcile(controller.clone()) {
                                resources.stream.send_raw(packet).map_err(|e| e.to_string())?;
                            }
                            mixer.configure(policy).map_err(|e| e.to_string())?;
                            if microphone_peer != controller {
                                mixer.clear_microphone().map_err(|e| e.to_string())?;
                                resources.stream.clear_pending_microphone();
                                if let Some(target) = &resources.target { target.clear(); }
                                microphone_peer = controller;
                            }
                            if !policy.microphone_enabled && let Some(target) = &resources.target {
                                target.clear();
                            }
                            if !policy.microphone_enabled || route.mode != super::control_state::TargetMode::Upstream {
                                resources.stream.clear_pending_microphone();
                            }
                            let buffer = mixer.render(timestamp, Instant::now()).map_err(|e| e.to_string())?.into();
                            if let Some(target) = &resources.target {
                                target.submit(mixer.target_pcm());
                            }
                            let _ = events.send(Arc::new(MoonlightStreamEvent::Audio(AudioStreamEvent::OnFrame(AudioFrame { timestamp, buffer }))));
                            Ok::<_, String>(())
                        }).await;
                        match result {
                            Some(Ok(())) => {},
                            Some(Err(error)) => { tracing::warn!(%error, "session audio rendering failed"); break; },
                            None => {
                                if input.reconcile(None).into_iter().any(|p| resources.stream.send_raw(p).is_err()) { break; }
                                resources.stream.clear_pending_microphone();
                                let _ = mixer.clear_microphone(); microphone_peer = None;
                                if let Some(target) = resources.target.as_mut() { target.reconcile(0, None); }
                            },
                        }
                    },
                    request = recoveries.recv() => {
                        if request.is_none() || resources.stream.send_raw(ControlPacket::RequestIdr).is_err() { break; }
                    },
                    command = receiver.recv() => match command {
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
                                    resources.stream.clear_pending_microphone();
                                    if let Some(target) = &resources.target { target.clear(); }
                                    microphone_peer = Some(current);
                                }
                                if let Err(error) = mixer.microphone(&bytes, arrived) {
                                    tracing::warn!(%error, "invalid microphone Opus packet");
                                    return;
                                }
                                let route = if policy.target.epoch == 0 { &legacy_target } else { &policy.target };
                                if route.mode == super::control_state::TargetMode::Upstream && remote_microphone {
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
        self.shared
            .target
            .as_ref()
            .and_then(|target| target.snapshot().device)
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
            return if self.shared.recovery.request() {
                Ok(())
            } else {
                Err(AppError::StreamClosed)
            };
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

    #[test]
    fn upstream_microphone_queue_is_bounded_and_revocable() {
        use moonlight_common::{
            crypto::disabled::DisabledCryptoBackend,
            stream::proto::microphone::foundation::payloader::{
                FoundationMicPayloader, FoundationMicPayloaderConfig,
            },
        };
        let mut sender = FoundationMicPayloader::new(
            FoundationMicPayloaderConfig { encryption: None },
            Arc::new(DisabledCryptoBackend),
        );
        for value in 0..5u8 {
            sender
                .push_frame(Duration::from_millis(value as u64 * 20), &[value])
                .expect("valid test frame");
        }
        for value in 2..5u8 {
            assert_eq!(sender.poll_packet().expect("queued test frame")[12], value);
        }
        assert!(sender.poll_packet().is_none());
        sender
            .push_frame(Duration::ZERO, &[9])
            .expect("valid test frame");
        sender.clear();
        assert!(sender.poll_packet().is_none());
    }

    #[test]
    fn upstream_socket_deadline_includes_time_in_microphone_queue() {
        use moonlight_common::{
            crypto::disabled::DisabledCryptoBackend,
            stream::proto::{
                microphone::foundation::{FoundationMicStream, FoundationMicStreamConfig},
                runtime::UdpStream,
            },
        };
        let mut stream = FoundationMicStream::new(
            sans_io_time::Instant::ZERO,
            FoundationMicStreamConfig {
                addr: "127.0.0.1:47996".parse().expect("valid loopback address"),
                encryption: None,
            },
            Arc::new(DisabledCryptoBackend),
        );
        stream
            .send_microphone_opus_data(Duration::ZERO, &[1])
            .expect("valid test frame");
        std::thread::sleep(Duration::from_millis(20));
        // A heavily loaded runner may wake after the whole deadline. In that
        // case the packet must already have expired rather than being sent.
        if stream.poll_transmit().is_some() {
            assert!(stream.transmit_max_hold().expect("mic deadline") <= Duration::from_millis(40));
        } else {
            assert!(stream.transmit_max_hold().is_none());
        }
    }

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
                    true,
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
            true,
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

    fn observed_session() -> super::super::control_state::SessionAuthority {
        let mut state: super::super::control_state::StateEnvelope = serde_json::from_str(
            include_str!("../../../../contracts/media-state/v3.fixture.json"),
        )
        .expect("upstream test setup or assertion failed");
        let mut session = state.sessions.remove(0);
        session.host_id = 1;
        session.app_id = 2;
        session
    }

    #[test]
    fn target_observation_requires_current_open_device_not_just_absent_error() {
        use super::super::{control_state::TargetMode, media_observation::TargetState};
        let mut desired = observed_session().audio.target;
        desired.mode = TargetMode::Local;
        let mut snapshot = target::Snapshot {
            epoch: desired.epoch,
            ..Default::default()
        };
        let missing = observe_target(&desired, true, false, Some(&snapshot));
        assert_eq!(missing.state, TargetState::DeviceFailed);
        assert!(missing.error.is_some());
        snapshot.device = Some(stream_kit_audio_target::TargetStatus {
            device_open: false,
            device_sample_frames: 48000,
            dropped_frames: 0,
            xruns: 0,
            realtime_denied: false,
            error: None,
        });
        let closed = observe_target(&desired, true, false, Some(&snapshot));
        assert_eq!(closed.state, TargetState::DeviceFailed);
        assert!(
            !closed
                .device
                .expect("closed device observation")
                .device_open
        );
        snapshot
            .device
            .as_mut()
            .expect("fixture device")
            .device_open = true;
        assert_eq!(
            observe_target(&desired, true, false, Some(&snapshot)).state,
            TargetState::DeviceOpen
        );
        snapshot.device.as_mut().expect("fixture device").error = Some("native failure".into());
        let failed = observe_target(&desired, true, false, Some(&snapshot));
        assert_eq!(failed.state, TargetState::DeviceFailed);
        assert_eq!(failed.error.as_deref(), Some("native failure"));
        for (active, pending, epoch, expected) in [
            (false, false, desired.epoch, TargetState::Idle),
            (true, true, desired.epoch, TargetState::Pending),
            (true, false, desired.epoch + 1, TargetState::Pending),
        ] {
            snapshot.pending = pending;
            snapshot.epoch = epoch;
            let observation = observe_target(&desired, active, true, Some(&snapshot));
            assert_eq!(observation.state, expected);
            assert!(observation.device.is_none());
            assert!(observation.error.is_none());
        }
        snapshot = target::Snapshot {
            epoch: desired.epoch,
            ..Default::default()
        };
        for (mode, remote, expected) in [
            (TargetMode::Disabled, true, TargetState::Disabled),
            (TargetMode::Upstream, false, TargetState::Unconfigured),
            (TargetMode::Upstream, true, TargetState::UpstreamTransport),
        ] {
            desired.mode = mode;
            assert_eq!(
                observe_target(&desired, true, remote, Some(&snapshot)).state,
                expected
            );
        }
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
                    true,
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
                super::super::media_observation::TargetState::Idle
            );
            assert!(
                pool.connect(
                    MediaSessionKey {
                        host_id: HostId(1),
                        app_id: AppId(3)
                    },
                    MediaSessionRegistry::new(),
                    "second".into(),
                    true,
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
                true,
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
        let (recovery, mut recoveries) = recovery::channel();
        let (events, _) = broadcast::channel(256);
        let slot = Arc::new(SessionSlot::default());
        let shared = Arc::new(Shared {
            authority: authority.clone(),
            key: key.clone(),
            _slot: slot.clone(),
            commands,
            recovery,
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
                true,
                || async { panic!("must reuse existing upstream") },
            )
            .await
            .expect("upstream test setup or assertion failed");
        let mut second = pool
            .connect(
                key,
                MediaSessionRegistry::new(),
                "second".into(),
                true,
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
        // A subscriber without matching device telemetry cannot prove that
        // the requested target generation has been applied.
        assert_eq!(
            snapshot[0].microphone_target.state,
            super::super::media_observation::TargetState::Pending
        );
        second
            .send_raw(ControlPacket::RequestIdr)
            .await
            .expect("upstream test setup or assertion failed");
        assert_eq!(recoveries.recv().await, Some(()));
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
                    true,
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
                true,
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
