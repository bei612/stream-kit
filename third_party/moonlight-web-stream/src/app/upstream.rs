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
    commands: mpsc::Sender<Command>,
    events: broadcast::Sender<Arc<MoonlightStreamEvent>>,
    audio: OpusMultistreamConfig,
    video: VideoSetup,
    features: HostFeatures,
}

#[derive(Default)]
pub struct UpstreamPool {
    sessions: Mutex<HashMap<MediaSessionKey, Weak<Shared>>>,
}

pub struct UpstreamPeer {
    peer_id: String,
    shared: Arc<Shared>,
    events: broadcast::Receiver<Arc<MoonlightStreamEvent>>,
}

impl UpstreamPool {
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
        // Serialize launch through connection establishment: simultaneous offers
        // must not both launch Sunshine. Failed/cancelled launches release the lock.
        let mut sessions = self.sessions.lock().await;
        sessions.retain(|_, entry| entry.strong_count() > 0);
        if let Some(shared) = sessions.get(&key).and_then(Weak::upgrade) {
            if !shared.commands.is_closed() {
                return Ok(UpstreamPeer {
                    peer_id,
                    events: shared.events.subscribe(),
                    shared,
                });
            }
        }
        let mut stream = start().await?;
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
        let shared = Arc::new(Shared {
            commands,
            events: events.clone(),
            // The session bus emits 20 ms stereo packets independently of the host.
            audio: OpusMultistreamConfig::STEREO,
            video: stream.video_setup(),
            features: stream.host_features(),
        });
        let peer = UpstreamPeer {
            peer_id,
            events: events.subscribe(),
            shared: shared.clone(),
        };
        sessions.insert(key.clone(), Arc::downgrade(&shared));
        tokio::spawn(async move {
            let mut audio_clock = super::mixer::AudioClock::new();
            loop {
                tokio::select! {
                    timestamp = audio_clock.tick() => {
                        let result = authority.with_audio_output(&key, |policy, controller| {
                            mixer.configure(policy)?;
                            if microphone_peer.as_deref() != controller {
                                mixer.clear_microphone()?;
                                microphone_peer = controller.map(str::to_owned);
                            }
                            let buffer = mixer.render(timestamp, std::time::Instant::now())?.into();
                            let _ = events.send(Arc::new(MoonlightStreamEvent::Audio(AudioStreamEvent::OnFrame(AudioFrame { timestamp, buffer }))));
                            Ok::<_, opus::Error>(())
                        }).await;
                        match result {
                            Some(Ok(())) => {},
                            Some(Err(error)) => { tracing::warn!(%error, "session audio rendering failed"); break; },
                            None => { let _ = mixer.clear_microphone(); microphone_peer = None; },
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
                                    microphone_peer = Some(peer_id.clone());
                                }
                                if let Err(error) = mixer.microphone(&bytes, std::time::Instant::now()) {
                                    tracing::warn!(%error, "invalid microphone Opus packet");
                                    return;
                                }
                                stream.send_microphone_opus_data(timestamp, &bytes);
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

    #[tokio::test]
    async fn subscribers_reuse_transport_until_last_peer_leaves() {
        let pool = UpstreamPool::default();
        let key = MediaSessionKey {
            host_id: HostId(1),
            app_id: AppId(2),
        };
        let (commands, mut receiver) = mpsc::channel(256);
        let (events, _) = broadcast::channel(256);
        let shared = Arc::new(Shared {
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
        });
        pool.sessions
            .lock()
            .await
            .insert(key.clone(), Arc::downgrade(&shared));
        let first = pool
            .connect(
                key.clone(),
                MediaSessionRegistry::new(),
                "first".into(),
                || async { panic!("must reuse existing upstream") },
            )
            .await
            .unwrap();
        let mut second = pool
            .connect(
                key,
                MediaSessionRegistry::new(),
                "second".into(),
                || async { panic!("must reuse existing upstream") },
            )
            .await
            .unwrap();
        drop(shared);
        drop(first);
        assert!(second.is_alive());
        second.send_raw(ControlPacket::RequestIdr).unwrap();
        assert!(matches!(
            receiver.recv().await,
            Some(Command::Packet(_, ControlPacket::RequestIdr))
        ));
        drop(second);
        assert!(
            receiver.recv().await.is_none(),
            "last peer must release upstream driver"
        );
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
        assert!(pool.sessions.lock().await.is_empty());
    }
}
