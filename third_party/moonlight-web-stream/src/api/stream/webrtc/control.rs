use std::time::Duration;
use std::{collections::HashSet, sync::Arc};

use bytes::BytesMut;
use moonlight_common::stream::proto::control::packet::{
    ControlPacket, ControlPacketConfig, PacketDirection,
};
use rtc::data_channel::RTCDataChannelState;
use tokio::select;
use tokio::sync::mpsc;
use tokio::task::JoinSet;
use tokio::time::sleep;
use tracing::{Instrument, debug, debug_span, info, trace, warn};
use webrtc::data_channel::{DataChannel, DataChannelEvent};
use webrtc::peer_connection::PeerConnection;

use crate::api::stream::create_control_packet_config;
use crate::app::AppError;
use crate::app::upstream::InputSender;

const CONTROL_QUEUE_CAPACITY: usize = 128;
const CONTROL_EVENT_CAPACITY: usize = 16;
const CONTROL_SEND_TIMEOUT: Duration = Duration::from_secs(2);

fn auxiliary_label(label: &str) -> bool {
    matches!(
        label,
        "moonlight.control.mouseAbsolute"
            | "moonlight.control.mouse"
            | "moonlight.control.keysCompact"
            | "moonlight.control.keys"
            | "moonlight.control.touch"
            | "moonlight.control.controller"
    )
}

pub enum ControlChannelEvent {
    Closed,
}

async fn receive_input(
    sender: &InputSender,
    config: &ControlPacketConfig,
    bytes: &[u8],
    is_string: bool,
) -> Result<(), AppError> {
    if is_string || bytes.len() > ControlPacket::MAX_SIZE {
        return Ok(());
    }
    let Some(packet) = ControlPacket::deserialize(PacketDirection::ServerBound, config, bytes)
    else {
        // Never log key/text payloads from an untrusted peer.
        debug!("discarding invalid control packet");
        return Ok(());
    };
    match sender.send(packet).await {
        Ok(()) | Err(AppError::Forbidden) => Ok(()),
        // Lost key-up cannot be repaired by continuing. Closing the attachment
        // makes the shared input runtime release all of its accepted input.
        Err(error) => Err(error),
    }
}

pub struct ControlChannel {
    #[allow(unused)]
    channel: Arc<dyn DataChannel>,
    channel_state: RTCDataChannelState,
    on_main_channel_event: mpsc::Receiver<DataChannelEvent>,
    on_failure: mpsc::Receiver<()>,
    on_failure_sender: mpsc::Sender<()>,
    input: InputSender,
    tasks: JoinSet<()>,
    on_send: mpsc::Sender<BytesMut>,
    auxiliary_channels: HashSet<String>,
    config: ControlPacketConfig,
}

impl ControlChannel {
    pub async fn new(peer: &dyn PeerConnection, input: InputSender) -> Result<Self, AppError> {
        let channel = peer.create_data_channel("moonlight.control", None).await?;

        let (on_failure_sender, on_failure) = mpsc::channel(1);
        let (on_send, mut on_send_receiver) = mpsc::channel::<BytesMut>(CONTROL_QUEUE_CAPACITY);
        let (on_event_sender, on_event) = mpsc::channel(CONTROL_EVENT_CAPACITY);
        let mut tasks = JoinSet::new();

        tasks.spawn({
            let channel = channel.clone();
            async move {
                let ready_state = async || match channel.ready_state().await {
                    Ok(value) => value,
                    Err(err) => {
                        warn!(error = %err, "failed to query data channel state");
                        RTCDataChannelState::Closed
                    }
                };
                let mut connected = false;

                while let Some(message) = on_send_receiver.recv().await {
                    while !connected
                        && matches!(ready_state().await, RTCDataChannelState::Connecting)
                    {
                        sleep(Duration::from_millis(100)).await;
                    }
                    connected = true;

                    trace!(
                        bytes = message.len(),
                        "sending control message to webrtc peer over data channel"
                    );
                    if !matches!(
                        tokio::time::timeout(CONTROL_SEND_TIMEOUT, channel.send(message)).await,
                        Ok(Ok(()))
                    ) {
                        warn!("control data channel send failed or exceeded deadline");
                        break;
                    }
                }
            }
            .instrument(debug_span!("main data channel sender"))
        });
        tasks.spawn({
            let channel = channel.clone();
            let input = input.clone();
            let on_failure = on_failure_sender.clone();
            async move {
                let config = create_control_packet_config();
                while let Some(event) = channel.poll().await {
                    if let DataChannelEvent::OnMessage(message) = event {
                        if receive_input(&input, &config, &message.data, message.is_string)
                            .await
                            .is_err()
                        {
                            let _ = on_failure.try_send(());
                            break;
                        }
                    } else if on_event_sender.try_send(event).is_err() {
                        let _ = on_failure.try_send(());
                        break;
                    }
                }
            }
            .instrument(debug_span!("main data channel event receiver"))
        });

        Ok(Self {
            channel,
            channel_state: RTCDataChannelState::Connecting,
            on_main_channel_event: on_event,
            on_failure,
            on_failure_sender,
            input,
            tasks,
            on_send,
            auxiliary_channels: HashSet::new(),
            config: create_control_packet_config(),
        })
    }

    pub fn try_add_channel(&mut self, label: &str, channel: &Arc<dyn DataChannel>) -> bool {
        if !auxiliary_label(label) || !self.auxiliary_channels.insert(label.to_owned()) {
            return false;
        }
        info!(label = %label, "adding control channel");

        let channel = channel.clone();
        let input = self.input.clone();
        let on_failure = self.on_failure_sender.clone();
        self.tasks.spawn(
            async move {
                let config = create_control_packet_config();
                while let Some(event) = channel.poll().await {
                    if let DataChannelEvent::OnMessage(message) = event
                        && receive_input(&input, &config, &message.data, message.is_string)
                            .await
                            .is_err()
                    {
                        let _ = on_failure.try_send(());
                        break;
                    }
                }
            }
            .instrument(debug_span!("data channel", label = %label)),
        );

        true
    }

    pub fn send(&mut self, packet: ControlPacket) {
        let mut buffer = [0; ControlPacket::MAX_SIZE];

        let len = match packet.serialize(&self.config, &mut buffer) {
            Ok(value) => value,
            Err(err) => {
                warn!(error = %err, "failed to relay control packet from server to client");
                return;
            }
        };
        let buffer = &buffer[0..len];

        let mut bytes = BytesMut::with_capacity(buffer.len());
        bytes.extend_from_slice(buffer);

        // A slow viewer must not accumulate control messages indefinitely. Close
        // the attachment instead of dropping stateful feedback silently.
        if self.on_send.try_send(bytes).is_err() {
            let _ = self.on_failure_sender.try_send(());
        }
    }

    pub fn is_alive(&self) -> bool {
        !matches!(self.channel_state, RTCDataChannelState::Closed)
    }

    /// # Cancel Safety
    /// This function is cancel safe.
    /// If it is cancelled no state is lost.
    pub async fn drive(&mut self) -> Result<ControlChannelEvent, AppError> {
        loop {
            if !self.is_alive() {
                return Ok(ControlChannelEvent::Closed);
            }

            select! {
                completed = self.tasks.join_next() => {
                    if let Some(Err(error)) = completed {
                        warn!(%error, "control channel task failed");
                    }
                    // A closed input channel or failed poller may have lost a
                    // release event. End the attachment and reconcile held input.
                    return Ok(ControlChannelEvent::Closed);
                },
                _ = self.on_failure.recv() => {
                    return Ok(ControlChannelEvent::Closed);
                },
                result = self.on_main_channel_event.recv() => {
                    let Some(event) = result else {
                        debug!("closed because of main channel being closed");
                        return Ok(ControlChannelEvent::Closed);
                    };

                    match event {
                        DataChannelEvent::OnOpen => {
                            self.channel_state = RTCDataChannelState::Open;
                        }
                        DataChannelEvent::OnClosing => {
                            self.channel_state = RTCDataChannelState::Closing;
                        }
                        DataChannelEvent::OnClose => {
                            self.channel_state = RTCDataChannelState::Closed;
                            return Ok(ControlChannelEvent::Closed);
                        }
                        _ => {}
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use moonlight_common::stream::control::{KeyAction, KeyCode, KeyFlags, KeyModifiers};
    use moonlight_common::stream::proto::control::packet::{
        UTF8_TEXT_EVENT_MAGIC, UTF8_TEXT_MAX_COUNT,
    };

    #[test]
    fn truncated_input_is_rejected_without_panicking() {
        let config = create_control_packet_config();
        let packet = ControlPacket::Keyboard {
            action: KeyAction::Down,
            flags: KeyFlags::empty(),
            key_code: KeyCode(65),
            modifiers: KeyModifiers::empty(),
            zero: 0,
        };
        let mut bytes = [0; ControlPacket::MAX_SIZE];
        let length = packet.serialize(&config, &mut bytes).expect("valid key");
        for end in 0..length {
            assert!(
                ControlPacket::deserialize(PacketDirection::ServerBound, &config, &bytes[..end])
                    .is_none(),
                "truncated at {end}"
            );
        }
        assert!(matches!(
            ControlPacket::deserialize(PacketDirection::ServerBound, &config, &bytes[..length]),
            Some(ControlPacket::Keyboard {
                key_code: KeyCode(65),
                ..
            })
        ));
    }

    fn text_packet(config: &ControlPacketConfig, content: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&config.input_data.0.to_le_bytes());
        bytes.extend_from_slice(&((8 + content.len()) as u16).to_le_bytes());
        bytes.extend_from_slice(&((4 + content.len()) as u32).to_be_bytes());
        bytes.extend_from_slice(&UTF8_TEXT_EVENT_MAGIC.to_le_bytes());
        bytes.extend_from_slice(content);
        bytes
    }

    #[test]
    fn text_length_cannot_underflow_or_exceed_fixed_storage() {
        let config = create_control_packet_config();
        for invalid in 0u32..4 {
            let mut bytes = text_packet(&config, b"");
            bytes[4..8].copy_from_slice(&invalid.to_be_bytes());
            assert!(
                ControlPacket::deserialize(PacketDirection::ServerBound, &config, &bytes).is_none()
            );
        }
        for length in [0, 1, UTF8_TEXT_MAX_COUNT, UTF8_TEXT_MAX_COUNT + 1, 256] {
            let bytes = text_packet(&config, &vec![b'x'; length]);
            let Some(ControlPacket::Text { text, text_len }) =
                ControlPacket::deserialize(PacketDirection::ServerBound, &config, &bytes)
            else {
                panic!("valid text length {length}");
            };
            assert_eq!(text_len, length.min(UTF8_TEXT_MAX_COUNT));
            assert!(text[..text_len].iter().all(|&byte| byte == b'x'));
        }
    }
}
