use std::{sync::Arc, time::Duration};

use moonlight_common::webrtc::sdp::Session;
use rtc::rtp_transceiver::rtp_sender::RtpCodecKind;
use tokio::{spawn, task::JoinHandle};
use tracing::{Instrument, debug, debug_span};
use webrtc::media_stream::track_remote::{TrackRemote, TrackRemoteEvent};

use crate::app::upstream::MicrophoneSender;

// No intermediate microphone queue: the session command boundary owns
// capacity, arrival time and authorization generation for every packet.
#[derive(Default)]
pub struct MicChannel {
    task: Option<JoinHandle<()>>,
}

impl Drop for MicChannel {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

impl MicChannel {
    pub fn new(offer_sdp: &Session) -> Option<Self> {
        offer_sdp
            .medias
            .iter()
            .any(|media| {
                media.media == "audio"
                    && media
                        .attributes
                        .iter()
                        .any(|a| a.attribute == "sendonly" || a.attribute == "sendrecv")
            })
            .then(Self::default)
    }

    fn replace_task(&mut self, task: JoinHandle<()>) {
        if let Some(old) = self.task.replace(task) {
            old.abort();
        }
    }

    pub async fn set_track(&mut self, track: Arc<dyn TrackRemote>, sink: MicrophoneSender) {
        if track.kind().await != RtpCodecKind::Audio {
            track.stop().await;
            return;
        }
        self.replace_task(spawn(
            async move {
                while let Some(event) = track.poll().await {
                    match event {
                        TrackRemoteEvent::OnOpen(info) => {
                            debug!(info = ?info, "current microphone channel");
                        }
                        TrackRemoteEvent::OnRtpPacket(packet) => {
                            // Negotiated audio uses Opus with a 48 kHz RTP clock.
                            let timestamp =
                                Duration::from_millis((packet.header.timestamp / 48) as u64);
                            // Admission and bounded try_send occur together; old
                            // grants are checked again by the shared driver.
                            sink.send_opus(timestamp, &packet.payload).await;
                        }
                        TrackRemoteEvent::OnEnded | TrackRemoteEvent::OnError => break,
                        _ => {}
                    }
                }
            }
            .instrument(debug_span!("microphone track remote")),
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_sending_audio_negotiates_a_microphone() {
        for (kind, direction, expected) in [
            ("video", "sendrecv", false),
            ("application", "sendrecv", false),
            ("audio", "recvonly", false),
            ("audio", "inactive", false),
            ("audio", "sendonly", true),
            ("audio", "sendrecv", true),
        ] {
            let raw = format!(
                "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm={kind} 9 UDP/TLS/RTP/SAVPF 111\r\na={direction}\r\n"
            );
            let sdp = Session::parse(raw.as_bytes()).expect("SDP fixture");
            assert_eq!(MicChannel::new(&sdp).is_some(), expected);
        }
    }

    #[tokio::test]
    async fn replacing_or_dropping_microphone_cancels_idle_pollers() {
        let mut mic = MicChannel::default();
        let first = spawn(std::future::pending());
        let first_abort = first.abort_handle();
        mic.replace_task(first);
        let second = spawn(std::future::pending());
        let second_abort = second.abort_handle();
        mic.replace_task(second);
        drop(mic);
        tokio::time::timeout(Duration::from_secs(1), async {
            while !first_abort.is_finished() || !second_abort.is_finished() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("track pollers must not survive their owner");
    }
}
