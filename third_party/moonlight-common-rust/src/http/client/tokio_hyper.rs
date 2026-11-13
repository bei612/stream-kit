use std::{str::FromStr, sync::Arc, time::Duration};

use bytes::Bytes;
use http_body_util::{BodyExt, Empty};
use hyper::{Response, body::Incoming};
use hyper_rustls::HttpsConnector;
use hyper_util::{
    client::legacy::{Client, connect::HttpConnector},
    rt::TokioExecutor,
};
use rustls::{
    ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme,
    client::{
        Resumption, WebPkiServerVerifier,
        danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    },
    pki_types::{
        CertificateDer, PrivateKeyDer, ServerName, UnixTime,
        pem::{PemObject, SectionKind},
    },
};
use tracing::{Level, debug, instrument};

use crate::{
    error::Error,
    http::{
        ClientInfo, Endpoint, TextResponse,
        client::{
            DEFAULT_LONG_TIMEOUT, DEFAULT_TIMEOUT, async_client::RequestClient,
            hyperlike::build_url,
        },
    },
};

impl From<hyper::Error> for Error {
    fn from(value: hyper::Error) -> Self {
        if value.is_timeout() {
            return Self::ConnectionTimeout;
        } else if value.is_shutdown() || value.is_canceled() || value.is_closed() {
            return Self::ConnectionFailed;
        }

        Self::Other(value.into())
    }
}
impl From<hyper_util::client::legacy::Error> for Error {
    fn from(_value: hyper_util::client::legacy::Error) -> Self {
        Self::ConnectionFailed
    }
}
impl From<rustls::Error> for Error {
    fn from(value: rustls::Error) -> Self {
        Self::Other(value.into())
    }
}

#[derive(Debug)]
struct NoHostnameVerifier<Base> {
    base: Base,
    pinned_certificate: CertificateDer<'static>,
}

impl<Base> ServerCertVerifier for NoHostnameVerifier<Base>
where
    Base: ServerCertVerifier,
{
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        // GameStream uses its paired self-signed identity, not a DNS PKI name.
        // Skipping hostname validation must never skip the paired identity.
        if end_entity != &self.pinned_certificate {
            return Err(rustls::Error::InvalidCertificate(
                rustls::CertificateError::ApplicationVerificationFailure,
            ));
        }
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.base.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.base.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.base.supported_verify_schemes()
    }
}

fn build_http_connector(timeout: Duration) -> HttpConnector {
    let mut http = HttpConnector::new();
    http.set_connect_timeout(Some(timeout));
    http.enforce_http(false);
    http
}

fn build_empty_rustls_connector(timeout: Duration) -> hyper_rustls::HttpsConnector<HttpConnector> {
    let config = ClientConfig::builder()
        .with_root_certificates(RootCertStore::empty())
        .with_no_client_auth();

    hyper_rustls::HttpsConnectorBuilder::new()
        .with_tls_config(config)
        .https_or_http()
        .enable_http1()
        .wrap_connector(build_http_connector(timeout))
}

fn build_client(
    https_connector: HttpsConnector<HttpConnector>,
) -> Client<HttpsConnector<HttpConnector>, Empty<Bytes>> {
    Client::builder(TokioExecutor::new())
        .pool_max_idle_per_host(0)
        .build(https_connector)
}

async fn response_to_bytes(mut response: Response<Incoming>) -> Result<Vec<u8>, Error> {
    const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
    let mut bytes = Vec::new();

    // Stream the body, writing each chunk to our response buffer
    while let Some(next) = response.frame().await {
        let frame = next?;
        if let Some(chunk) = frame.data_ref() {
            if chunk.len() > MAX_RESPONSE_BYTES - bytes.len() {
                return Err(Error::Other("GameStream response exceeds 8 MiB".into()));
            }
            bytes.extend_from_slice(chunk);
        }
    }

    Ok(bytes)
}

#[derive(Debug, Clone)]
pub struct TokioHyperClient {
    client: Client<HttpsConnector<HttpConnector>, Empty<Bytes>>,
    timeout: Duration,
}

impl TokioHyperClient {
    async fn get_bytes(&self, uri: hyper::Uri) -> Result<Vec<u8>, Error> {
        // A connect deadline alone leaves stalled headers/bodies and their
        // calling tasks alive indefinitely. Bound the complete exchange.
        tokio::time::timeout(self.timeout, async {
            response_to_bytes(self.client.get(uri).await?).await
        })
        .await
        .map_err(|_| Error::ConnectionTimeout)?
    }
}

impl RequestClient for TokioHyperClient {
    fn with_defaults_long_timeout() -> Result<Self, Error> {
        let client = build_client(build_empty_rustls_connector(DEFAULT_LONG_TIMEOUT));

        Ok(Self {
            client,
            timeout: DEFAULT_LONG_TIMEOUT,
        })
    }

    fn with_defaults() -> Result<Self, Error> {
        let client = build_client(build_empty_rustls_connector(DEFAULT_TIMEOUT));

        Ok(Self {
            client,
            timeout: DEFAULT_TIMEOUT,
        })
    }

    #[cfg_attr(not(feature = "__tracing_sensitive"), instrument(level = Level::DEBUG, skip_all, err))]
    #[cfg_attr(feature = "__tracing_sensitive", instrument(level = Level::DEBUG, skip_all, err))]
    fn with_certificates(
        client_private_key: &pem::Pem,
        client_certificate: &pem::Pem,
        server_certificate: &pem::Pem,
    ) -> Result<Self, Error> {
        // Client
        if !client_private_key.tag().eq_ignore_ascii_case("PRIVATE KEY") {
            return Err(Error::Other("".into()));
        }
        let private_key = PrivateKeyDer::from_pem(
            SectionKind::PrivateKey,
            client_private_key.contents().to_vec(),
        )
        .ok_or(Error::Other("invalid private key".to_string().into()))?
        .clone_key();

        let certificate = CertificateDer::from_slice(client_certificate.contents()).into_owned();

        // Server
        let mut root_certificates = RootCertStore::empty();
        root_certificates.add(CertificateDer::from_slice(server_certificate.contents()))?;
        let root_certificates = Arc::new(root_certificates);

        // Create Config
        let mut config = ClientConfig::builder()
            .with_root_certificates(root_certificates.clone())
            .with_client_auth_cert(vec![certificate], private_key)?;

        // Disable resumption, Sunshine cannot handle them
        config.resumption = Resumption::disabled();

        // Create custom server verifier that doesn't care about host names
        let verifier = NoHostnameVerifier {
            pinned_certificate: CertificateDer::from_slice(server_certificate.contents())
                .into_owned(),
            // The builder doesn't store the Arc reference anywhere so we can move the value out of the Arc
            #[allow(clippy::unwrap_used)]
            base: Arc::try_unwrap(
                WebPkiServerVerifier::builder(root_certificates)
                    .build()
                    .map_err(Error::other)?,
            )
            .unwrap(),
        };
        config
            .dangerous()
            .set_certificate_verifier(Arc::new(verifier));

        // Build the hyper rustls connector
        let https_connector = hyper_rustls::HttpsConnectorBuilder::new()
            .with_tls_config(config)
            .https_or_http()
            .enable_http1()
            .wrap_connector(build_http_connector(DEFAULT_TIMEOUT));

        // Build Client
        let client = build_client(https_connector);

        Ok(Self {
            client,
            timeout: DEFAULT_TIMEOUT,
        })
    }

    #[instrument(level = Level::DEBUG, skip(self, request), fields(path = E::path()), err)]
    async fn send_http<E>(
        &self,
        client_info: ClientInfo,
        hostport: &str,
        request: &E::Request,
    ) -> Result<E::Response, Error>
    where
        E: Endpoint,
        E::Request: Sync,
        E::Response: TextResponse,
    {
        let url = build_url::<E>(false, client_info, hostport, request)?;

        debug!(url = %url, "sending request");

        let response_bytes = self.get_bytes(url).await?;
        let response_text = String::from_utf8_lossy(&response_bytes);

        debug!(response = ?response_text, "received response");

        E::Response::from_str(&response_text)
    }

    #[instrument(level = Level::DEBUG, skip(self, request), fields(path = E::path()), err)]
    async fn send_https<E>(
        &self,
        client_info: ClientInfo,
        hostport: &str,
        request: &E::Request,
    ) -> Result<E::Response, Error>
    where
        E: Endpoint,
        E::Request: Sync,
        E::Response: TextResponse,
    {
        let url = build_url::<E>(true, client_info, hostport, request)?;

        debug!(url = %url, "sending request");

        let response_bytes = self.get_bytes(url).await?;
        let response_text = String::from_utf8_lossy(&response_bytes);

        debug!(response = ?response_text, "received response");

        E::Response::from_str(&response_text)
    }

    #[instrument(level = Level::DEBUG, skip(self, request), fields(path = E::path()), err)]
    async fn send_https_with_bytes<E>(
        &self,
        client_info: ClientInfo,
        hostport: &str,
        request: &E::Request,
    ) -> Result<E::Response, Error>
    where
        E: Endpoint<Response = Vec<u8>>,
        E::Request: Sync,
    {
        let url = build_url::<E>(true, client_info, hostport, request)?;

        debug!(url = %url, "sending request");

        let response_bytes = self.get_bytes(url).await?;

        debug!("received response");

        Ok(response_bytes)
    }
}
