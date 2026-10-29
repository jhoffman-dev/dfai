//! The Slack user token the host keeps for a vault.
//!
//! One Keychain item per vault, under the `SecretStore` every secret uses
//! (ADR-0017), at `<vault>:apikey/slack`, as Granola's key is kept
//! (ADR-0034). It goes in through `slack_connect` and comes out only inside
//! this process, into a request to Slack; it is never named, listed or filled
//! as one of the vault's secrets.

use super::failure::{FailureKind, SlackFailure};
use crate::secrets::{apikey_account, ensure_strikable_off_worker, SecretStore};

const PROVIDER: &str = "slack";

/// A user token, and one Slack issues with rotation on: never a bot's
/// (`xoxb-`), which reads as the app rather than as the person.
const TOKEN_PREFIXES: [&str; 2] = ["xoxp-", "xoxe.xoxp-"];

fn keychain(error: String) -> SlackFailure {
    SlackFailure::new(
        FailureKind::Keychain,
        format!("the Keychain refused: {error}"),
    )
}

/// The backstop for `slackTokenProblem` in the domain, which checks the same
/// shape before the webview hands a token over and words it for the person:
/// a user token, and nothing that could break the header it is written into.
/// The token is never quoted back.
pub fn check(token: &str) -> Result<(), SlackFailure> {
    let prefixed = TOKEN_PREFIXES
        .iter()
        .any(|prefix| token.len() > prefix.len() && token.starts_with(prefix));
    if !prefixed || !token.bytes().all(|byte| byte.is_ascii_graphic()) {
        return Err(SlackFailure::new(
            FailureKind::Invalid,
            "that is not a Slack user token",
        ));
    }
    Ok(())
}

pub fn load(store: &dyn SecretStore, scope: &str) -> Result<Option<String>, SlackFailure> {
    store
        .get(&apikey_account(scope, PROVIDER))
        .map_err(keychain)
}

/// Keeps `token` once it is a user token that DFAI can strike from every
/// answer. Finding that out builds its matcher, off the async worker.
pub async fn save(store: &dyn SecretStore, scope: &str, token: &str) -> Result<(), SlackFailure> {
    check(token)?;
    ensure_strikable_off_worker(token.to_string())
        .await
        .map_err(|_| {
            SlackFailure::new(
                FailureKind::Invalid,
                "that is too long to protect: DFAI could not strike it from Slack's answers, so it is not kept",
            )
        })?;
    store
        .set(&apikey_account(scope, PROVIDER), token)
        .map_err(keychain)
}

pub fn forget(store: &dyn SecretStore, scope: &str) -> Result<(), SlackFailure> {
    store
        .delete(&apikey_account(scope, PROVIDER))
        .map_err(keychain)
}

#[cfg(test)]
mod tests {
    use super::{check, forget, load, save};
    use crate::secrets::{entries_in, MemoryStore, SecretStore};
    use crate::slack::failure::FailureKind;

    const TOKEN: &str = "xoxp-1111-2222-Fict10nalLarkspur";

    #[tokio::test]
    async fn a_token_round_trips_through_the_store_for_its_own_vault_only() {
        let store = MemoryStore::default();
        save(&store, "v1", TOKEN).await.unwrap();
        assert_eq!(load(&store, "v1").unwrap().as_deref(), Some(TOKEN));
        assert_eq!(load(&store, "v2").unwrap(), None);
        forget(&store, "v1").unwrap();
        assert_eq!(load(&store, "v1").unwrap(), None);
    }

    #[tokio::test]
    async fn the_token_is_kept_at_the_vaults_slack_apikey_account() {
        let store = MemoryStore::default();
        save(&store, "v1", TOKEN).await.unwrap();
        assert_eq!(store.accounts().unwrap(), vec!["v1:apikey/slack"]);
    }

    #[tokio::test]
    async fn the_token_is_never_listed_among_the_vaults_secrets() {
        let store = MemoryStore::default();
        save(&store, "v1", TOKEN).await.unwrap();
        assert!(entries_in(&store, "v1").unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_token_too_long_to_protect_is_refused_and_not_kept() {
        let store = MemoryStore::default();
        let too_long = format!("xoxp-{}", "k".repeat(16 * 1024));

        let failure = save(&store, "v1", &too_long).await.unwrap_err();

        assert_eq!(failure.kind, FailureKind::Invalid);
        assert!(store.accounts().unwrap().is_empty());
    }

    #[test]
    fn a_user_token_is_accepted() {
        for token in [TOKEN, "xoxp-x", "xoxe.xoxp-1-AbC"] {
            assert!(check(token).is_ok(), "{token} was refused");
        }
    }

    #[tokio::test]
    async fn anything_but_a_user_token_is_refused_and_never_kept_or_quoted() {
        for token in [
            "",
            "xoxp-",
            "xoxb-1111-bot",
            "XOXP-abc",
            "grn_abc",
            " xoxp-abc",
            "xoxp-ab c",
            "xoxp-abc\r\nX-Evil: 1",
            "xoxp-ébc",
        ] {
            let store = MemoryStore::default();
            let failure = save(&store, "v1", token).await.unwrap_err();
            assert_eq!(failure.kind, FailureKind::Invalid, "{token:?}");
            assert!(
                token.is_empty() || !failure.message.contains(token),
                "{token:?} was quoted"
            );
            assert!(store.accounts().unwrap().is_empty(), "{token:?} was kept");
        }
    }
}
