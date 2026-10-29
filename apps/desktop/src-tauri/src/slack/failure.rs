//! What went wrong, as the webview is told it: a kind it can branch on and a
//! sentence. What the person should do about it is TypeScript's to say. An
//! answer Slack gave — `ok: false`, a 429 — is not a failure here: it comes
//! back as that answer, for TypeScript to read.

use serde::Serialize;

use crate::secrets::redact_off_worker;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureKind {
    /// No Slack token is kept for this vault on this Mac.
    NoToken,
    /// The request itself cannot be made: no vault, a method off the list, a
    /// token that is not a Slack user token.
    Invalid,
    /// Slack could not be reached, or stopped sending.
    Unreachable,
    /// Slack did not answer within the time a request is given.
    Timeout,
    /// The answer is larger than DFAI will read.
    TooLarge,
    /// Slack answered with something that is not text.
    Malformed,
    /// The Keychain refused to keep, give back or remove the token.
    Keychain,
}

/// A failure, with no token in it. Every message is written here, or is
/// reqwest's account of a connection without its URL, struck of the token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SlackFailure {
    pub kind: FailureKind,
    pub message: String,
}

impl SlackFailure {
    pub fn new(kind: FailureKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    /// The same failure with every token that went out struck from its
    /// message, off the async worker.
    pub async fn struck_of(self, sent: Vec<(String, String)>) -> Self {
        Self {
            message: redact_off_worker(self.message, sent).await,
            ..self
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{FailureKind, SlackFailure};

    #[test]
    fn the_webview_reads_the_kind_in_snake_case() {
        let failure = SlackFailure::new(FailureKind::NoToken, "none");
        let json = serde_json::to_string(&failure).unwrap();
        assert_eq!(json, r#"{"kind":"no_token","message":"none"}"#);
    }

    #[tokio::test]
    async fn a_token_in_the_message_is_struck() {
        let sent = vec![("slack-user-token".to_string(), "xoxp-S3CRET".to_string())];
        let failure = SlackFailure::new(FailureKind::Unreachable, "refused xoxp-S3CRET")
            .struck_of(sent)
            .await;
        assert!(
            !failure.message.contains("xoxp-S3CRET"),
            "{}",
            failure.message
        );
        assert_eq!(failure.kind, FailureKind::Unreachable);
    }
}
