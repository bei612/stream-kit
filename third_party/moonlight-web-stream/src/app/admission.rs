//! Platform media authority is separate from local gateway accounts and from
//! the node's paired Sunshine identity. No viewer becomes a gateway user.
use super::{
    App, AppError, RequestClient,
    control_state::now_ms,
    host::{AppId, HostId},
    media::{MediaSessionKey, verify_media_ticket},
};
use moonlight_common::{
    high::tokio::MoonlightHost,
    http::{ClientIdentifier, ClientSecret, ServerIdentifier},
};
use std::sync::Arc;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MediaConnection {
    pub key: MediaSessionKey,
    pub session_id: String,
    pub connection_id: String,
}

#[derive(Clone, Debug)]
pub struct MediaAdmission {
    connection: MediaConnection,
}

impl MediaAdmission {
    pub async fn verify(app: &App, token: &str) -> Result<Self, AppError> {
        let secret = app
            .config()
            .web_server
            .media_ticket_secret
            .as_deref()
            .ok_or(AppError::Unauthorized)?;
        let claims = verify_media_ticket(token, secret)?;
        let key = MediaSessionKey {
            host_id: HostId(u32::try_from(claims.host_id).map_err(|_| AppError::Unauthorized)?),
            app_id: AppId(u32::try_from(claims.app_id).map_err(|_| AppError::Unauthorized)?),
        };
        let control = app.media_sessions().control.read().await;
        let now = now_ms();
        if !control.admits(&key, &claims.connection_id, now)
            || !control
                .session(&key, now)
                .is_some_and(|s| s.session_id == claims.session_id)
        {
            return Err(AppError::Unauthorized);
        }
        Ok(Self {
            connection: MediaConnection {
                key,
                session_id: claims.session_id,
                connection_id: claims.connection_id,
            },
        })
    }

    pub fn connection(&self) -> &MediaConnection {
        &self.connection
    }

    pub async fn require_live(&self, app: &App) -> Result<(), AppError> {
        let state = app.media_sessions().control.read().await;
        let now = now_ms();
        let connection = &self.connection;
        if state.admits(&connection.key, &connection.connection_id, now)
            && state
                .session(&connection.key, now)
                .is_some_and(|s| s.session_id == connection.session_id)
        {
            Ok(())
        } else {
            Err(AppError::Unauthorized)
        }
    }

    pub fn authorize_target(&self, key: &MediaSessionKey) -> Result<(), AppError> {
        if &self.connection.key == key {
            Ok(())
        } else {
            Err(AppError::Forbidden)
        }
    }

    pub async fn open_host(
        &self,
        app: &App,
        key: &MediaSessionKey,
    ) -> Result<Arc<MoonlightHost<RequestClient>>, AppError> {
        self.authorize_target(key)?;
        self.require_live(app).await?;
        let stored = app.inner.storage.get_host(key.host_id).await?;
        let pair = stored.pair_info.ok_or(AppError::HostNotPaired)?;
        let identity = pair
            .client_unique_id
            .filter(|id| !id.trim().is_empty())
            .ok_or(AppError::HostNotPaired)?;
        let host =
            MoonlightHost::<RequestClient>::new(stored.address, stored.http_port, Some(identity))?;
        host.set_identity(
            ClientIdentifier::from_pem(pair.client_certificate),
            ClientSecret::from_pem(pair.client_private_key),
            ServerIdentifier::from_pem(pair.server_certificate),
        )
        .await?;
        Ok(Arc::new(host))
    }
}
