use super::*;

#[tokio::test]
async fn native_channels_cannot_expand_the_remote_handoff_queue() {
    let (on_data_channel_sender, channels) = mpsc::channel(REMOTE_CHANNEL_LIMIT);
    let (on_track_sender, _tracks) = mpsc::channel(REMOTE_TRACK_LIMIT);
    let handler = Arc::new(WebRtcHandler {
        on_ice_gathering_finished: Notify::new(),
        on_data_channel_sender,
        on_track_sender,
        received_channels: AtomicUsize::new(0),
        received_tracks: AtomicUsize::new(0),
        resource_failed: AtomicBool::new(false),
        peer_state: Mutex::new(RTCPeerConnectionState::New),
    });
    let peer = PeerConnectionBuilder::default()
        .with_handler(handler.clone())
        .with_udp_addrs(vec![
            "127.0.0.1:0"
                .parse::<SocketAddr>()
                .expect("test loopback address"),
        ])
        .with_data_channel_send_buffer_limit(CONTROL_SEND_BUFFER_BYTES)
        .build()
        .await
        .expect("create native peer");
    for index in 0..REMOTE_CHANNEL_LIMIT {
        let channel = peer
            .create_data_channel(&format!("channel-{index}"), None)
            .await
            .expect("create accepted native data channel");
        handler.on_data_channel(channel).await;
    }
    assert!(!handler.resource_failed.load(Ordering::Acquire));
    let extra = peer
        .create_data_channel("excess", None)
        .await
        .expect("create excess native data channel");
    handler.on_data_channel(extra).await;
    assert!(handler.resource_failed.load(Ordering::Acquire));
    assert_eq!(channels.len(), REMOTE_CHANNEL_LIMIT);
    peer.close().await.expect("close native peer");
}
