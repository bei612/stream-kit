use moonlight_common::{
    ServerVersion,
    crypto::rustcrypto::RustCryptoBackend,
    stream::{
        proto::{
            runtime::{Receive, UdpStream},
            video::{
                VideoStream, VideoStreamConfig, VideoStreamEvent,
                depayloader::{VideoDepayloader, VideoDepayloaderConfig},
                payloader::{VideoPayloader, VideoPayloaderConfig},
            },
        },
        video::{ServerFrameType, VideoFormat},
    },
};
use sans_io_time::Instant;
use std::{sync::Arc, time::Duration};

#[test]
fn native_video_reassembly_bounds_missing_frames_and_preserves_delivery() {
    let version = ServerVersion::new(7, 1, 431, -1);
    let config = VideoDepayloaderConfig {
        packet_size: 1200,
        format: VideoFormat::Av1Main8,
        server_version: version,
    };
    let mut payload = VideoPayloader::new(VideoPayloaderConfig {
        server_version: version,
        packet_size: 1200,
        max_data_shards_per_block: 100,
        fec: None,
    });
    let source = "127.0.0.1:48000".parse().unwrap();
    let mut stream = VideoStream::new(
        Instant::ZERO,
        VideoStreamConfig {
            addr: source,
            queue: config.clone(),
            fps: 60,
            sunshine_ping: None,
            sunshine_encryption: None,
        },
        Arc::new(RustCryptoBackend),
    );
    let frame = vec![7; 4096];
    for index in 0..20000u32 {
        let now = Instant::ZERO + Duration::from_micros(index as u64 * 16667);
        payload
            .push_frame(
                index * 1500,
                None,
                if index == 0 {
                    ServerFrameType::Idr
                } else {
                    ServerFrameType::PFrame
                },
                &frame,
            )
            .unwrap();
        while let Some(packet) = payload.poll_packet() {
            stream
                .handle_receive(
                    now,
                    Receive {
                        source,
                        data: &packet,
                    },
                )
                .unwrap();
        }
        assert!(matches!(
            stream.poll_event(),
            Some(VideoStreamEvent::OnFrame(_))
        ));
        assert!(stream.poll_event().is_none());
    }
    // A partially received *current* frame uses the 100 ms deadline, not frame 0.
    payload
        .push_frame(0, None, ServerFrameType::PFrame, &frame)
        .unwrap();
    let now = Instant::ZERO + Duration::from_micros(20000 * 16667);
    stream
        .handle_receive(
            now,
            Receive {
                source,
                data: &payload.poll_packet().unwrap(),
            },
        )
        .unwrap();
    assert_eq!(
        stream.poll_timeout(),
        Some(now + Duration::from_millis(100))
    );
    while payload.poll_packet().is_some() {}

    let mut receiver = VideoDepayloader::new(config);
    for _ in 0..20000 {
        payload
            .push_frame(0, None, ServerFrameType::PFrame, &frame)
            .unwrap();
        receiver
            .handle_packet(&payload.poll_packet().unwrap())
            .unwrap();
        while payload.poll_packet().is_some() {} // actual packet loss
        assert!(receiver.known_frames().count() <= 64);
    }
    assert_eq!(receiver.known_frames().count(), 64);
}
