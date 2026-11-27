//! Converts message heads at the h2 boundary. Adapted from Actix PR #4321.

use crate::{error::ParseError, header, RequestHead, Version};

pub(super) fn apply_request(
    parts: http_v1::request::Parts,
    head: &mut RequestHead,
) -> Result<(), ParseError> {
    head.method = parts
        .method
        .as_str()
        .parse()
        .map_err(|_| ParseError::Method)?;
    head.uri = parts.uri.to_string().parse().map_err(ParseError::Uri)?;
    head.version = Version::HTTP_2;

    for (name, value) in &parts.headers {
        let name = header::HeaderName::from_bytes(name.as_str().as_bytes())
            .map_err(|_| ParseError::Header)?;
        let mut converted =
            header::HeaderValue::from_bytes(value.as_bytes()).map_err(|_| ParseError::Header)?;
        converted.set_sensitive(value.is_sensitive());
        head.headers.append(name, converted);
    }

    Ok(())
}

pub(super) fn into_response(response: http::Response<()>) -> http_v1::Response<()> {
    let (parts, ()) = response.into_parts();
    let mut response = http_v1::Response::new(());
    *response.status_mut() = http_v1::StatusCode::from_u16(parts.status.as_u16())
        .expect("http 0.2 and 1.x accept the same status codes");
    *response.version_mut() = http_v1::Version::HTTP_2;

    for (name, value) in &parts.headers {
        let name = http_v1::header::HeaderName::from_bytes(name.as_str().as_bytes())
            .expect("http 0.2 header names are valid in http 1.x");
        let mut converted = http_v1::HeaderValue::from_bytes(value.as_bytes())
            .expect("http 0.2 header values are valid in http 1.x");
        converted.set_sensitive(value.is_sensitive());
        response.headers_mut().append(name, converted);
    }

    response
}
