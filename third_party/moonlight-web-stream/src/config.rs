use std::{
    net::{Ipv4Addr, SocketAddr, SocketAddrV4},
    num::ParseIntError,
    str::FromStr,
    time::Duration,
};

use log::LevelFilter;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::api::bindings::RtcIceServer;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Config {
    #[serde(default)]
    pub data_storage: StorageConfig,
    #[serde(default)]
    pub webrtc: WebRtcConfig,
    #[serde(default)]
    pub web_server: WebServerConfig,
    #[serde(default)]
    pub moonlight: MoonlightConfig,
    #[serde(default)]
    pub log: LogConfig,
    #[serde(default)]
    pub local_audio_targets: Vec<LocalAudioTarget>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocalAudioTarget {
    pub host_id: u32,
    pub app_id: u32,
    pub endpoint: stream_kit_audio_target::EndpointPair,
}

impl Config {
    pub fn validate_audio_targets(&self) -> Result<(), &'static str> {
        let mut apps = std::collections::HashSet::new();
        let mut renders = std::collections::HashSet::new();
        let mut captures = std::collections::HashSet::new();
        for route in &self.local_audio_targets {
            if !apps.insert((route.host_id, route.app_id))
                || !renders.insert(&route.endpoint.render_device_id)
                || !captures.insert(&route.endpoint.capture_device_id)
            {
                return Err(
                    "audio target routes must have unique applications and dedicated devices",
                );
            }
            if route.endpoint.render_device_id.trim().is_empty()
                || route.endpoint.capture_device_id.trim().is_empty()
                || route.endpoint.render_device_id == route.endpoint.capture_device_id
            {
                return Err("audio target requires explicit render and capture endpoint IDs");
            }
        }
        Ok(())
    }
    pub fn local_audio_target(&self, host: u32, app: u32) -> Option<&LocalAudioTarget> {
        self.local_audio_targets
            .iter()
            .find(|target| target.host_id == host && target.app_id == app)
    }
    pub fn validate_audio_host(
        &self,
        host: u32,
        app: u32,
        address: &str,
    ) -> Result<(), &'static str> {
        if self.local_audio_target(host, app).is_some()
            && !address
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
        {
            return Err("native audio target requires a loopback render host on this node");
        }
        Ok(())
    }
}

// -- Log

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogConfig {
    pub level_filter: LevelFilter,
    pub file_path: Option<String>,
    #[serde(default = "default_dev_venator")]
    pub dev_venator: bool,
}

impl Default for LogConfig {
    fn default() -> Self {
        Self {
            level_filter: default_level_filter(),
            file_path: None,
            dev_venator: default_dev_venator(),
        }
    }
}

fn default_level_filter() -> LevelFilter {
    LevelFilter::Info
}

fn default_dev_venator() -> bool {
    false
}

// -- Data Storage
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
#[serde(rename_all = "camelCase")]
pub enum StorageConfig {
    Json {
        path: String,
        session_expiration_check_interval: Duration,
    },
}

impl Default for StorageConfig {
    fn default() -> Self {
        StorageConfig::Json {
            path: "server/data.json".to_string(),
            session_expiration_check_interval: default_session_expiration_check_interval(),
        }
    }
}

fn default_session_expiration_check_interval() -> Duration {
    Duration::from_mins(5)
}

// -- WebRTC Config

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebRtcConfig {
    #[serde(default = "default_ice_servers")]
    pub ice_servers: Vec<RtcIceServer>,
    #[serde(default)]
    pub ice_server_script: Option<String>,
    #[serde(default)]
    pub port_range: Option<PortRange>,
    #[serde(default)]
    pub nat_1to1: Option<WebRtcNat1To1Mapping>,
    #[serde(default = "default_include_loopback_candidates")]
    pub include_loopback_candidates: bool,
}

impl Default for WebRtcConfig {
    fn default() -> Self {
        Self {
            ice_servers: default_ice_servers(),
            ice_server_script: None,
            port_range: None,
            nat_1to1: None,
            include_loopback_candidates: default_include_loopback_candidates(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebRtcNat1To1Mapping {
    pub ips: Vec<String>,
    pub ice_candidate_type: WebRtcNat1To1IceCandidateType,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum WebRtcNat1To1IceCandidateType {
    #[serde(rename = "srflx")]
    Srflx,
    #[serde(rename = "host")]
    Host,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortRange {
    pub min: u16,
    pub max: u16,
}

#[derive(Debug, Error)]
pub enum PortRangeFromStrError {
    #[error("the port range must be of format \"MIN:MAX\"")]
    Split,
    #[error("couldn't parse number: {0}")]
    ParseNumber(#[from] ParseIntError),
}

impl FromStr for PortRange {
    type Err = PortRangeFromStrError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let (min, max) = s.split_once(":").ok_or(PortRangeFromStrError::Split)?;
        Ok(PortRange {
            min: min.parse().map_err(PortRangeFromStrError::ParseNumber)?,
            max: max.parse().map_err(PortRangeFromStrError::ParseNumber)?,
        })
    }
}

fn default_ice_servers() -> Vec<RtcIceServer> {
    vec![RtcIceServer {
        is_default: true,
        urls: vec![
            // Google
            "stun:stun.l.google.com:19302".to_string(),
            "stun:stun1.l.google.com:3478".to_string(),
        ],
        ..Default::default()
    }]
}
fn default_include_loopback_candidates() -> bool {
    true
}

// -- Web Server Config

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebServerConfig {
    #[serde(default = "default_bind_address")]
    pub bind_address: SocketAddr,
    pub certificate: Option<ConfigSsl>,
    #[serde(default)]
    pub url_path_prefix: String,
    #[serde(default = "default_session_cookie_secure")]
    pub session_cookie_secure: bool,
    #[serde(default = "default_session_cookie_expiration")]
    pub session_cookie_expiration: Duration,
    pub first_login_create_admin: bool,
    pub first_login_assign_global_hosts: bool,
    pub forwarded_header: Option<ForwardedHeaders>,
    #[serde(default)]
    pub media_ticket_secret: Option<String>,
    /// Public control-plane base URL used by managed browser connections.
    #[serde(default)]
    pub control_plane_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigSsl {
    pub private_key_pem: String,
    pub certificate_pem: String,
}

impl WebServerConfig {
    pub fn validate_managed(&self) -> Result<(), &'static str> {
        if let Some(secret) = &self.media_ticket_secret {
            if secret.len() < 32 {
                return Err("media_ticket_secret must contain at least 32 bytes");
            }
            let address = self
                .control_plane_url
                .as_deref()
                .ok_or("managed streaming requires control_plane_url")?;
            let uri: actix_web::http::Uri =
                address.parse().map_err(|_| "invalid control_plane_url")?;
            if !matches!(uri.scheme_str(), Some("http" | "https"))
                || uri.host().is_none()
                || uri.authority().is_some_and(|a| a.as_str().contains('@'))
                || uri.query().is_some()
                || address.contains('#')
            {
                return Err(
                    "control_plane_url must be an absolute HTTP(S) URL without credentials, query or fragment",
                );
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod managed_config_tests {
    use super::*;
    #[test]
    fn managed_configuration_requires_explicit_trust_and_control_endpoint() {
        let mut config = WebServerConfig::default();
        assert!(config.validate_managed().is_ok());
        config.media_ticket_secret = Some("s".repeat(32));
        assert!(config.validate_managed().is_err());
        for address in ["https://control.example", "http://127.0.0.1:9000/platform"] {
            config.control_plane_url = Some(address.into());
            assert!(config.validate_managed().is_ok());
        }
        for address in [
            "file:///tmp/server",
            "https://user:secret@control.example",
            "https://control.example?secret",
            "https://control.example#secret",
            "/relative",
        ] {
            config.control_plane_url = Some(address.into());
            assert!(config.validate_managed().is_err());
        }
        config.control_plane_url = Some("https://control.example".into());
        config.media_ticket_secret = Some("short".into());
        assert!(config.validate_managed().is_err());
    }
}

impl Default for WebServerConfig {
    fn default() -> Self {
        Self {
            bind_address: default_bind_address(),
            certificate: None,
            url_path_prefix: "".to_string(),
            session_cookie_secure: default_session_cookie_secure(),
            session_cookie_expiration: default_session_cookie_expiration(),
            first_login_create_admin: true,
            first_login_assign_global_hosts: true,
            forwarded_header: None,
            media_ticket_secret: None,
            control_plane_url: None,
        }
    }
}

fn default_bind_address() -> SocketAddr {
    SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 8080))
}
fn default_session_cookie_secure() -> bool {
    false
}
fn default_session_cookie_expiration() -> Duration {
    const DAY_SECONDS: u64 = 24 * 60 * 60;

    Duration::from_secs(DAY_SECONDS)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForwardedHeaders {
    pub username_header: String,
    #[serde(default = "default_forwarded_headers_auto_create_user")]
    pub auto_create_missing_user: bool,
    #[serde(default = "default_forwarded_headers_ignore_case")]
    pub ignore_case: bool,
}

impl Default for ForwardedHeaders {
    fn default() -> Self {
        Self {
            username_header: "X-Forwarded-User".to_string(),
            auto_create_missing_user: default_forwarded_headers_auto_create_user(),
            ignore_case: default_forwarded_headers_ignore_case(),
        }
    }
}

fn default_forwarded_headers_auto_create_user() -> bool {
    true
}

fn default_forwarded_headers_ignore_case() -> bool {
    false
}

// -- Moonlight

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MoonlightConfig {
    #[serde(default = "default_moonlight_http_port")]
    pub default_http_port: u16,
    #[serde(default = "default_pair_device_name")]
    pub pair_device_name: String,
}

impl Default for MoonlightConfig {
    fn default() -> Self {
        Self {
            default_http_port: default_moonlight_http_port(),
            pair_device_name: default_pair_device_name(),
        }
    }
}

fn default_moonlight_http_port() -> u16 {
    47989
}

fn default_pair_device_name() -> String {
    "roth".to_string()
}

#[cfg(test)]
mod audio_target_tests {
    use super::*;
    fn route() -> LocalAudioTarget {
        LocalAudioTarget {
            host_id: 1,
            app_id: 2,
            endpoint: stream_kit_audio_target::EndpointPair {
                render_device_id: "dedicated-render".into(),
                capture_device_id: "dedicated-capture".into(),
            },
        }
    }
    #[test]
    fn audio_devices_cannot_be_shared_across_unrelated_applications() {
        let mut config = Config::default();
        config.local_audio_targets.push(route());
        assert!(config.validate_audio_targets().is_ok());
        let mut second = route();
        second.app_id = 3;
        config.local_audio_targets.push(second);
        assert!(config.validate_audio_targets().is_err());
        config.local_audio_targets.pop();
        config.local_audio_targets[0]
            .endpoint
            .capture_device_id
            .clear();
        assert!(config.validate_audio_targets().is_err());
    }
    #[test]
    fn local_audio_never_targets_a_remote_render_host() {
        let mut config = Config::default();
        config.local_audio_targets.push(route());
        for address in ["127.0.0.1", "::1"] {
            assert!(config.validate_audio_host(1, 2, address).is_ok());
        }
        for address in ["192.168.1.20", "example.test", "localhost", "::"] {
            assert!(config.validate_audio_host(1, 2, address).is_err());
        }
        assert!(config.validate_audio_host(1, 3, "192.168.1.20").is_ok());
    }
}
