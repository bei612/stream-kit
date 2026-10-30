use crate::{
    api::bindings::StreamProfile,
    app::{
        App, AppError, RequestClient, admission::MediaAdmission, media::MediaSessionKey,
        user::AuthenticatedUser,
    },
};
use actix_web::{FromRequest, HttpRequest, HttpResponse, dev::Payload, get, web::Data};
use moonlight_common::high::tokio::MoonlightHost;
use std::{pin::Pin, sync::Arc};

#[cfg(test)]
mod tests;

pub enum StreamAccess {
    Local(AuthenticatedUser),
    Managed(MediaAdmission),
}

impl FromRequest for StreamAccess {
    type Error = AppError;
    type Future = Pin<Box<dyn Future<Output = Result<Self, Self::Error>>>>;
    fn from_request(req: &HttpRequest, payload: &mut Payload) -> Self::Future {
        let Some(app) = req.app_data::<Data<App>>().cloned() else {
            return Box::pin(async { Err(AppError::AppDestroyed) });
        };
        if app.config().web_server.media_ticket_secret.is_some() {
            let token = req
                .headers()
                .get("x-stream-media-ticket")
                .and_then(|h| h.to_str().ok())
                .map(str::to_owned);
            Box::pin(async move {
                let mut access = Self::Managed(
                    MediaAdmission::verify(&app, token.as_deref().ok_or(AppError::Unauthorized)?)
                        .await?,
                );
                access.require_webrtc(&app).await?;
                Ok(access)
            })
        } else {
            let user = AuthenticatedUser::from_request(req, payload);
            Box::pin(async move {
                let mut access = Self::Local(user.await?);
                access.require_webrtc(&app).await?;
                Ok(access)
            })
        }
    }
}

impl StreamAccess {
    pub async fn profile(&mut self, app: &App) -> Result<StreamProfile, AppError> {
        let mut role = match self {
            Self::Local(user) => user.role().await?,
            Self::Managed(_) => app.default_role().await?,
        };
        let mut permissions = role.permissions().await?;
        if matches!(self, Self::Managed(_)) {
            permissions.allow_add_hosts = false;
            permissions.allow_transport_websockets = false;
        }
        Ok(StreamProfile {
            permissions,
            default_settings: role.default_settings().await?,
        })
    }

    async fn require_webrtc(&mut self, app: &App) -> Result<(), AppError> {
        if self.profile(app).await?.permissions.allow_transport_webrtc {
            Ok(())
        } else {
            Err(AppError::Forbidden)
        }
    }

    pub async fn open_host(
        &mut self,
        app: &App,
        key: &MediaSessionKey,
    ) -> Result<Arc<MoonlightHost<RequestClient>>, AppError> {
        match self {
            Self::Managed(admission) => admission.open_host(app, key).await,
            Self::Local(user) => user.host(key.host_id).await?.use_host(user).await,
        }
    }

    pub async fn send_event(
        &mut self,
        stream: &crate::app::stream::Stream,
        event: crate::app::stream::ExternalStreamEvent,
    ) -> Result<(), AppError> {
        match self {
            Self::Local(user) => stream.send_event(user, event).await,
            Self::Managed(admission) => stream.send_media_event(admission, event).await,
        }
    }
}

#[get("/host/stream/profile")]
pub async fn stream_profile(
    app: Data<App>,
    mut access: StreamAccess,
) -> Result<HttpResponse, AppError> {
    Ok(HttpResponse::Ok()
        .insert_header(("Cache-Control", "no-store"))
        .json(access.profile(&app).await?))
}
