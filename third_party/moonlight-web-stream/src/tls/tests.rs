use super::*;
use moonlight_common::{
    crypto::rustcrypto::RustCryptoBackend,
    http::{
        ClientInfo,
        box_art::{AppBoxArtEndpoint, AppBoxArtRequest},
        client::{async_client::RequestClient, tokio_hyper::TokioHyperClient},
        pair::PairingCryptoBackend,
    },
};
use std::{
    fs,
    io::Write,
    net::{SocketAddr, TcpListener},
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};

struct Files {
    dir: PathBuf,
    certificate: ConfigSsl,
}

impl Files {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("stream-kit-tls-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).expect("create isolated identity directory");
        Self {
            certificate: ConfigSsl {
                certificate_pem: dir.join("server.pem").to_string_lossy().into_owned(),
                private_key_pem: dir.join("key.pem").to_string_lossy().into_owned(),
            },
            dir,
        }
    }
    fn write(&self, cert: &pem::Pem, key: &pem::Pem) {
        fs::write(&self.certificate.certificate_pem, pem::encode(cert)).expect("write certificate");
        fs::write(&self.certificate.private_key_pem, pem::encode(key)).expect("write key");
    }
}

impl Drop for Files {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn identity() -> (pem::Pem, pem::Pem) {
    let (cert, key) = RustCryptoBackend
        .generate_client_identity()
        .expect("generate real keypair");
    (cert.to_pem(), key.to_pem())
}

struct Server {
    address: SocketAddr,
    stopped: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Server {
    fn new(config: ServerConfig) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind real TLS listener");
        listener.set_nonblocking(true).expect("nonblocking accept");
        let address = listener.local_addr().expect("local address");
        let config = Arc::new(config);
        let stopped = Arc::new(AtomicBool::new(false));
        let stop = stopped.clone();
        let thread = std::thread::spawn(move || {
            while !stop.load(Ordering::Acquire) {
                let (socket, _) = match listener.accept() {
                    Ok(socket) => socket,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(error) => panic!("accept failed: {error}"),
                };
                // Winsock accepts inherit the listener's nonblocking mode.
                socket.set_nonblocking(false).expect("blocking TLS socket");
                socket
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .expect("read timeout");
                socket
                    .set_write_timeout(Some(Duration::from_secs(2)))
                    .expect("write timeout");
                let connection =
                    rustls::ServerConnection::new(config.clone()).expect("server connection");
                let mut tls = rustls::StreamOwned::new(connection, socket);
                let mut bytes = [0; 4096];
                // A client using the replacement pin can arrive before the
                // refresh tick; its certificate mismatch must be rejected.
                if let Err(error) = tls.read(&mut bytes) {
                    eprintln!("native TLS server rejected connection: {error}");
                    continue;
                }
                let _ = tls.write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                );
                let _ = tls.flush();
            }
        });
        Self {
            address,
            stopped,
            thread: Some(thread),
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            thread.join().expect("TLS server stopped");
        }
    }
}

async fn connect(server: &Server, cert: &pem::Pem, key: &pem::Pem) -> bool {
    let client =
        TokioHyperClient::with_certificates(key, cert, cert).expect("create pinned client");
    let result = client
        .send_https_with_bytes::<AppBoxArtEndpoint>(
            ClientInfo {
                unique_id: "tls-renewal-test".into(),
                uuid: uuid::Uuid::new_v4(),
            },
            &server.address.to_string(),
            &AppBoxArtRequest {
                app_id: moonlight_common::AppId(1),
                asset_type: 2,
                asset_idx: 0,
            },
        )
        .await;
    if let Err(error) = &result {
        eprintln!("native TLS request failed: {error:?}");
    }
    result.is_ok()
}

#[tokio::test]
async fn native_tls_accepts_renewed_identity_without_rebinding_and_retains_valid_identity_on_error()
{
    let _ = rustls::crypto::ring::default_provider().install_default();
    let files = Files::new();
    let (first_cert, first_key) = identity();
    let (next_cert, next_key) = identity();
    files.write(&first_cert, &first_key);
    let initial = read_identity(&files.certificate, None)
        .expect("load initial")
        .expect("identity");
    assert!(
        read_identity(&files.certificate, Some(initial.0))
            .expect("unchanged")
            .is_none()
    );
    let runtime = start_refresh(files.certificate.clone(), Duration::from_millis(20))
        .expect("start live TLS");
    let server = Server::new(runtime.server_config());
    assert!(connect(&server, &first_cert, &first_key).await);

    // An incomplete key rotation is never published.
    fs::write(&files.certificate.certificate_pem, pem::encode(&next_cert))
        .expect("replace only cert");
    assert!(read_identity(&files.certificate, Some(initial.0)).is_err());
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert!(connect(&server, &first_cert, &first_key).await);

    fs::write(&files.certificate.private_key_pem, pem::encode(&next_key))
        .expect("complete rotation");
    tokio::time::timeout(Duration::from_secs(5), async {
        while !connect(&server, &next_cert, &next_key).await {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("same listener adopted renewed identity");
    assert!(
        !connect(&server, &first_cert, &first_key).await,
        "old pin must fail after rotation"
    );

    fs::write(
        &files.certificate.certificate_pem,
        vec![0u8; (PEM_LIMIT + 1) as usize],
    )
    .expect("write oversized input");
    assert!(read_identity(&files.certificate, None).is_err());
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert!(connect(&server, &next_cert, &next_key).await);
    fs::remove_file(&files.certificate.private_key_pem).expect("remove key");
    assert!(read_identity(&files.certificate, None).is_err());
    assert!(connect(&server, &next_cert, &next_key).await);

    let refresh = runtime.refresh.abort_handle();
    drop(runtime);
    tokio::time::timeout(Duration::from_secs(2), async {
        while !refresh.is_finished() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("reload task belongs to TLS runtime");
}

#[test]
fn disabled_tls_does_not_start_refresh_and_invalid_startup_fails() {
    let mut config = Config::default();
    assert!(load(&config).expect("disabled").is_none());
    assert!(start(&config).expect("disabled").is_none());
    let files = Files::new();
    config.web_server.certificate = Some(files.certificate.clone());
    assert!(load(&config).is_err());
    assert!(start(&config).is_err());
}
