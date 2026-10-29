//! One GET of a Slack Web API method, carrying the token.
//!
//! The webview says which method and its query, and the host adds the token
//! and sends it to the one origin it may go to. Which methods to call and what
//! their answers mean are TypeScript's (ADR-0005); where the token may go is
//! the host's, because the webview is the untrusted side (ADR-0017). Only
//! methods that read are on the list, so a token with more scopes than it
//! needs still cannot post, edit or delete through DFAI.

use std::collections::BTreeMap;
use std::sync::OnceLock;
use std::time::Duration;

use reqwest::header::{ACCEPT, AUTHORIZATION, RETRY_AFTER};
use reqwest::{redirect, Client, Response, Url};

use super::failure::{FailureKind, SlackFailure};
use crate::http::{self, ReadFailure};

/// The methods DFAI calls, every one a read: checking the token, a thread,
/// a message's permalink, and the people in it.
const METHODS: [&str; 4] = [
    "auth.test",
    "conversations.replies",
    "chat.getPermalink",
    "users.info",
];

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// A thread of a thousand long replies is large, but not this large.
pub const MAX_ANSWER_BYTES: usize = 16 * 1024 * 1024;

const USER_AGENT: &str = concat!("DFAI/", env!("CARGO_PKG_VERSION"));

/// What came back: the status, the raw body, and Slack's `Retry-After` when
/// it sent one a number of seconds.
pub struct Reply {
    pub status: u16,
    pub body: Vec<u8>,
    pub retry_after: Option<u64>,
}

/// The method's URL at `origin`, if it is one on the list. The name is
/// matched whole, so nothing in it can be a path, a query or another host,
/// and the URL is checked again once parsed.
pub fn call_url(
    origin: &Url,
    method: &str,
    query: &BTreeMap<String, String>,
) -> Result<Url, SlackFailure> {
    let refused = || {
        SlackFailure::new(
            FailureKind::Invalid,
            format!("{method:?} is not a Slack method DFAI calls"),
        )
    };
    if !METHODS.contains(&method) {
        return Err(refused());
    }
    let mut url = origin
        .join(&format!("/api/{method}"))
        .map_err(|_| refused())?;
    if url.origin() != origin.origin() || url.path() != format!("/api/{method}") {
        return Err(refused());
    }
    if !query.is_empty() {
        let mut pairs = url.query_pairs_mut();
        for (name, value) in query {
            pairs.append_pair(name, value);
        }
    }
    Ok(url)
}

/// One client for every Slack request, so a paste's lookups share its
/// connections rather than each opening its own. Built on first use; a
/// build that fails is tried again by the next request.
fn client() -> Result<&'static Client, SlackFailure> {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    // No redirect is followed: following one could carry the token elsewhere.
    let built = Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent(USER_AGENT)
        .redirect(redirect::Policy::none())
        .build()
        .map_err(|error| {
            SlackFailure::new(
                FailureKind::Unreachable,
                format!("cannot prepare the request: {error}"),
            )
        })?;
    Ok(CLIENT.get_or_init(|| built))
}

/// Without the URL, as everywhere a request may go wrong (ADR-0017): its
/// query names the channel.
fn failed(error: reqwest::Error) -> SlackFailure {
    let kind = if error.is_timeout() {
        FailureKind::Timeout
    } else {
        FailureKind::Unreachable
    };
    SlackFailure::new(kind, format!("cannot reach Slack: {}", error.without_url()))
}

async fn read_capped(response: Response) -> Result<Vec<u8>, SlackFailure> {
    http::read_capped(response, MAX_ANSWER_BYTES)
        .await
        .map_err(|failure| match failure {
            ReadFailure::TooLarge => SlackFailure::new(
                FailureKind::TooLarge,
                "Slack's answer is larger than DFAI will read",
            ),
            ReadFailure::Stopped(error) => failed(error),
        })
}

fn retry_after_of(response: &Response) -> Option<u64> {
    response
        .headers()
        .get(RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// Sends the GET with `token`. The body is raw; the caller strikes the token
/// from it.
pub async fn get(url: &Url, token: &str) -> Result<Reply, SlackFailure> {
    let response = client()?
        .get(url.clone())
        .header(AUTHORIZATION, format!("Bearer {token}"))
        .header(ACCEPT, "application/json")
        .send()
        .await
        .map_err(failed)?;
    let status = response.status().as_u16();
    let retry_after = retry_after_of(&response);
    Ok(Reply {
        status,
        body: read_capped(response).await?,
        retry_after,
    })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use reqwest::Url;

    use super::call_url;
    use crate::slack::failure::FailureKind;

    fn origin() -> Url {
        Url::parse("https://slack.com").unwrap()
    }

    #[test]
    fn a_method_on_the_list_is_sent_to_slack_com_with_its_query_encoded() {
        let query = BTreeMap::from([
            ("channel".to_string(), "C0LARK5PUR".to_string()),
            ("ts".to_string(), "1793136000.000100&limit=1#x".to_string()),
        ]);
        let url = call_url(&origin(), "conversations.replies", &query).unwrap();
        assert_eq!(url.host_str(), Some("slack.com"));
        assert_eq!(url.path(), "/api/conversations.replies");
        let pairs: Vec<(String, String)> = url.query_pairs().into_owned().collect();
        assert_eq!(
            pairs,
            vec![
                ("channel".to_string(), "C0LARK5PUR".to_string()),
                ("ts".to_string(), "1793136000.000100&limit=1#x".to_string()),
            ]
        );
        assert_eq!(url.fragment(), None);
    }

    #[test]
    fn every_method_dfai_calls_is_on_the_list() {
        for method in [
            "auth.test",
            "conversations.replies",
            "chat.getPermalink",
            "users.info",
        ] {
            assert!(
                call_url(&origin(), method, &BTreeMap::new()).is_ok(),
                "{method}"
            );
        }
    }

    #[test]
    fn a_method_that_writes_or_leaves_the_api_or_the_host_is_refused() {
        for method in [
            "chat.postMessage",
            "chat.delete",
            "files.upload",
            "users.info/../../admin",
            "../auth.test",
            "//evil.example/api/auth.test",
            "https://evil.example/api/auth.test",
            "auth.test?token=x",
            "auth.test#x",
            "AUTH.TEST",
            " auth.test",
            "",
        ] {
            let failure = call_url(&origin(), method, &BTreeMap::new()).unwrap_err();
            assert_eq!(failure.kind, FailureKind::Invalid, "{method}");
        }
    }
}
