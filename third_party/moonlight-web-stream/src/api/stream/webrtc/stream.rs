use std::{future::pending, sync::Arc, time::Duration};

use bytes::Bytes;

use moonlight_common::stream::{
    audio::AudioFrame,
    proto::{
        audio::AudioStreamEvent,
        control::{ControlStreamEvent, packet::ControlPacket},
        video::VideoStreamEvent,
    },
    tokio::MoonlightStreamEvent,
};
use tokio::{select, sync::mpsc};
use tracing::{debug, info, warn};
use webrtc::{
    data_channel::DataChannel,
    media_stream::track_remote::TrackRemote,
    peer_connection::{PeerConnection, RTCPeerConnectionState},
};

use crate::{
    api::stream::webrtc::{
        WebRtcHandler,
        audio::AudioChannel,
        control::{ControlChannel, ControlChannelEvent},
        microphone::{MicChannel, MicChannelEvent},
        video::{VideoChannel, VideoChannelEvent},
    },
    app::AppError,
    app::media::{MediaSessionKey, MediaSessionRegistry},
    app::upstream::UpstreamPeer,
};

pub async fn webrtc_loop(
    mut stream: UpstreamPeer,
    _peer: &dyn PeerConnection,
    mut audio_channel: AudioChannel,
    mut video_channel: VideoChannel,
    mut control_channel: ControlChannel,
    mut mic_channel: Option<MicChannel>,
    mut on_data_channel: mpsc::UnboundedReceiver<Arc<dyn DataChannel>>,
    mut on_track: mpsc::UnboundedReceiver<Arc<dyn TrackRemote>>,
    handler: &WebRtcHandler,
    media_registry: MediaSessionRegistry,
    media_key: MediaSessionKey,
    media_peer_id: String,
) -> Result<(), AppError> {
    info!("started main webrtc loop");

    let mut peer_was_disconnected = true;
    let mut lease_check = tokio::time::interval(Duration::from_millis(250));
    loop {
        if !stream.is_alive() {
            info!("stopping stream because the moonlight stream is dead");
            break;
        }

        let peer_state = { *handler.peer_state.lock().expect("lock peer state") };

        match peer_state {
            RTCPeerConnectionState::Connected => {
                if peer_was_disconnected {
                    // request idr after connecting
                    debug!("requesting idr after webrtc peers connected");
                    if let Err(err) = stream.send_raw(ControlPacket::RequestIdr).await {
                        warn!(error = %err, "failed to request initial idr");
                    }
                }
                peer_was_disconnected = false;
            }
            RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed => {
                return Ok(());
            }
            _ => {
                peer_was_disconnected = true;
            }
        }

        select! {
            _ = lease_check.tick() => {
                if !media_registry.admitted(&media_key, &media_peer_id).await { return Ok(()); }
            }
            Some(data_channel) = async { if on_data_channel.is_closed() { pending().await } else { on_data_channel.recv().await } } => {
                let label = data_channel.label().await?;
                debug!(data_channel = ?label, "got data channel");

                if control_channel.try_add_channel(&label, &data_channel) {
                    continue;
                }
            }
            Some(track) = async { if on_track.is_closed() { pending().await } else { on_track.recv().await } } => {
                debug!("got remote track");

                if let Some(mic_channel) = &mut mic_channel {
                    mic_channel.set_track(track);
                }
            }
            result = stream.drive() => {

                let event = result?;

                match event.as_ref() {
                    MoonlightStreamEvent::Audio(AudioStreamEvent::OnFrame(frame)) => {
                        if !matches!(peer_state, RTCPeerConnectionState::Connected) {
                            continue;
                        }


                        audio_channel.on_frame(AudioFrame { timestamp: frame.timestamp, buffer: Bytes::copy_from_slice(&frame.buffer) });
                    }
                    MoonlightStreamEvent::Video(VideoStreamEvent::SignalIdr) => {
                        debug!("requesting idr on behalf of the video stream (packet loss likely)");
                        if let Err(err) = stream.send_raw(ControlPacket::RequestIdr).await {
                            warn!(error = %err, "failed to send idr");
                        }
                    }
                    MoonlightStreamEvent::Video(VideoStreamEvent::OnFrame(frame)) => {
                        if !matches!(peer_state, RTCPeerConnectionState::Connected) {
                            continue;
                        }


                        video_channel.on_frame(frame.clone());
                    }
                    MoonlightStreamEvent::Control(ControlStreamEvent::Packet(packet)) => {
                        if let ControlPacket::ServerTermination { reason } = &packet {
                            info!(?reason, "relaying host termination to browser");
                            control_channel.send(packet.clone());

                            // Keep SCTP alive until the viewer has received the message
                            // and closed the channel. Closing the peer immediately can
                            // discard the queued termination packet, especially over WAN.
                            let _ = tokio::time::timeout(
                                Duration::from_secs(5),
                                async {
                                    while !matches!(control_channel.drive().await, Ok(ControlChannelEvent::Closed) | Err(_)) {}
                                }
                            ).await;

                            return Ok(());
                        }
                        if let ControlPacket::HdrMode { enabled, sunshine } = &packet {
                            video_channel.set_hdr_enabled(*enabled, *sunshine);
                        }

                        control_channel.send(packet.clone());
                    }
                    _ => {}
                }
            }
            result = video_channel.drive() => {
                let event = result?;

                match event {
                    VideoChannelEvent::SignalIdr => {
                        debug!("requesting idr because the webrtc client requested it");
                        if let Err(err) = stream.send_raw(ControlPacket::RequestIdr).await {
                            warn!(error = %err, "failed to send idr");
                        }
                    }
                }
            }
            result = control_channel.drive() => {
                let event = result?;

                match event {
                    ControlChannelEvent::Packet(packet) => {
                        if !media_registry.can_control(&media_key, &media_peer_id).await {
                            debug!(peer_id = %media_peer_id, "dropping viewer control packet");
                            continue;
                        }
                        match stream.send_raw(packet).await {
                            Ok(()) | Err(AppError::Forbidden) => {},
                            // A dropped key-up cannot be repaired by waiting
                            // for another event. End this attachment so the
                            // shared runtime releases its accepted input.
                            Err(error) => return Err(error),
                        }
                    },
                    ControlChannelEvent::Closed => {
                        info!("control channel closed");
                        return Err(AppError::StreamClosed);
                    },
                }
            }
            result = async { if let Some(mic_channel) = &mut mic_channel { mic_channel.drive().await } else { pending().await } } => {
                let event = result?;

                match event {
                    MicChannelEvent::OnFrame {
                        timestamp,
                        data,
                    } => {
                        if media_registry.can_control(&media_key, &media_peer_id).await {
                            stream.send_microphone_opus_data(timestamp, &data).await;
                        } else {
                            debug!(peer_id = %media_peer_id, "dropping viewer microphone frame");
                        }
                    }
                    MicChannelEvent::Closed => {
                        warn!("the microphone channel got closed");
                    }
                }
            }
        }
    }

    Ok(())
}
