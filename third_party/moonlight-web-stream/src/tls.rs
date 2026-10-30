//! One bounded TLS loader for preflight, desired configuration and startup.
use crate::config::Config;
use rustls::{
    ServerConfig,
    pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject},
};
use std::{fs::File, io::Read, sync::Arc};

const PEM_LIMIT: u64 = 1024 * 1024;

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
    let chain = CertificateDer::pem_slice_iter(&read_pem(&certificate.certificate_pem)?)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "TLS certificate PEM is invalid")?;
    let key = PrivateKeyDer::from_pem_slice(&read_pem(&certificate.private_key_pem)?)
        .map_err(|_| "TLS private key PEM is invalid")?;
    let server =
        ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .map_err(|_| "TLS protocol configuration is invalid")?
            .with_no_client_auth()
            .with_single_cert(chain, key)
            .map_err(|_| "TLS certificate or private key is invalid or does not match")?;
    Ok(Some(server))
}
