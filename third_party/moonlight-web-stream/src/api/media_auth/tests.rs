use super::*;
use crate::app::{
    control_state::{StateEnvelope, now_ms},
    host::HostId,
    stream::{ExternalStreamEvent, Stream},
};
use actix_web::{
    App as HttpApp,
    http::{Method, StatusCode},
    test,
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use sha2::Sha256;

const SECRET: &str = "test-media-admission-secret-at-least-32-bytes";

fn ticket(peer: &str, session: &str, expires: i64) -> String {
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","typ":"MEDIA"}"#);
    let body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&serde_json::json!({
        "purpose":"stream-media", "session_id":session, "connection_id":peer,
        "host_id":2636897928_u32, "app_id":609885969, "role":"viewer", "iat":now_ms()/1000, "exp":expires
    })).expect("serialize ticket"));
    let input = format!("{header}.{body}");
    let mut mac = Hmac::<Sha256>::new_from_slice(SECRET.as_bytes()).expect("HMAC key");
    mac.update(input.as_bytes());
    format!(
        "{input}.{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    )
}

async fn app() -> Data<App> {
    let mut config = crate::config::Config::default();
    let crate::config::StorageConfig::Json { path, .. } = &mut config.data_storage;
    *path = std::env::temp_dir()
        .join(format!(
            "stream-kit-admission-{}.json",
            uuid::Uuid::new_v4()
        ))
        .to_string_lossy()
        .into_owned();
    config.web_server.media_ticket_secret = Some(SECRET.into());
    config.web_server.control_plane_url = Some("https://control.example".into());
    let app = Data::new(App::new(config).await.expect("test app"));
    let mut state: StateEnvelope = serde_json::from_str(include_str!(
        "../../../../../contracts/media-state/v2.fixture.json"
    ))
    .expect("fixture");
    let now = now_ms();
    state.issued_at_ms = now;
    state.expires_at_ms = now + 10000;
    for c in &mut state.sessions[0].connections {
        c.expires_at_ms = now + 10000;
    }
    app.media_sessions()
        .control
        .write()
        .await
        .apply(state, now)
        .expect("publish authority");
    app
}

#[actix_web::test]
async fn invitation_bootstraps_without_login_and_cannot_select_default_admin() {
    let app = app().await;
    let admin = app
        .try_add_first_login("node-owner".into(), "test-only-password".into())
        .await
        .expect("seed legacy admin")
        .into_admin()
        .await
        .expect("admin");
    app.set_default_user(&admin, Some(&admin))
        .await
        .expect("legacy default admin");
    let service = test::init_service(
        HttpApp::new()
            .app_data(app.clone())
            .service(crate::api::api_service()),
    )
    .await;
    let token = ticket("client-a", "session-test", now_ms() / 1000 + 60);
    let response = test::call_service(
        &service,
        test::TestRequest::get()
            .uri("/api/host/stream/profile")
            .insert_header(("x-stream-media-ticket", token.clone()))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get("cache-control").expect("no-store"),
        "no-store"
    );
    let profile: serde_json::Value = test::read_body_json(response).await;
    assert_eq!(profile["permissions"]["allow_add_hosts"], false);
    assert_eq!(profile["permissions"]["allow_transport_websockets"], false);
    assert_eq!(profile["permissions"]["allow_transport_webrtc"], true);
    assert!(profile.get("user").is_none() && profile.get("ty").is_none());
    for uri in ["/api/authenticate", "/api/host/stream/profile"] {
        let response =
            test::call_service(&service, test::TestRequest::get().uri(uri).to_request()).await;
        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "anonymous {uri}"
        );
    }
    let response = test::call_service(
        &service,
        test::TestRequest::get()
            .uri("/api/authenticate")
            .insert_header(("x-stream-media-ticket", token.clone()))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let response = test::call_service(
        &service,
        test::TestRequest::default()
            .method(Method::OPTIONS)
            .uri("/api/host/stream/webrtc")
            .insert_header(("x-stream-media-ticket", token))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
}

#[actix_web::test]
async fn target_session_and_connection_scope_cover_stream_updates_and_revocation() {
    let app = app().await;
    let expiry = now_ms() / 1000 + 60;
    let a = MediaAdmission::verify(&app, &ticket("client-a", "session-test", expiry))
        .await
        .expect("a admitted");
    let b = MediaAdmission::verify(&app, &ticket("client-b", "session-test", expiry))
        .await
        .expect("b admitted");
    for (peer, session, expiry) in [
        ("unknown", "session-test", expiry),
        ("client-a", "other", expiry),
        ("client-a", "session-test", now_ms() / 1000),
    ] {
        assert!(
            MediaAdmission::verify(&app, &ticket(peer, session, expiry))
                .await
                .is_err()
        );
    }
    let mut other = a.connection().key.clone();
    other.host_id = HostId(42);
    assert!(matches!(
        a.open_host(&app, &other).await,
        Err(AppError::Forbidden)
    ));
    let (sender, mut receiver) = tokio::sync::mpsc::channel(4);
    let stream = Stream::new_managed(&app, &a, sender)
        .await
        .expect("register stream");
    assert!(matches!(
        stream.send_media_event(&b, ExternalStreamEvent::Stop).await,
        Err(AppError::Forbidden)
    ));
    let service = test::init_service(
        HttpApp::new()
            .app_data(app.clone())
            .service(crate::api::api_service()),
    )
    .await;
    let uri = format!("/api/host/stream/webrtc/{}", stream.id().0);
    let response = test::call_service(
        &service,
        test::TestRequest::delete()
            .uri(&uri)
            .insert_header((
                "x-stream-media-ticket",
                ticket("client-b", "session-test", expiry),
            ))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let response = test::call_service(
        &service,
        test::TestRequest::patch()
            .uri(&uri)
            .insert_header((
                "x-stream-media-ticket",
                ticket("client-a", "session-test", expiry),
            ))
            .insert_header(("content-type", "application/trickle-ice-sdpfrag"))
            .set_payload("a=candidate:test")
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert!(matches!(
        receiver.recv().await,
        Some(ExternalStreamEvent::WebRTCAddIceCandidate { .. })
    ));
    let response = test::call_service(
        &service,
        test::TestRequest::delete()
            .uri(&uri)
            .insert_header((
                "x-stream-media-ticket",
                ticket("client-a", "session-test", expiry),
            ))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(matches!(
        receiver.recv().await,
        Some(ExternalStreamEvent::Stop)
    ));
    let now = now_ms() + 1;
    app.media_sessions()
        .control
        .write()
        .await
        .apply(
            StateEnvelope {
                schema_version: 2,
                issued_at_ms: now,
                expires_at_ms: now + 10000,
                sessions: vec![],
            },
            now,
        )
        .expect("revoke");
    assert!(a.require_live(&app).await.is_err());
    let response = test::call_service(
        &service,
        test::TestRequest::delete()
            .uri(&uri)
            .insert_header((
                "x-stream-media-ticket",
                ticket("client-a", "session-test", expiry),
            ))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert!(receiver.try_recv().is_err());
}
