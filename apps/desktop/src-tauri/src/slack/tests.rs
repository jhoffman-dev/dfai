//! The Slack module end to end, against a fake Slack on this machine's
//! loopback: the requests are real HTTP, and the Keychain is the in-memory
//! store. No test reaches Slack or the real Keychain.

use std::collections::BTreeMap;
use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::ThreadId;

use reqwest::Url;

use super::fake_slack::{FakeSlack, Reply, Slack};
use super::{vault_refusal, FailureKind, Session, SlackFailure};
use crate::secrets::{MemoryStore, SecretStore};

const VAULT: &str = "v1";
const TOKEN: &str = "xoxp-1111-2222-Fict10nalLarkspurToken";

struct Setup {
    fake: FakeSlack,
    store: Arc<MemoryStore>,
}

impl Setup {
    async fn new() -> Self {
        Self {
            fake: FakeSlack::start().await,
            store: Arc::new(MemoryStore::default()),
        }
    }

    /// With the token kept and honoured by the fake.
    async fn connected() -> Self {
        let setup = Self::new().await;
        setup.slack().token = Some(TOKEN.into());
        setup.session().connect(TOKEN).await.unwrap();
        setup
    }

    fn session(&self) -> Session<'_> {
        self.session_for(VAULT)
    }

    fn session_for<'a>(&'a self, scope: &'a str) -> Session<'a> {
        Session {
            origin: &self.fake.origin,
            store: self.store.clone(),
            scope,
        }
    }

    fn slack(&self) -> MutexGuard<'_, Slack> {
        self.fake.slack.lock().unwrap()
    }

    fn heard(&self) -> usize {
        self.slack().heard.len()
    }
}

fn no_query() -> BTreeMap<String, String> {
    BTreeMap::new()
}

const REPLIES: &str = "conversations.replies";

#[tokio::test(flavor = "multi_thread")]
async fn a_get_carries_the_token_to_the_method_and_hands_back_what_slack_said() {
    let setup = Setup::connected().await;
    let query = BTreeMap::from([
        ("channel".to_string(), "C0LARK5PUR".to_string()),
        ("ts".to_string(), "1793136000.000100".to_string()),
    ]);

    let answer = setup.session().request(REPLIES, &query).await.unwrap();

    assert_eq!(answer.status, 200);
    assert!(answer.body.contains(r#""ok":true"#), "{}", answer.body);
    assert_eq!(answer.retry_after, None);
    let heard = setup.slack().heard.clone();
    assert_eq!(heard.len(), 1);
    assert_eq!(heard[0].method, "GET");
    assert_eq!(
        heard[0].target,
        "/api/conversations.replies?channel=C0LARK5PUR&ts=1793136000.000100"
    );
    assert_eq!(heard[0].authorization, format!("Bearer {TOKEN}"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_method_off_the_list_or_another_host_is_refused_before_anything_is_sent() {
    let setup = Setup::connected().await;
    for method in [
        "chat.postMessage",
        "https://evil.example/api/auth.test",
        "//evil.example/api/auth.test",
        "../auth.test",
        "auth.test?x=1",
    ] {
        let failure = setup
            .session()
            .request(method, &no_query())
            .await
            .unwrap_err();
        assert_eq!(failure.kind, FailureKind::Invalid, "{method}");
    }
    assert_eq!(setup.heard(), 0, "a refused method reached Slack");
}

#[tokio::test(flavor = "multi_thread")]
async fn without_a_token_nothing_is_sent() {
    let setup = Setup::new().await;
    let failure = setup
        .session()
        .request(REPLIES, &no_query())
        .await
        .unwrap_err();
    assert_eq!(failure.kind, FailureKind::NoToken);
    assert_eq!(setup.heard(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn one_vaults_token_is_never_sent_for_another() {
    let setup = Setup::connected().await;
    let other = setup.session_for("v2");
    assert!(!other.status().await.unwrap().has_token);
    let failure = other.request(REPLIES, &no_query()).await.unwrap_err();
    assert_eq!(failure.kind, FailureKind::NoToken);
    assert_eq!(setup.heard(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn connecting_keeps_the_token_and_disconnecting_forgets_it() {
    let setup = Setup::new().await;
    assert!(!setup.session().status().await.unwrap().has_token);
    assert!(setup.session().connect(TOKEN).await.unwrap().has_token);
    assert!(setup.session().status().await.unwrap().has_token);
    assert!(!setup.session().disconnect().await.unwrap().has_token);
    assert!(!setup.session().status().await.unwrap().has_token);
    assert_eq!(setup.heard(), 0, "connecting is not a request");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_bot_token_is_refused_and_the_kept_one_stays() {
    let setup = Setup::connected().await;
    let failure = setup.session().connect("xoxb-1111-bot").await.unwrap_err();
    assert_eq!(failure.kind, FailureKind::Invalid);
    setup.session().request(REPLIES, &no_query()).await.unwrap();
    assert_eq!(
        setup.slack().heard[0].authorization,
        format!("Bearer {TOKEN}")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refusal_is_an_answer_for_typescript_to_read() {
    let setup = Setup::connected().await;
    setup.slack().reply = Reply::NotOk("channel_not_found");
    let answer = setup.session().request(REPLIES, &no_query()).await.unwrap();
    assert_eq!(answer.status, 200);
    assert!(answer.body.contains("channel_not_found"), "{}", answer.body);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_429_hands_back_how_long_slack_asked_to_wait() {
    let setup = Setup::connected().await;
    setup.slack().reply = Reply::RateLimited;
    let answer = setup.session().request(REPLIES, &no_query()).await.unwrap();
    assert_eq!(answer.status, 429);
    assert_eq!(answer.retry_after, Some(30));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_redirect_is_handed_back_not_followed() {
    let setup = Setup::connected().await;
    setup.slack().reply = Reply::Redirect(format!("{}api/auth.test", setup.fake.origin));
    let answer = setup.session().request(REPLIES, &no_query()).await.unwrap();
    assert_eq!(answer.status, 302);
    assert_eq!(setup.heard(), 1, "the redirect was followed");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_answer_that_is_not_text_is_malformed_and_one_too_large_is_refused() {
    let setup = Setup::connected().await;
    setup.slack().reply = Reply::NotText;
    let failure = setup
        .session()
        .request(REPLIES, &no_query())
        .await
        .unwrap_err();
    assert_eq!(failure.kind, FailureKind::Malformed);
    setup.slack().reply = Reply::Oversized;
    let failure = setup
        .session()
        .request(REPLIES, &no_query())
        .await
        .unwrap_err();
    assert_eq!(failure.kind, FailureKind::TooLarge);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_slack_that_cannot_be_reached_is_unreachable() {
    let closed = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = closed.local_addr().unwrap().port();
    drop(closed);
    let origin = Url::parse(&format!("http://127.0.0.1:{port}")).unwrap();
    let session = Session {
        origin: &origin,
        store: Arc::new(MemoryStore::default()),
        scope: VAULT,
    };
    session.connect(TOKEN).await.unwrap();
    let failure = session.request(REPLIES, &no_query()).await.unwrap_err();
    assert_eq!(failure.kind, FailureKind::Unreachable);
    assert!(!failure.message.contains(TOKEN), "{}", failure.message);
    assert!(
        !failure.message.contains("127.0.0.1"),
        "{}",
        failure.message
    );
}

/// What Tauri would hand the webview for a command's result.
fn as_handed<T: serde::Serialize>(result: Result<T, SlackFailure>) -> String {
    match result {
        Ok(value) => serde_json::to_string(&value).unwrap(),
        Err(failure) => serde_json::to_string(&failure).unwrap(),
    }
}

/// #105's acceptance: no command answers with the token. Every value each
/// Slack command can hand the webview — its answer or its failure — is
/// serialized as Tauri would, with the fake echoing the Authorization header
/// it was sent, and searched for the token.
#[tokio::test(flavor = "multi_thread")]
async fn no_answer_or_failure_handed_to_the_webview_carries_the_token() {
    let setup = Setup::new().await;
    setup.slack().token = Some(TOKEN.into());
    setup.slack().echoes = true;
    let session = setup.session();
    let mut handed = vec![
        as_handed(session.connect(TOKEN).await),
        as_handed(session.status().await),
    ];
    let echoed = session.request("auth.test", &no_query()).await;
    assert!(echoed.as_ref().unwrap().body.contains("authorization"));
    handed.push(as_handed(echoed));
    for reply in [
        Reply::NotOk("message_not_found"),
        Reply::NotOk("missing_scope"),
        Reply::RateLimited,
        Reply::Redirect("https://evil.example/".into()),
        Reply::NotText,
        Reply::Oversized,
    ] {
        setup.slack().reply = reply;
        handed.push(as_handed(session.request(REPLIES, &no_query()).await));
    }
    setup.slack().token = Some("xoxp-the-one-slack-has-now".into());
    handed.push(as_handed(session.request(REPLIES, &no_query()).await));
    handed.push(as_handed(
        session.request("chat.postMessage", &no_query()).await,
    ));
    handed.push(as_handed(session.connect("not-a-token").await));
    handed.push(as_handed(session.disconnect().await));
    handed.push(as_handed(session.request(REPLIES, &no_query()).await));

    assert_eq!(setup.heard(), 8, "every reply was not exercised");
    assert!(
        handed
            .iter()
            .any(|value| value.contains("[secret slack-user-token removed]")),
        "no echo was struck, so the search below proves nothing"
    );
    for value in &handed {
        assert!(
            !value.contains(TOKEN),
            "the token reached the webview in {value}"
        );
    }
}

#[tokio::test(start_paused = true)]
async fn a_slack_that_never_answers_times_out() {
    let setup = Setup::connected().await;
    setup.slack().reply = Reply::Silent;
    let failure = setup
        .session()
        .request(REPLIES, &no_query())
        .await
        .unwrap_err();
    assert_eq!(failure.kind, FailureKind::Timeout, "{}", failure.message);
    assert!(!failure.message.contains(TOKEN), "{}", failure.message);
}

/// The Keychain can block on a prompt: the token is read on a thread kept
/// for blocking work, never on the async worker the request runs on.
#[tokio::test]
async fn the_token_is_read_off_the_async_worker() {
    struct Recording {
        inner: MemoryStore,
        read_on: Mutex<Vec<ThreadId>>,
    }
    impl SecretStore for Recording {
        fn set(&self, account: &str, value: &str) -> Result<(), String> {
            self.inner.set(account, value)
        }
        fn get(&self, account: &str) -> Result<Option<String>, String> {
            self.read_on.lock().unwrap().push(std::thread::current().id());
            self.inner.get(account)
        }
        fn delete(&self, account: &str) -> Result<(), String> {
            self.inner.delete(account)
        }
        fn accounts(&self) -> Result<Vec<String>, String> {
            self.inner.accounts()
        }
    }
    let fake = FakeSlack::start().await;
    fake.slack.lock().unwrap().token = Some(TOKEN.into());
    let store = Arc::new(Recording {
        inner: MemoryStore::default(),
        read_on: Mutex::new(Vec::new()),
    });
    store.inner.set("v1:apikey/slack", TOKEN).unwrap();
    let session = Session {
        origin: &fake.origin,
        store: store.clone(),
        scope: VAULT,
    };

    session.request(REPLIES, &no_query()).await.unwrap();
    session.status().await.unwrap();

    let worker = std::thread::current().id();
    let read_on = store.read_on.lock().unwrap().clone();
    assert_eq!(read_on.len(), 2, "the token was not read");
    assert!(
        read_on.iter().all(|thread| *thread != worker),
        "the Keychain was read on the async worker"
    );
}

#[test]
fn a_vault_switched_mid_call_is_said_as_slack_not_asked() {
    let switched = vault_refusal("another vault was opened before this could be written".into());
    assert_eq!(switched.kind, FailureKind::Invalid);
    assert_eq!(
        switched.message,
        "another vault was opened before Slack could be asked"
    );
    assert_eq!(
        vault_refusal("no vault is open".into()).message,
        "no vault is open"
    );
}

