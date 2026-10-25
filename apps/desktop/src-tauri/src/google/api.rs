//! One call to a Google API — Calendar, or Drive for an export (#501) —
//! carrying the access token.
//!
//! The webview says which call — method, path and body, as TypeScript builds
//! them — and the host adds the token and sends it to the API the command is
//! for, and to no other part of Google. Which calls to make and what their answers mean are TypeScript's
//! (ADR-0005); where the token may go is the host's, because the webview is
//! the untrusted side (ADR-0017).

use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use reqwest::{Method, Url};
use serde::{Deserialize, Serialize};

use super::failure::{FailureKind, GoogleFailure};
use std::time::Duration;

use super::token::{answer_of, client_with_timeout, unreachable};

/// The only paths a Calendar call may reach: the Calendar API, version 3.
const CALENDAR_PATH: &str = "/calendar/v3/";

/// The only paths a Drive call may reach: files (folders are files to Drive),
/// and the upload a Doc is converted from. With `drive.file`, Google itself
/// keeps them to the files this app made.
const DRIVE_PATHS: [&str; 2] = ["/drive/v3/files", "/upload/drive/v3/files"];

/// The one body that is not JSON: a Drive upload's metadata and its page,
/// as `multipart/related` with a boundary of letters, digits, `-` and `_`.
const MULTIPART: &str = "multipart/related; boundary=";

/// Which Google API a command's calls go to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Service {
    Calendar,
    Drive,
}

impl Service {
    fn name(self) -> &'static str {
        match self {
            Service::Calendar => "Google Calendar API",
            Service::Drive => "Google Drive API",
        }
    }

    /// Whether `path`, as parsing resolved it, stays under this API.
    fn holds(self, path: &str) -> bool {
        match self {
            Service::Calendar => path.starts_with(CALENDAR_PATH),
            Service::Drive => DRIVE_PATHS
                .iter()
                .any(|root| path == *root || path.starts_with(&format!("{root}/"))),
        }
    }
}

/// A call as TypeScript asks for it. It holds no token.
#[derive(Debug, Clone, Deserialize)]
pub struct ApiCall {
    pub method: String,
    /// From the API's root — `/calendar/v3/…`, `/drive/v3/files…` — with any query.
    pub path: String,
    /// JSON, for a call that sends some.
    #[serde(default)]
    pub body: Option<String>,
    /// The body's type when it is not JSON: only a Drive upload's multipart.
    #[serde(default, rename = "contentType")]
    pub content_type: Option<String>,
}

/// What the API answered, with every token struck from the body.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct GoogleAnswer {
    pub status: u16,
    pub body: String,
}

fn invalid(message: String) -> GoogleFailure {
    GoogleFailure::new(FailureKind::Invalid, message)
}

/// The call's URL, if it stays under the API it is for. A path that starts
/// with `/` keeps the API's origin when joined to it, so what a path could
/// still change is the path itself, through `..` or its encoded forms — which
/// is why it is checked again once parsing has resolved them.
pub fn call_url(api: &Url, path: &str, service: Service) -> Result<Url, GoogleFailure> {
    let refused = || invalid(format!("{path:?} is not a {} path", service.name()));
    let before_query = path.split(['?', '#']).next().unwrap_or_default();
    if !path.starts_with('/') || !service.holds(before_query) {
        return Err(refused());
    }
    let url = api.join(path).map_err(|_| refused())?;
    if url.origin() == api.origin() && service.holds(url.path()) {
        Ok(url)
    } else {
        Err(refused())
    }
}

/// The body's type: JSON, or — for a Drive upload alone — multipart with a
/// boundary that cannot break the header it is written into.
fn content_type(call: &ApiCall, service: Service, url: &Url) -> Result<String, GoogleFailure> {
    let Some(given) = &call.content_type else {
        return Ok("application/json".into());
    };
    let boundary = given.strip_prefix(MULTIPART).unwrap_or_default();
    let usable = !boundary.is_empty()
        && boundary.len() <= 70
        && boundary
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    let upload = service == Service::Drive && url.path().starts_with(DRIVE_PATHS[1]);
    if usable && upload {
        Ok(given.clone())
    } else {
        Err(invalid(format!(
            "{given:?} is not a body this call may send"
        )))
    }
}

fn call_method(method: &str) -> Result<Method, GoogleFailure> {
    match method {
        "GET" => Ok(Method::GET),
        "POST" => Ok(Method::POST),
        "PUT" => Ok(Method::PUT),
        "PATCH" => Ok(Method::PATCH),
        "DELETE" => Ok(Method::DELETE),
        other => Err(invalid(format!(
            "{other:?} is not a method a Google API is called with"
        ))),
    }
}

/// A call checked and ready to send, before any token is added.
pub struct Checked {
    method: Method,
    url: Url,
    body: Option<String>,
    content_type: String,
}

/// The only Drive calls an export makes (#502): list its folder, make the
/// folder, upload a Doc. Anything else — permissions, a copy, a delete — is
/// refused, though `drive.file` would let Google allow it on the app's files.
const DRIVE_CALLS: [(&str, &str); 3] = [
    ("GET", "/drive/v3/files"),
    ("POST", "/drive/v3/files"),
    ("POST", "/upload/drive/v3/files"),
];

fn check_drive_call(method: &str, url: &Url) -> Result<(), GoogleFailure> {
    if DRIVE_CALLS.contains(&(method, url.path())) {
        Ok(())
    } else {
        Err(invalid(format!(
            "{method} {} is not a call an export makes",
            url.path()
        )))
    }
}

pub fn check(api: &Url, call: &ApiCall, service: Service) -> Result<Checked, GoogleFailure> {
    let url = call_url(api, &call.path, service)?;
    if service == Service::Drive {
        check_drive_call(&call.method, &url)?;
    }
    Ok(Checked {
        method: call_method(&call.method)?,
        content_type: content_type(call, service, &url)?,
        url,
        body: call.body.clone(),
    })
}

/// Sends the call with `access_token`. The answer's body is raw; the caller
/// strikes the tokens from it.
pub async fn send(
    checked: &Checked,
    access_token: &str,
    timeout: Duration,
) -> Result<(u16, Vec<u8>), GoogleFailure> {
    let mut request = client_with_timeout(timeout)?
        .request(checked.method.clone(), checked.url.clone())
        .header(AUTHORIZATION, format!("Bearer {access_token}"));
    if let Some(body) = &checked.body {
        request = request
            .header(CONTENT_TYPE, &checked.content_type)
            .body(body.clone());
    }
    let response = request.send().await.map_err(unreachable)?;
    answer_of(response).await
}

#[cfg(test)]
mod tests {
    use reqwest::Url;

    use super::{call_method, call_url, check, ApiCall, Service};

    fn api() -> Url {
        Url::parse("https://www.googleapis.com/").unwrap()
    }

    #[test]
    fn a_calendar_path_is_sent_to_the_api() {
        let url = call_url(
            &api(),
            "/calendar/v3/users/me/calendarList?minAccessRole=owner",
            Service::Calendar,
        )
        .unwrap();
        assert_eq!(
            url.as_str(),
            "https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=owner"
        );
    }

    #[test]
    fn a_path_that_leaves_the_calendar_api_or_its_origin_is_refused() {
        for path in [
            "/gmail/v1/users/me/messages",
            "/calendar/v3/../../gmail/v1/users/me/messages",
            "/calendar/v3/%2e%2e/%2e%2e/oauth2/v4/token",
            "//evil.example/calendar/v3/",
            "https://evil.example/calendar/v3/",
            "calendar/v3/calendars",
            "/calendar/v3x/calendars",
        ] {
            assert!(
                call_url(&api(), path, Service::Calendar).is_err(),
                "{path} was allowed"
            );
        }
    }

    #[test]
    fn only_the_apis_methods_are_used() {
        for method in ["GET", "POST", "PUT", "PATCH", "DELETE"] {
            assert!(call_method(method).is_ok(), "{method}");
        }
        for method in ["get", "CONNECT", "TRACE", ""] {
            assert!(call_method(method).is_err(), "{method}");
        }
    }

    #[test]
    fn a_drive_call_reaches_files_and_the_upload_and_nothing_else() {
        for path in [
            "/drive/v3/files?q=name%3D%27x%27&fields=files(id)",
            "/drive/v3/files",
            "/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink",
        ] {
            assert!(call_url(&api(), path, Service::Drive).is_ok(), "{path}");
        }
        for path in [
            "/drive/v3/about",
            "/drive/v3/filesX",
            "/drive/v3/files/../../gmail/v1/users/me/messages",
            "/drive/v3/files/%2e%2e/%2e%2e/oauth2/v4/token",
            "/calendar/v3/calendars",
            "//evil.example/drive/v3/files",
        ] {
            assert!(
                call_url(&api(), path, Service::Drive).is_err(),
                "{path} was allowed"
            );
        }
        assert!(call_url(&api(), "/drive/v3/files", Service::Calendar).is_err());
    }

    fn call(path: &str, content_type: Option<&str>) -> ApiCall {
        ApiCall {
            method: "POST".into(),
            path: path.into(),
            body: Some("--b\r\n".into()),
            content_type: content_type.map(str::to_string),
        }
    }

    #[test]
    fn only_a_drive_upload_sends_multipart_with_a_plain_boundary() {
        let upload = "/upload/drive/v3/files?uploadType=multipart";
        let good = Some("multipart/related; boundary=atlas-export_1");
        assert!(check(&api(), &call(upload, good), Service::Drive).is_ok());
        assert!(check(&api(), &call(upload, None), Service::Drive).is_ok());
        assert!(check(&api(), &call("/drive/v3/files", good), Service::Drive).is_err());
        assert!(check(
            &api(),
            &call("/calendar/v3/calendars", good),
            Service::Calendar
        )
        .is_err());
        for bad in [
            "multipart/related; boundary=",
            "multipart/related; boundary=a\r\nX-Evil: 1",
            "multipart/related; boundary=a b",
            "text/html",
        ] {
            assert!(
                check(&api(), &call(upload, Some(bad)), Service::Drive).is_err(),
                "{bad}"
            );
        }
        let long = format!("multipart/related; boundary={}", "a".repeat(71));
        assert!(check(&api(), &call(upload, Some(&long)), Service::Drive).is_err());
    }

    fn drive(method: &str, path: &str) -> ApiCall {
        ApiCall {
            method: method.into(),
            path: path.into(),
            body: None,
            content_type: None,
        }
    }

    #[test]
    fn a_drive_call_is_one_of_the_three_an_export_makes() {
        for (method, path) in [
            ("GET", "/drive/v3/files?q=x&fields=files(id)"),
            ("POST", "/drive/v3/files?fields=id"),
            ("POST", "/upload/drive/v3/files?uploadType=multipart"),
        ] {
            assert!(
                check(&api(), &drive(method, path), Service::Drive).is_ok(),
                "{method} {path}"
            );
        }
        for (method, path) in [
            ("POST", "/drive/v3/files/doc-1/permissions"),
            ("DELETE", "/drive/v3/files/doc-1"),
            ("POST", "/drive/v3/files/doc-1/copy"),
            ("PATCH", "/drive/v3/files/doc-1"),
            ("GET", "/drive/v3/files/doc-1"),
            ("DELETE", "/drive/v3/files"),
            ("PATCH", "/upload/drive/v3/files/doc-1"),
        ] {
            assert!(
                check(&api(), &drive(method, path), Service::Drive).is_err(),
                "{method} {path} was allowed"
            );
        }
    }
}
