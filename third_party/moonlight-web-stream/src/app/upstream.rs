//! A transport belongs to a rendering session, never to an individual browser.
use std::{collections::HashMap, future::Future, sync::{Arc, Weak}, time::Duration};
use moonlight_common::stream::{
    HostFeatures, audio::OpusMultistreamConfig, video::VideoSetup,
    proto::{control::packet::ControlPacket, video::VideoStreamEvent},
    tokio::{MoonlightStream, MoonlightStreamEvent},
};
use tokio::sync::{Mutex, broadcast, mpsc};
use super::{AppError, media::MediaSessionKey};

enum Command {
    Packet(ControlPacket),
    Microphone(Duration, Vec<u8>),
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
    shared: Arc<Shared>,
    events: broadcast::Receiver<Arc<MoonlightStreamEvent>>,
}

impl UpstreamPool {
    pub async fn connect<F, Fut>(&self, key: MediaSessionKey, start: F) -> Result<UpstreamPeer, AppError>
    where F: FnOnce() -> Fut, Fut: Future<Output = Result<MoonlightStream, AppError>> {
        // Serialize launch through connection establishment: simultaneous offers
        // must not both launch Sunshine. Failed/cancelled launches release the lock.
        let mut sessions = self.sessions.lock().await;
        sessions.retain(|_, entry| entry.strong_count() > 0);
        if let Some(shared) = sessions.get(&key).and_then(Weak::upgrade) {
            if !shared.commands.is_closed() {
                return Ok(UpstreamPeer { events: shared.events.subscribe(), shared });
            }
        }
        let mut stream = start().await?;
        let (commands, mut receiver) = mpsc::channel(256);
        let (events, _) = broadcast::channel(256);
        let shared = Arc::new(Shared {
            commands, events: events.clone(), audio: stream.audio_setup(),
            video: stream.video_setup(), features: stream.host_features(),
        });
        let peer = UpstreamPeer { events: events.subscribe(), shared: shared.clone() };
        sessions.insert(key, Arc::downgrade(&shared));
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    command = receiver.recv() => match command {
                        Some(Command::Packet(packet)) => { if stream.send_raw(packet).is_err() { break; } }
                        Some(Command::Microphone(timestamp, bytes)) => { stream.send_microphone_opus_data(timestamp, &bytes); }
                        None => { let _ = stream.disconnect(); break; }
                    },
                    result = stream.drive() => match result {
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
    pub fn audio_setup(&self) -> OpusMultistreamConfig { self.shared.audio.clone() }
    pub fn video_setup(&self) -> VideoSetup { self.shared.video }
    pub fn host_features(&self) -> HostFeatures { self.shared.features.clone() }
    pub fn is_alive(&self) -> bool { !self.shared.commands.is_closed() }
    pub fn send_raw(&mut self, packet: ControlPacket) -> Result<(), AppError> {
        self.shared.commands.try_send(Command::Packet(packet)).map_err(|_| AppError::StreamClosed)
    }
    pub fn send_microphone_opus_data(&mut self, timestamp: Duration, bytes: &[u8]) -> bool {
        self.shared.commands.try_send(Command::Microphone(timestamp, bytes.to_vec())).is_ok()
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
        let key = MediaSessionKey { host_id: HostId(1), app_id: AppId(2) };
        let (commands, mut receiver) = mpsc::channel(256);
        let (events, _) = broadcast::channel(256);
        let shared = Arc::new(Shared {
            commands, events, audio: OpusMultistreamConfig::STEREO,
            video: VideoSetup { format: VideoFormat::H264, width: 1280, height: 720, redraw_rate: 60 },
            features: HostFeatures::default(),
        });
        pool.sessions.lock().await.insert(key.clone(), Arc::downgrade(&shared));
        let first = pool.connect(key.clone(), || async { panic!("must reuse existing upstream") }).await.unwrap();
        let mut second = pool.connect(key, || async { panic!("must reuse existing upstream") }).await.unwrap();
        drop(shared);
        drop(first);
        assert!(second.is_alive());
        second.send_raw(ControlPacket::RequestIdr).unwrap();
        assert!(matches!(receiver.recv().await, Some(Command::Packet(ControlPacket::RequestIdr))));
        drop(second);
        assert!(receiver.recv().await.is_none(), "last peer must release upstream driver");
    }

    #[tokio::test]
    async fn failed_launch_does_not_poison_pool() {
        let pool = UpstreamPool::default();
        let key = MediaSessionKey { host_id: HostId(1), app_id: AppId(2) };
        for _ in 0..2 {
            assert!(pool.connect(key.clone(), || async { Err(AppError::StreamClosed) }).await.is_err());
        }
        assert!(pool.sessions.lock().await.is_empty());
    }
}
