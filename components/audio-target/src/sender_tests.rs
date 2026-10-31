use super::*;
use tokio::net::TcpListener;
use tokio_tungstenite::accept_hdr_async;

struct VerifyHeader;
impl tokio_tungstenite::tungstenite::handshake::server::Callback for VerifyHeader {
    fn on_request(
        self,
        request: &tokio_tungstenite::tungstenite::handshake::server::Request,
        response: tokio_tungstenite::tungstenite::handshake::server::Response,
    ) -> Result<
        tokio_tungstenite::tungstenite::handshake::server::Response,
        tokio_tungstenite::tungstenite::handshake::server::ErrorResponse,
    > {
        assert_eq!(request.headers()["authorization"], "Bearer test-admission");
        Ok(response)
    }
}

fn binding() -> Binding {
    serde_json::from_value(
        serde_json::from_str::<serde_json::Value>(include_str!(
            "../../../contracts/audio-devices/remote-microphone-v1.fixture.json"
        ))
        .unwrap()["claims"]
            .clone(),
    )
    .unwrap()
}

#[tokio::test]
async fn socket_transmits_pcm_and_binding_change_closes_it() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/audio", listener.local_addr().unwrap());
    let (observed, received) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = accept_hdr_async(stream, VerifyHeader).await.unwrap();
        let Message::Binary(bytes) = socket.next().await.unwrap().unwrap() else {
            panic!("binary PCM expected")
        };
        observed.send(bytes).unwrap();
        let closed = tokio::time::timeout(Duration::from_secs(2), socket.next())
            .await
            .unwrap();
        assert!(!matches!(closed, Some(Ok(Message::Binary(_)))));
    });
    let binding = binding();
    let sender = Sender::connect(
        &url,
        "test-admission",
        binding.clone(),
        Instant::now() + Duration::from_secs(10),
    )
    .await
    .unwrap();
    assert!(!sender.submit(
        &binding,
        &[0.; FRAME_SAMPLES],
        Instant::now() + Duration::from_secs(1)
    ));
    assert!(!sender.submit(
        &binding,
        &[0.; FRAME_SAMPLES],
        Instant::now() - Duration::from_secs(1)
    ));
    assert!(sender.submit(
        &binding,
        &[0.25; FRAME_SAMPLES],
        Instant::now() - Duration::from_millis(10)
    ));
    let bytes = tokio::time::timeout(Duration::from_secs(2), received)
        .await
        .unwrap()
        .unwrap();
    let captured = u64::from_le_bytes(bytes[28..36].try_into().unwrap());
    let generation = Generation {
        target: binding.target_epoch,
        controller: binding.control_epoch,
    };
    let mut samples = [0.; FRAME_SAMPLES];
    wire::Receiver::new(generation)
        .unwrap()
        .decode(&bytes, captured + 10, &mut samples)
        .unwrap();
    assert!(samples.iter().all(|value| *value == 0.25));
    assert!(sender.renew(&binding, Instant::now() + Duration::from_secs(10)));
    let mut changed = binding.clone();
    changed.control_epoch += 1;
    assert!(!sender.renew(&changed, Instant::now() + Duration::from_secs(10)));
    assert!(!sender.renew(&binding, Instant::now() + Duration::from_secs(10)));
    assert!(!sender.submit(&binding, &[0.; FRAME_SAMPLES], Instant::now()));
    tokio::time::timeout(Duration::from_secs(3), server)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn rejects_unsafe_urls_before_connecting() {
    for url in [
        "ws://example.com/audio",
        "ws://localhost/audio",
        "wss://user:password@example.com/audio",
        "wss://example.com/audio?token=secret",
        "wss://example.com/audio#fragment",
        "https://example.com/audio",
    ] {
        assert!(
            matches!(
                Sender::connect(
                    url,
                    "token",
                    binding(),
                    Instant::now() + Duration::from_secs(1)
                )
                .await,
                Err(Error::Configuration)
            ),
            "{url}"
        );
    }
}

#[tokio::test]
async fn idle_expiry_closes_without_another_packet() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/audio", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
        let _ = socket.next().await;
    });
    let binding = binding();
    let sender = Sender::connect(
        &url,
        "token",
        binding.clone(),
        Instant::now() + Duration::from_millis(500),
    )
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(2), server)
        .await
        .unwrap()
        .unwrap();
    assert!(sender.is_closed());
    assert!(!sender.renew(&binding, Instant::now() + Duration::from_secs(1)));
}
