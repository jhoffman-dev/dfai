//! Slack's Web API, reached with a user token the host keeps (#105).
//!
//! The person pastes a token once; the host keeps it in the Keychain and adds
//! it to each request, as `granola.rs` does Granola's key (ADR-0034). The
//! token is never handed to the webview: what comes back is whether one is
//! kept, and a method's answer with the token struck from it.
//!
//! What is decided in TypeScript, as every rule is (ADR-0005): which methods
//! to call, what their answers mean — Slack answers most refusals as a 200
//! with `ok: false` — and what each failure tells the person. What the host
//! holds is where the token may go (ADR-0017): Slack's own origin, fixed here
//! rather than named by the webview, a short list of read-only methods under
//! `/api/`, and GET.

use std::collections::BTreeMap;

use reqwest::Url;
use serde::Serialize;
use tauri::State;

use crate::secrets::{
    ensure_strikable_off_worker, redact_off_worker, vault_scope, SecretState, SecretStore,
};
use crate::vault::{root_for_write, VaultState};

pub use failure::{FailureKind, SlackFailure};

/// The one origin the token is sent to: Slack's Web API, for every workspace.
const ORIGIN: &str = "https://slack.com";

/// What the token is called where it is struck from an answer.
const TOKEN_NAME: &str = "slack-user-token";

/// Whether this vault has a Slack token on this Mac. Never the token.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackStatus {
    pub has_token: bool,
}

/// What Slack answered, with the token struck from the body, and how long it
/// asked DFAI to wait when it said 429. What either means is TypeScript's.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackAnswer {
    pub status: u16,
    pub body: String,
    pub retry_after: Option<u64>,
}

/// Slack, for one vault's token.
pub struct Session<'a> {
    pub origin: &'a Url,
    pub store: &'a dyn SecretStore,
    pub scope: &'a str,
}

fn no_token() -> SlackFailure {
    SlackFailure::new(
        FailureKind::NoToken,
        "no Slack token is kept for this vault on this Mac",
    )
}

/// A token kept that DFAI could not strike from an answer: sending it and
/// then withholding the answer would already have given it away.
fn too_long_to_protect() -> SlackFailure {
    SlackFailure::new(
        FailureKind::Invalid,
        "the Slack token kept is too long for DFAI to protect, so nothing was sent — replace it in Settings",
    )
}

impl Session<'_> {
    pub fn status(&self) -> Result<SlackStatus, SlackFailure> {
        Ok(SlackStatus {
            has_token: token::load(self.store, self.scope)?.is_some(),
        })
    }

    /// Keeps the token, replacing any kept before. Whether Slack accepts it
    /// is asked by TypeScript next, with `auth.test`, like any other call.
    pub async fn connect(&self, token: &str) -> Result<SlackStatus, SlackFailure> {
        token::save(self.store, self.scope, token).await?;
        log::info!("Slack token stored");
        Ok(SlackStatus { has_token: true })
    }

    pub fn disconnect(&self) -> Result<SlackStatus, SlackFailure> {
        token::forget(self.store, self.scope)?;
        log::info!("Slack token removed");
        Ok(SlackStatus { has_token: false })
    }

    /// Sends one GET and hands back its answer. A method off the list is
    /// refused before the token is read, and so before anything is sent.
    pub async fn request(
        &self,
        method: &str,
        query: &BTreeMap<String, String>,
    ) -> Result<SlackAnswer, SlackFailure> {
        let url = api::call_url(self.origin, method, query)?;
        let token = token::load(self.store, self.scope)?.ok_or_else(no_token)?;
        ensure_strikable_off_worker(token.clone())
            .await
            .map_err(|_| too_long_to_protect())?;
        let sent = [(TOKEN_NAME.to_string(), token)];
        let reply = match api::get(&url, &sent[0].1).await {
            Ok(reply) => reply,
            Err(failure) => return Err(failure.struck_of(sent.into()).await),
        };
        // The method, never its query: a channel id is the person's, not the log's.
        log::debug!("Slack answered {} to {method}", reply.status);
        let text = String::from_utf8(reply.body).map_err(|_| {
            SlackFailure::new(FailureKind::Malformed, "Slack did not answer with text")
        })?;
        Ok(SlackAnswer {
            status: reply.status,
            body: redact_off_worker(text, sent.into()).await,
            retry_after: reply.retry_after,
        })
    }
}

fn pinned_origin() -> Url {
    Url::parse(ORIGIN).expect("Slack's fixed origin parses")
}

/// The vault a command names, checked to be the open one, as its Keychain
/// scope: a call that lands after a switch is refused, never sent with the
/// other vault's token.
fn scope_of(state: &VaultState, vault: &str) -> Result<String, SlackFailure> {
    let root = root_for_write(state.root(), Some(vault))
        .map_err(|message| SlackFailure::new(FailureKind::Invalid, message))?;
    Ok(vault_scope(&root))
}

fn session<'a>(origin: &'a Url, secrets: &'a SecretState, scope: &'a str) -> Session<'a> {
    Session {
        origin,
        store: secrets.store(),
        scope,
    }
}

// The commands are async so that the Keychain, which can block on a prompt,
// is never asked from the main thread. None is named for the token: the IPC
// contract test holds every command with "token" in its name to the local
// API's own.

#[tauri::command]
pub async fn slack_status(
    vaults: State<'_, VaultState>,
    secrets: State<'_, SecretState>,
    vault: String,
) -> Result<SlackStatus, SlackFailure> {
    let scope = scope_of(&vaults, &vault)?;
    session(&pinned_origin(), &secrets, &scope).status()
}

/// Keeps the token the person pasted, replacing any kept before.
#[tauri::command]
pub async fn slack_connect(
    vaults: State<'_, VaultState>,
    secrets: State<'_, SecretState>,
    vault: String,
    token: String,
) -> Result<SlackStatus, SlackFailure> {
    let scope = scope_of(&vaults, &vault)?;
    session(&pinned_origin(), &secrets, &scope)
        .connect(&token)
        .await
}

#[tauri::command]
pub async fn slack_disconnect(
    vaults: State<'_, VaultState>,
    secrets: State<'_, SecretState>,
    vault: String,
) -> Result<SlackStatus, SlackFailure> {
    let scope = scope_of(&vaults, &vault)?;
    session(&pinned_origin(), &secrets, &scope).disconnect()
}

/// One GET of a Web API method, as TypeScript names it, with its query, each
/// value a string. The host adds the token.
#[tauri::command]
pub async fn slack_request(
    vaults: State<'_, VaultState>,
    secrets: State<'_, SecretState>,
    vault: String,
    method: String,
    query: BTreeMap<String, String>,
) -> Result<SlackAnswer, SlackFailure> {
    let scope = scope_of(&vaults, &vault)?;
    session(&pinned_origin(), &secrets, &scope)
        .request(&method, &query)
        .await
}

mod api;
mod failure;
#[cfg(test)]
mod fake_slack;
#[cfg(test)]
mod tests;
mod token;

#[cfg(test)]
mod pinned {
    #[test]
    fn the_token_is_only_ever_sent_to_slack_com_over_https() {
        let origin = super::pinned_origin();
        assert_eq!(origin.as_str(), "https://slack.com/");
        assert_eq!(origin.scheme(), "https");
    }
}
