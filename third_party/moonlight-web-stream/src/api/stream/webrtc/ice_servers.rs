use crate::{api::bindings::RtcIceServer, config::WebRtcConfig};
use tokio::process::Command;
use tracing::{debug, error};

use crate::app::{App, AppError};

pub async fn generate_ice_servers(app: &App) -> Result<Vec<RtcIceServer>, AppError> {
    // Load ice servers
    let mut ice_servers = app.config().webrtc.ice_servers.clone();

    // Load dynamic ice servers and append them to the current ice servers
    let dynamic_ice_servers = load_dynamic_ice_servers(&app.config().webrtc).await;
    ice_servers.extend_from_slice(&dynamic_ice_servers);

    Ok(ice_servers)
}

async fn load_dynamic_ice_servers(config: &WebRtcConfig) -> Vec<RtcIceServer> {
    let Some(script_command) = config.ice_server_script.as_ref() else {
        debug!("No WebRTC ice server script found");
        return vec![];
    };

    debug!(
        stage = "ice_server_script",
        "running WebRTC ice server script"
    );

    let mut script = Command::new(script_command);

    let output = match script.output().await {
        Ok(value) => value,
        Err(err) => {
            error!(stage = "ice_server_script", kind = ?err.kind(), "failed to run WebRTC ice server script");
            return vec![];
        }
    };

    if !matches!(output.status.code(), None | Some(0)) {
        error!(
            "WebRTC ice server script has a non zero exit code: {}",
            output.status
        );

        return vec![];
    }

    let json: Vec<RtcIceServer> = match serde_json::from_slice(&output.stdout) {
        Ok(value) => value,
        Err(err) => {
            error!(stage = "ice_server_script", category = ?err.classify(), line = err.line(), column = err.column(), "failed to deserialize WebRTC ice server script output");
            return vec![];
        }
    };

    json
}
