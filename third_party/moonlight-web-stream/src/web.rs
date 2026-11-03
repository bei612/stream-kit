use crate::api::bindings::ConfigJs;
use actix_files::Files;
use actix_web::{HttpResponse, dev::HttpServiceFactory, get, services, web::Data};
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
async fn config_js(app: Data<App>) -> HttpResponse {
    let config_json = match serde_json::to_string(&ConfigJs {
        path_prefix: app.config().web_server.url_path_prefix.clone(),
        managed_streaming: app.config().web_server.media_ticket_secret.is_some(),
        control_plane_url: app.config().web_server.control_plane_url.clone(),
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
