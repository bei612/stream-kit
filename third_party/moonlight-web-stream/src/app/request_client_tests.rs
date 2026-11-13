//! Real TLS/socket regressions for the vendored GameStream request client.
use moonlight_common::{
    crypto::rustcrypto::RustCryptoBackend,
    http::{
        ClientInfo,
        box_art::{AppBoxArtEndpoint, AppBoxArtRequest},
        client::{async_client::RequestClient, tokio_hyper::TokioHyperClient},
        pair::PairingCryptoBackend,
    },
};
use rustls::{
    ServerConfig, ServerConnection, StreamOwned,
    pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer},
};
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::Arc,
    time::Duration,
};

#[tokio::test]
async fn paired_tls_identity_and_streamed_response_budget() {
    let (server_cert, server_key) = RustCryptoBackend.generate_client_identity().unwrap();
    let (other_cert, other_key) = RustCryptoBackend.generate_client_identity().unwrap();
    let server_cert = server_cert.to_pem();
    let server_key = server_key.to_pem();
    let other_cert = other_cert.to_pem();
    let other_key = other_key.to_pem();
    let server = Arc::new(
        ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(
                vec![CertificateDer::from(server_cert.contents().to_vec())],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(server_key.contents().to_vec())),
            )
            .unwrap(),
    );
    for (correct_pin, length, expected_ok) in [
        (true, 32, true),
        (false, 32, false),
        (true, 9 * 1024 * 1024, false),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let config = server.clone();
        let serving = std::thread::spawn(move || {
            let (socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            socket
                .set_write_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut tls = StreamOwned::new(ServerConnection::new(config).unwrap(), socket);
            let mut request = [0u8; 4096];
            if tls.read(&mut request).is_err() {
                return;
            }
            // Chunked transfer exercises the body limit without Content-Length.
            if tls
                .write_all(
                    b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
                )
                .is_err()
            {
                return;
            }
            let bytes = vec![b'x'; length];
            let _ = write!(tls, "{:x}\r\n", length);
            let _ = tls.write_all(&bytes);
            let _ = tls.write_all(b"\r\n0\r\n\r\n");
            let _ = tls.flush();
        });
        let pin = if correct_pin {
            &server_cert
        } else {
            &other_cert
        };
        let client = TokioHyperClient::with_certificates(&other_key, &other_cert, pin).unwrap();
        let result = client
            .send_https_with_bytes::<AppBoxArtEndpoint>(
                ClientInfo {
                    unique_id: "resource-review".into(),
                    uuid: uuid::Uuid::new_v4(),
                },
                &address.to_string(),
                &AppBoxArtRequest {
                    app_id: moonlight_common::AppId(1),
                    asset_type: 2,
                    asset_idx: 0,
                },
            )
            .await;
        assert_eq!(
            result.is_ok(),
            expected_ok,
            "pin={correct_pin}, bytes={length}: {result:?}"
        );
        if correct_pin && !expected_ok {
            assert!(
                result
                    .as_ref()
                    .unwrap_err()
                    .to_string()
                    .contains("response exceeds 8 MiB")
            );
        }
        if !correct_pin {
            assert!(!matches!(
                result,
                Err(moonlight_common::error::Error::ConnectionTimeout)
            ));
        }
        if let Ok(bytes) = result {
            assert_eq!(bytes.len(), length);
        }
        serving.join().unwrap();
    }
}
