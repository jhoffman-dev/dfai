//! A local stand-in for Slack's Web API, for the tests. It runs over real TCP
//! on 127.0.0.1, so the host's requests are the ones the app sends, and it
//! records every one it hears. No test reaches Slack.

use std::convert::Infallible;
use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex};

use http_body_util::Full;
use hyper::body::{Bytes, Incoming};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{header, Request, Response};
use hyper_util::rt::TokioIo;
use reqwest::Url;
use tokio::net::TcpListener;

use super::api::MAX_ANSWER_BYTES;

/// How the fake answers a request carrying the token it honours.
#[derive(Clone, PartialEq, Eq)]
pub enum Reply {
    /// `{"ok":true,…}`, as a method that worked answers.
    Ok,
    /// `{"ok":false,"error":<this>}` with a 200, as Slack refuses.
    NotOk(&'static str),
    /// A 429 with `Retry-After: 30`.
    RateLimited,
    /// A redirect to this location.
    Redirect(String),
    /// Bytes that are not text.
    NotText,
    /// One byte more than the host will read.
    Oversized,
    /// Accepts the request and never answers it.
    Silent,
}

#[derive(Debug, Clone)]
pub struct Heard {
    pub method: String,
    pub target: String,
    pub authorization: String,
}

pub struct Slack {
    /// The token it honours; any other is answered `invalid_auth`.
    pub token: Option<String>,
    pub reply: Reply,
    /// Every answer carries the request's Authorization header in its body.
    pub echoes: bool,
    pub heard: Vec<Heard>,
}

impl Default for Slack {
    fn default() -> Self {
        Self {
            token: None,
            reply: Reply::Ok,
            echoes: false,
            heard: Vec::new(),
        }
    }
}

pub struct FakeSlack {
    pub origin: Url,
    pub slack: Arc<Mutex<Slack>>,
}

type Answer = Response<Full<Bytes>>;

fn answer_of(status: u16, body: impl Into<Bytes>) -> Answer {
    let mut response = Response::new(Full::new(body.into()));
    *response.status_mut() = hyper::StatusCode::from_u16(status).unwrap();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("application/json"),
    );
    response
}

/// What the fake says to one request, or None when it says nothing at all.
fn reply_to(slack: &Slack, authorization: &str) -> Option<Answer> {
    let echo = if slack.echoes {
        format!(r#","authorization":"{authorization}""#)
    } else {
        String::new()
    };
    let honoured = slack
        .token
        .as_ref()
        .is_some_and(|token| authorization == format!("Bearer {token}"));
    if !honoured {
        return Some(answer_of(
            200,
            format!(r#"{{"ok":false,"error":"invalid_auth"{echo}}}"#),
        ));
    }
    Some(match &slack.reply {
        Reply::Ok => answer_of(
            200,
            format!(r#"{{"ok":true,"team":"Larkspur Payroll","user":"mara"{echo}}}"#),
        ),
        Reply::NotOk(error) => answer_of(200, format!(r#"{{"ok":false,"error":"{error}"{echo}}}"#)),
        Reply::RateLimited => {
            let mut response = answer_of(
                429,
                format!(r#"{{"ok":false,"error":"ratelimited"{echo}}}"#),
            );
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, header::HeaderValue::from_static("30"));
            response
        }
        Reply::Redirect(location) => {
            let mut response = answer_of(302, format!(r#"{{"moved":true{echo}}}"#));
            response.headers_mut().insert(
                header::LOCATION,
                header::HeaderValue::from_str(location).unwrap(),
            );
            response
        }
        Reply::NotText => answer_of(200, vec![0xff, 0xfe, 0x00]),
        Reply::Oversized => answer_of(200, vec![b' '; MAX_ANSWER_BYTES + 1]),
        Reply::Silent => return None,
    })
}

async fn answer(slack: Arc<Mutex<Slack>>, request: Request<Incoming>) -> Answer {
    let authorization = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let replied = {
        let mut slack = slack.lock().unwrap();
        slack.heard.push(Heard {
            method: request.method().to_string(),
            target: request.uri().to_string(),
            authorization: authorization.clone(),
        });
        reply_to(&slack, &authorization)
    };
    match replied {
        Some(reply) => reply,
        None => std::future::pending().await,
    }
}

impl FakeSlack {
    pub async fn start() -> Self {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let origin = Url::parse(&format!(
            "http://127.0.0.1:{}",
            listener.local_addr().unwrap().port()
        ))
        .unwrap();
        let slack = Arc::new(Mutex::new(Slack::default()));
        let serving = slack.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let slack = serving.clone();
                let service = service_fn(move |request| {
                    let slack = slack.clone();
                    async move { Ok::<_, Infallible>(answer(slack, request).await) }
                });
                tokio::spawn(http1::Builder::new().serve_connection(TokioIo::new(stream), service));
            }
        });
        Self { origin, slack }
    }
}
