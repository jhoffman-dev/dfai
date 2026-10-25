//! Google's token endpoint: a code for tokens, a refresh token for an access
//! token, and revoking a refresh token (RFC 6749 §4.1.3, §6; RFC 7009).
//!
//! Each is one form POST to an endpoint the host fixes, never one the webview
//! names, with no redirect followed: a token endpoint that moves has nothing
//! to say to a request carrying a refresh token.

use std::time::Duration;

use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use reqwest::header::CONTENT_TYPE;
use reqwest::{redirect, Client, Url};
use serde::Deserialize;

use super::failure::{FailureKind, GoogleFailure};
use super::grant::Grant;
use crate::http::{read_capped, ReadFailure, MAX_RESPONSE_BYTES};

pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const USER_AGENT: &str = concat!("DFAI/", env!("CARGO_PKG_VERSION"));

/// Everything but RFC 3986's unreserved characters is escaped in a form value.
const FORM_VALUE: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

/// What the token endpoint gave. Held by the host; nothing here is serialized.
pub struct Tokens {
    pub access_token: String,
    pub expires_in: u64,
    pub refresh_token: Option<String>,
    /// Space-separated, as Google lists what it granted.
    pub scope: Option<String>,
}

#[derive(Deserialize)]
struct TokenAnswer {
    access_token: String,
    expires_in: u64,
    refresh_token: Option<String>,
    scope: Option<String>,
}

#[derive(Deserialize)]
struct ErrorAnswer {
    error: String,
}

/// The code from the redirect, and what proves this host asked for it.
pub struct Exchange<'a> {
    pub client_id: &'a str,
    pub client_secret: Option<&'a str>,
    pub code: &'a str,
    pub verifier: &'a str,
    pub redirect_uri: &'a str,
}

pub fn client() -> Result<Client, GoogleFailure> {
    client_with_timeout(REQUEST_TIMEOUT)
}

/// A client whose requests give up after `timeout`.
pub fn client_with_timeout(timeout: Duration) -> Result<Client, GoogleFailure> {
    Client::builder()
        .timeout(timeout)
        .user_agent(USER_AGENT)
        .redirect(redirect::Policy::none())
        .build()
        .map_err(|error| {
            GoogleFailure::new(
                FailureKind::Unreachable,
                format!("cannot prepare the request: {error}"),
            )
        })
}

fn form(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(name, value)| format!("{name}={}", utf8_percent_encode(value, FORM_VALUE)))
        .collect::<Vec<_>>()
        .join("&")
}

pub fn unreachable(error: reqwest::Error) -> GoogleFailure {
    // Without the URL, as everywhere a request may go wrong (ADR-0017).
    GoogleFailure::new(
        FailureKind::Unreachable,
        format!("cannot reach Google: {}", error.without_url()),
    )
}

/// Reads an answer whole, within the cap every response is held to. One past
/// it is not what OAuth or the Calendar API sends: malformed, not unreachable.
pub async fn answer_of(response: reqwest::Response) -> Result<(u16, Vec<u8>), GoogleFailure> {
    let status = response.status().as_u16();
    let body =
        read_capped(response, MAX_RESPONSE_BYTES)
            .await
            .map_err(|failure| match failure {
                ReadFailure::TooLarge => GoogleFailure::new(
                    FailureKind::Malformed,
                    "Google's answer is larger than DFAI will read",
                ),
                ReadFailure::Stopped(error) => unreachable(error),
            })?;
    Ok((status, body))
}

async fn post_form(url: &Url, body: String) -> Result<(u16, Vec<u8>), GoogleFailure> {
    let response = client()?
        .post(url.clone())
        .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(unreachable)?;
    answer_of(response).await
}

/// Tokens from a 2xx answer; an OAuth error from any other.
fn tokens_of(status: u16, body: &[u8]) -> Result<Tokens, GoogleFailure> {
    if !(200..300).contains(&status) {
        return Err(refusal_of(status, body));
    }
    let answer: TokenAnswer = serde_json::from_slice(body).map_err(|_| {
        GoogleFailure::new(
            FailureKind::Malformed,
            "Google's token endpoint answered without an access token",
        )
    })?;
    Ok(Tokens {
        access_token: answer.access_token,
        expires_in: answer.expires_in,
        refresh_token: answer.refresh_token,
        scope: answer.scope,
    })
}

fn refusal_of(status: u16, body: &[u8]) -> GoogleFailure {
    match serde_json::from_slice::<ErrorAnswer>(body) {
        Ok(answer) => GoogleFailure::new(
            FailureKind::TokenRefused,
            format!("Google refused the sign-in ({status})"),
        )
        .with_code(&answer.error),
        Err(_) => GoogleFailure::new(
            FailureKind::Malformed,
            format!("Google's token endpoint answered {status} without saying why"),
        ),
    }
}

/// Trades the code from the redirect for tokens.
pub async fn exchange(
    token_endpoint: &Url,
    request: &Exchange<'_>,
) -> Result<Tokens, GoogleFailure> {
    let mut pairs = vec![
        ("grant_type", "authorization_code"),
        ("code", request.code),
        ("code_verifier", request.verifier),
        ("client_id", request.client_id),
        ("redirect_uri", request.redirect_uri),
    ];
    if let Some(secret) = request.client_secret {
        pairs.push(("client_secret", secret));
    }
    let (status, body) = post_form(token_endpoint, form(&pairs)).await?;
    tokens_of(status, &body)
}

/// A new access token for a kept refresh token.
pub async fn refresh(token_endpoint: &Url, grant: &Grant) -> Result<Tokens, GoogleFailure> {
    let mut pairs = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", grant.refresh_token.as_str()),
        ("client_id", grant.client_id.as_str()),
    ];
    if let Some(secret) = &grant.client_secret {
        pairs.push(("client_secret", secret.as_str()));
    }
    let (status, body) = post_form(token_endpoint, form(&pairs)).await?;
    tokens_of(status, &body)
}

/// Asks Google to revoke a refresh token, and with it every access token it
/// gave. True when Google confirmed it, or said the token was already dead;
/// false when it could not be asked, which the caller reports.
pub async fn revoke(revoke_endpoint: &Url, refresh_token: &str) -> bool {
    let body = form(&[("token", refresh_token)]);
    match post_form(revoke_endpoint, body).await {
        Ok((200..=299, _)) => true,
        Ok((status, body)) => {
            let dead = serde_json::from_slice::<ErrorAnswer>(&body)
                .is_ok_and(|answer| answer.error == "invalid_token");
            if !dead {
                log::warn!("Google answered {status} to a revocation");
            }
            dead
        }
        Err(failure) => {
            log::warn!("revoking the Google sign-in failed: {}", failure.message);
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{form, tokens_of};
    use crate::google::failure::FailureKind;

    #[test]
    fn a_form_value_is_escaped_so_it_cannot_add_a_field() {
        assert_eq!(
            form(&[("code", "4/0A&grant_type=x y"), ("client_id", "1-a.b_c~d")]),
            "code=4%2F0A%26grant_type%3Dx%20y&client_id=1-a.b_c~d"
        );
    }

    #[test]
    fn tokens_are_read_from_a_2xx_answer() {
        let body = br#"{"access_token":"ya29.A","expires_in":3599,"refresh_token":"1//R","scope":"s1 s2","token_type":"Bearer"}"#;
        let tokens = tokens_of(200, body).unwrap();
        assert_eq!(tokens.access_token, "ya29.A");
        assert_eq!(tokens.expires_in, 3599);
        assert_eq!(tokens.refresh_token.as_deref(), Some("1//R"));
        assert_eq!(tokens.scope.as_deref(), Some("s1 s2"));
    }

    #[test]
    fn an_oauth_error_is_a_refusal_with_its_code() {
        let failure = tokens_of(
            400,
            br#"{"error":"invalid_grant","error_description":"Bad"}"#,
        )
        .err()
        .unwrap();
        assert_eq!(failure.kind, FailureKind::TokenRefused);
        assert_eq!(failure.code.as_deref(), Some("invalid_grant"));
    }

    #[test]
    fn an_answer_that_is_not_oauth_is_malformed() {
        for (status, body) in [
            (200, &b"<html>sign in</html>"[..]),
            (200, br#"{"expires_in":3599}"#),
            (502, b"Bad Gateway"),
        ] {
            let failure = tokens_of(status, body).err().unwrap();
            assert_eq!(failure.kind, FailureKind::Malformed, "{status}");
        }
    }
}
