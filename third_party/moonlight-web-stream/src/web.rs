use crate::api::bindings::ConfigJs;
use actix_files::Files;
use actix_web::{HttpRequest, HttpResponse, dev::HttpServiceFactory, get, services, web::Data};
use log::warn;
use std::path::{Path, PathBuf};

use crate::app::App;

pub fn web_service() -> impl HttpServiceFactory {
    let executable = std::env::current_exe().ok();
    let directory = std::env::current_dir().unwrap_or_default();
    Files::new("/", asset_directory(executable.as_deref(), &directory)).index_file("index.html")
}

// Native bundles ship dist beside the executable. Service working directories
// and external configuration locations must not change that runtime layout.
fn asset_directory(executable: Option<&Path>, directory: &Path) -> PathBuf {
    let candidates = executable
        .and_then(Path::parent)
        .map(|parent| parent.join("dist"))
        .into_iter()
        .chain([directory.join("dist"), directory.join("static")]);
    for candidate in candidates {
        if candidate.join("index.html").is_file() && candidate.join("stream.html").is_file() {
            return candidate;
        }
    }
    directory.join("dist")
}

pub fn web_config_js_service() -> impl HttpServiceFactory {
    services![config_js]
}
#[get("/config.js")]
async fn config_js(app: Data<App>, request: HttpRequest) -> HttpResponse {
    let config_json = match serde_json::to_string(&ConfigJs {
        path_prefix: app.config().web_server.url_path_prefix.clone(),
        managed_streaming: app.config().web_server.media_ticket_secret.is_some(),
        control_plane_url: app
            .config()
            .web_server
            .control_plane_url
            .as_deref()
            .map(|address| {
                browser_control_url(
                    address,
                    request.headers().get("host").and_then(|v| v.to_str().ok()),
                )
            }),
    }) {
        Ok(value) => value,
        Err(err) => {
            warn!(
                "failed to create the web config.js. The Web Interface might fail to load! {err:?}"
            );

            return HttpResponse::InternalServerError().finish();
        }
    };
    let config_js = format!("window.__CONFIG_JS__ = {config_json}");

    HttpResponse::Ok()
        .append_header(("Content-Type", "text/javascript"))
        .body(config_js)
}

fn browser_control_url(address: &str, request_host: Option<&str>) -> String {
    use actix_web::http::{Uri, uri::Authority};
    let Ok(uri) = address.parse::<Uri>() else {
        return address.to_owned();
    };
    let configured = uri.host().unwrap_or("").trim_matches(['[', ']']);
    let local = configured.eq_ignore_ascii_case("localhost")
        || configured
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback() || ip.is_unspecified());
    if !local {
        return address.to_owned();
    }
    let Some(host) = request_host
        .and_then(|v| v.parse::<Authority>().ok())
        .filter(|v| !v.as_str().contains('@'))
    else {
        return address.to_owned();
    };
    let host_name = host.host();
    let public_host = if host_name.contains(':') && !host_name.starts_with('[') {
        format!("[{host_name}]")
    } else {
        host_name.to_owned()
    };
    let value = uri.port_u16().map_or_else(
        || public_host.clone(),
        |port| format!("{public_host}:{port}"),
    );
    let Ok(authority) = value.parse() else {
        return address.to_owned();
    };
    let mut parts = uri.into_parts();
    parts.authority = Some(authority);
    Uri::from_parts(parts).map_or_else(|_| address.to_owned(), |value| value.to_string())
}

#[cfg(test)]
mod address_tests {
    use super::browser_control_url;
    #[test]
    fn local_control_addresses_follow_the_browser_host() {
        for host in [
            "192.168.3.66:8080",
            "192.168.3.77:8080",
            "render.example:8080",
        ] {
            let name = host.split(':').next().expect("hostname");
            assert_eq!(
                browser_control_url("http://127.0.0.1:9000/control", Some(host)),
                format!("http://{name}:9000/control")
            );
        }
        assert_eq!(
            browser_control_url("http://127.0.0.1:9000/", Some("[::1]:8080")),
            "http://[::1]:9000/"
        );
        assert_eq!(
            browser_control_url("https://control.example:9443", Some("192.168.3.77:8080")),
            "https://control.example:9443"
        );
        assert_eq!(
            browser_control_url("http://127.0.0.1:9000", Some("evil@host:8080")),
            "http://127.0.0.1:9000"
        );
    }
}
