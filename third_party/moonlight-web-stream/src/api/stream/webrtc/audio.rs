use std::{sync::Arc, time::Duration};

use bytes::Bytes;
use moonlight_common::{
    crypto::rustcrypto::RustCryptoBackend,
    http::pair::PairingCryptoBackend,
    stream::audio::{AudioFrame, OpusMultistreamConfig},
    webrtc::sdp::Session,
};
use rtc::{
    media_stream::MediaStreamTrack,
    rtp::{
        Header, Packet,
        extension::{HeaderExtension, playout_delay_extension::PlayoutDelayExtension},
    },
    rtp_transceiver::{
        SSRC,
        rtp_sender::{RTCRtpCodingParameters, RTCRtpEncodingParameters, RtpCodecKind},
    },
};
use tokio::{
    spawn,
    sync::mpsc::{Receiver, Sender, channel},
    time::Instant,
};
use tracing::{Instrument, debug_span, info, trace, warn};
use webrtc::{
    media_stream::track_local::{TrackLocal, static_rtp::TrackLocalStaticRTP},
    peer_connection::PeerConnection,
};

use crate::{api::stream::webrtc::opus_codec, app::AppError};

// TODO: add audio over unreliable data channels using AudioStream and AudioPayloader

pub struct AudioChannel {
    frame_sender: Sender<(Instant, AudioFrame<Bytes>)>,
}

// RTP payload numbers belong to the offer, not to a browser or codec globally.
// Select only the receiving audio m-line, never the microphone's send-only line.
pub(super) fn offered_opus_payload(sdp: &Session) -> Option<u8> {
    for media in &sdp.medias {
        let attributes = &media.attributes;
        let direction = attributes
            .iter()
            .find(|a| {
                matches!(
                    a.attribute.as_str(),
                    "sendonly" | "recvonly" | "sendrecv" | "inactive"
                )
            })
            .or_else(|| {
                sdp.attributes.iter().find(|a| {
                    matches!(
                        a.attribute.as_str(),
                        "sendonly" | "recvonly" | "sendrecv" | "inactive"
                    )
                })
            });
        if media.media != "audio"
            || media.port == 0
            || direction.is_some_and(|a| matches!(a.attribute.as_str(), "sendonly" | "inactive"))
        {
            continue;
        }
        for format in media.fmt.split_whitespace() {
            let Ok(payload) = format.parse::<u8>() else {
                continue;
            };
            if payload > 127 {
                continue;
            }
            if attributes.iter().any(|a| {
                a.attribute == "rtpmap"
                    && a.value.as_deref().is_some_and(|value| {
                        let mut fields = value.split_whitespace();
                        fields.next() == Some(format)
                            && fields
                                .next()
                                .is_some_and(|codec| codec.eq_ignore_ascii_case("opus/48000/2"))
                            && fields.next().is_none()
                    })
            }) {
                return Some(payload);
            }
        }
    }
    None
}

async fn next_live_frame(
    receiver: &mut Receiver<(Instant, AudioFrame<Bytes>)>,
) -> Option<AudioFrame<Bytes>> {
    while let Some((queued_at, frame)) = receiver.recv().await {
        if queued_at.elapsed() <= Duration::from_millis(60) {
            return Some(frame);
        }
    }
    None
}

impl AudioChannel {
    pub async fn new_track(
        config: OpusMultistreamConfig,
        peer: &dyn PeerConnection,
        payload_type: u8,
    ) -> Result<Self, AppError> {
        // TODO: what audio format is used?

        // Create audio track
        let mut ssrc = [0; 4];
        RustCryptoBackend.random_bytes(&mut ssrc)?;
        let ssrc = SSRC::from_ne_bytes(ssrc);

        let mut codec = opus_codec();
        codec.channels = config.channel_count as u16;

        let track = Arc::new(TrackLocalStaticRTP::new(MediaStreamTrack::new(
            "audio".to_string(),
            "audio".to_string(),
            "audio".to_string(),
            RtpCodecKind::Audio,
            vec![RTCRtpEncodingParameters {
                rtp_coding_parameters: RTCRtpCodingParameters {
                    ssrc: Some(ssrc),
                    ..Default::default()
                },
                codec: codec.clone(),
                ..Default::default()
            }],
        )));

        peer.add_track(Arc::clone(&track) as Arc<dyn TrackLocal>)
            .await?;

        info!(audio_config = ?config, codec = ?codec, "finished audio track setup");

        // At most 60 ms of session audio may wait behind a slow WebRTC sender.
        let (frame_sender, mut frame_receiver) = channel(3);

        spawn(
            async move {
                let mut sequence_number = 0u16;

                while let Some(frame) = next_live_frame(&mut frame_receiver).await {
                    let timestamp = (frame.timestamp.as_millis() * 48) as u32;

                    trace!(len = ?frame.buffer.len(), timestamp = ?frame.timestamp, "audio frame");

                    sequence_number = sequence_number.wrapping_add(1);

                    // Opus doesn't need any special payloading: https://github.com/webrtc-rs/webrtc/blob/6b94718e23111df28125f96af4b0de8cbb3dfd0d/rtp/src/codecs/opus/mod.rs#L9-L24
                    if let Err(err) = track
                        .write_rtp_with_extensions(
                            Packet {
                                header: Header {
                                    version: 2,
                                    sequence_number,
                                    timestamp,
                                    payload_type,
                                    ssrc,
                                    ..Default::default()
                                },
                                payload: frame.buffer,
                            },
                            &[HeaderExtension::PlayoutDelay(PlayoutDelayExtension {
                                min_delay: 0,
                                max_delay: 0,
                            })],
                        )
                        .await
                    {
                        warn!(error = %err, "failed to send audio frame");
                    }
                }
            }
            .instrument(debug_span!("audio frame relay")),
        );

        Ok(Self { frame_sender })
    }

    pub fn on_frame(&mut self, frame: AudioFrame<Bytes>) {
        let _ = self.frame_sender.try_send((Instant::now(), frame));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opus_payload_follows_receiving_offer() {
        for payload in [96, 109, 111, 127] {
            let raw = format!(
                "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 112\r\na=sendonly\r\na=rtpmap:112 opus/48000/2\r\nm=audio 9 UDP/TLS/RTP/SAVPF {payload}\r\na=recvonly\r\na=rtpmap:{payload} opus/48000/2\r\n"
            );
            assert_eq!(
                offered_opus_payload(
                    &Session::parse(raw.as_bytes()).expect("receiving SDP fixture")
                ),
                Some(payload)
            );
        }
        for (port, direction, formats, mapping) in [
            (0, "recvonly", "109", "109 opus/48000/2"),
            (9, "sendonly", "109", "109 opus/48000/2"),
            (9, "inactive", "109", "109 opus/48000/2"),
            (9, "recvonly", "111", "109 opus/48000/2"),
            (9, "recvonly", "109", "109 opus/48000/1"),
            (9, "recvonly", "109", "109 opus/24000/2"),
            (9, "recvonly", "128", "128 opus/48000/2"),
        ] {
            let raw = format!(
                "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na={direction}\r\nm=audio {port} UDP/TLS/RTP/SAVPF {formats}\r\na=rtpmap:{mapping}\r\n"
            );
            assert_eq!(
                offered_opus_payload(
                    &Session::parse(raw.as_bytes()).expect("unsupported SDP fixture")
                ),
                None
            );
        }
    }

    #[tokio::test(start_paused = true)]
    async fn slow_viewer_cannot_accumulate_unbounded_audio() {
        let (frame_sender, mut receiver) = channel(3);
        let mut channel = AudioChannel { frame_sender };
        for i in 0..100 {
            channel.on_frame(AudioFrame {
                timestamp: Duration::from_millis(i * 20),
                buffer: Bytes::from_static(b"bounded queue"),
            });
        }
        assert_eq!(receiver.len(), 3);
        for i in 0..3 {
            assert_eq!(
                next_live_frame(&mut receiver)
                    .await
                    .expect("expected a queued audio frame")
                    .timestamp,
                Duration::from_millis(i * 20)
            );
        }
    }

    #[tokio::test(start_paused = true)]
    async fn stalled_viewer_drops_old_packets_before_resuming() {
        let (frame_sender, mut receiver) = channel(3);
        let mut channel = AudioChannel { frame_sender };
        channel.on_frame(AudioFrame {
            timestamp: Duration::ZERO,
            buffer: Bytes::new(),
        });
        tokio::time::advance(Duration::from_millis(100)).await;
        channel.on_frame(AudioFrame {
            timestamp: Duration::from_millis(100),
            buffer: Bytes::new(),
        });
        drop(channel);
        assert_eq!(
            next_live_frame(&mut receiver)
                .await
                .expect("expected a queued audio frame")
                .timestamp,
            Duration::from_millis(100)
        );
        assert!(next_live_frame(&mut receiver).await.is_none());
    }
}
