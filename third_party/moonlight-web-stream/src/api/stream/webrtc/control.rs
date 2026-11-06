use std::sync::Arc;
use std::time::Duration;

use bytes::BytesMut;
use moonlight_common::stream::proto::control::packet::{
    ControlPacket, ControlPacketConfig, PacketDirection,
};
use rtc::data_channel::RTCDataChannelState;
use tokio::select;
use tokio::sync::mpsc;
use tokio::sync::mpsc::unbounded_channel;
use tokio::task::JoinSet;
use tokio::time::sleep;
use tracing::{Instrument, debug, debug_span, info, trace, warn};
use webrtc::data_channel::{DataChannel, DataChannelEvent};
use webrtc::peer_connection::PeerConnection;

use crate::api::stream::create_control_packet_config;
use crate::app::AppError;
use crate::app::upstream::InputSender;

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
    on_main_channel_event: mpsc::UnboundedReceiver<DataChannelEvent>,
    on_failure: mpsc::Receiver<()>,
    on_failure_sender: mpsc::Sender<()>,
    input: InputSender,
    tasks: JoinSet<()>,
    on_send: mpsc::UnboundedSender<BytesMut>,
    config: ControlPacketConfig,
}

impl ControlChannel {
    pub async fn new(peer: &dyn PeerConnection, input: InputSender) -> Result<Self, AppError> {
        let channel = peer.create_data_channel("moonlight.control", None).await?;

        let (on_failure_sender, on_failure) = mpsc::channel(1);
        let (on_send, mut on_send_receiver) = unbounded_channel();
        let (on_event_sender, on_event) = unbounded_channel();
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

                    trace!(message = ?message, "sending control message to webrtc peer over data channel");
                    if let Err(err) = channel.send(message).await {
                        warn!(error = %err, "failed to send message over data channel");
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
                    } else if on_event_sender.send(event).is_err() {
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
            config: create_control_packet_config(),
        })
    }

    pub fn try_add_channel(&mut self, label: &str, channel: &Arc<dyn DataChannel>) -> bool {
        if !label.starts_with("moonlight.control.") {
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
                    if let DataChannelEvent::OnMessage(message) = event {
                        if receive_input(&input, &config, &message.data, message.is_string)
                            .await
                            .is_err()
                        {
                            let _ = on_failure.try_send(());
                            break;
                        }
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

        let _ = self.on_send.send(bytes);
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
