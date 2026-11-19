//! One bounded TLS loader for preflight, startup and live certificate renewal.
use crate::config::{Config, ConfigSsl};
use rustls::{
    ServerConfig,
    pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject},
    server::{ClientHello, ResolvesServerCert},
    sign::CertifiedKey,
};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::Read,
    sync::{Arc, RwLock},
    time::Duration,
};
use tokio::task::JoinHandle;
use tracing::{info, warn};

const PEM_LIMIT: u64 = 1024 * 1024;
const REFRESH_INTERVAL: Duration = Duration::from_secs(5);
type Fingerprint = ([u8; 32], [u8; 32]);

#[derive(Debug)]
struct CertificateResolver(RwLock<Arc<CertifiedKey>>);

impl ResolvesServerCert for CertificateResolver {
    fn resolve(&self, _client_hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        Some(
            self.0
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone(),
        )
    }
}

/// Owns the renewal task for exactly as long as the HTTPS listener is alive.
/// Existing TLS/media connections retain their established state; only new
/// handshakes observe the new identity. Invalid replacements retain the last
/// validated key pair and never downgrade the listener to plaintext.
pub struct Runtime {
    config: ServerConfig,
    refresh: JoinHandle<()>,
}

impl Runtime {
    pub fn server_config(&self) -> ServerConfig {
        self.config.clone()
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        self.refresh.abort();
    }
}

fn read_pem(path: &str) -> Result<Vec<u8>, &'static str> {
    let file = File::open(path).map_err(|_| "TLS file is unavailable")?;
    let metadata = file.metadata().map_err(|_| "TLS file is unavailable")?;
    if !metadata.is_file() || metadata.len() > PEM_LIMIT {
        return Err("TLS file must be a regular file no larger than 1 MiB");
    }
    let mut bytes = Vec::new();
    file.take(PEM_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "TLS file is unavailable")?;
    if bytes.len() as u64 > PEM_LIMIT {
        return Err("TLS file exceeds 1 MiB");
    }
    Ok(bytes)
}

/// Resolves paths against the process working directory, as native startup does.
/// Checks parsing and key correspondence, not expiry, hostname or public trust.
/// Errors deliberately exclude paths, PEM contents and library diagnostics.
pub fn load(config: &Config) -> Result<Option<ServerConfig>, &'static str> {
    let Some(certificate) = &config.web_server.certificate else {
        return Ok(None);
    };
    let (_, key) = read_identity(certificate, None)?.ok_or("TLS identity is missing")?;
    server_config(Arc::new(CertificateResolver(RwLock::new(key)))).map(Some)
}

fn server_config(resolver: Arc<CertificateResolver>) -> Result<ServerConfig, &'static str> {
    Ok(
        ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .map_err(|_| "TLS protocol configuration is invalid")?
            .with_no_client_auth()
            .with_cert_resolver(resolver),
    )
}

fn read_identity(
    certificate: &ConfigSsl,
    previous: Option<Fingerprint>,
) -> Result<Option<(Fingerprint, Arc<CertifiedKey>)>, &'static str> {
    let cert_bytes = read_pem(&certificate.certificate_pem)?;
    let key_bytes = read_pem(&certificate.private_key_pem)?;
    let fingerprint = (
        Sha256::digest(&cert_bytes).into(),
        Sha256::digest(&key_bytes).into(),
    );
    if previous == Some(fingerprint) {
        return Ok(None);
    }
    let chain = CertificateDer::pem_slice_iter(&cert_bytes)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "TLS certificate PEM is invalid")?;
    let key =
        PrivateKeyDer::from_pem_slice(&key_bytes).map_err(|_| "TLS private key PEM is invalid")?;
    let certified = CertifiedKey::from_der(chain, key, &rustls::crypto::ring::default_provider())
        .map_err(|_| "TLS certificate or private key is invalid or does not match")?;
    Ok(Some((fingerprint, Arc::new(certified))))
}

pub fn start(config: &Config) -> Result<Option<Runtime>, &'static str> {
    config
        .web_server
        .certificate
        .as_ref()
        .map(|certificate| start_refresh(certificate.clone(), REFRESH_INTERVAL))
        .transpose()
}

fn start_refresh(certificate: ConfigSsl, interval: Duration) -> Result<Runtime, &'static str> {
    let (mut fingerprint, key) =
        read_identity(&certificate, None)?.ok_or("TLS identity is missing")?;
    let resolver = Arc::new(CertificateResolver(RwLock::new(key)));
    let config = server_config(resolver.clone())?;
    let refresh = tokio::spawn(async move {
        let mut ticks = tokio::time::interval_at(tokio::time::Instant::now() + interval, interval);
        ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut failed = false;
        loop {
            ticks.tick().await;
            let files = certificate.clone();
            // At most one bounded disk operation is outstanding. Handshakes
            // only read an Arc under the lock and never wait for filesystem IO.
            let result =
                tokio::task::spawn_blocking(move || read_identity(&files, Some(fingerprint)))
                    .await
                    .unwrap_or(Err("TLS refresh worker failed"));
            match result {
                Ok(identity) => {
                    if let Some((next_fingerprint, key)) = identity {
                        *resolver
                            .0
                            .write()
                            .unwrap_or_else(|poisoned| poisoned.into_inner()) = key;
                        fingerprint = next_fingerprint;
                        info!("HTTPS certificate renewed for new connections");
                    } else if failed {
                        info!("HTTPS certificate files recovered");
                    }
                    failed = false;
                }
                Err(error) => {
                    if !failed {
                        warn!(
                            error,
                            "HTTPS certificate reload failed; retaining last valid identity"
                        );
                    }
                    failed = true;
                }
            }
        }
    });
    Ok(Runtime { config, refresh })
}

#[cfg(test)]
mod tests;
