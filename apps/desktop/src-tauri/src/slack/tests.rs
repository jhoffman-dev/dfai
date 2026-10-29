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
            self.read_on
                .lock()
                .unwrap()
                .push(std::thread::current().id());
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

/// Attack on PR #631 (#105): a scripted Slack on loopback that answers raw
/// bytes, with pauses, so hostile answers can be sent exactly as written.
mod attack {
    use std::collections::BTreeMap;
    use std::net::Ipv4Addr;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD};
    use base64::Engine;
    use reqwest::Url;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::super::{FailureKind, Session, SlackAnswer, SlackFailure};
    use super::TOKEN;
    use crate::secrets::MemoryStore;

    const STRUCK: &str = "[secret slack-user-token removed]";

    #[derive(Clone)]
    enum Step {
        Send(Vec<u8>),
        Wait(Duration),
        Close,
    }

    struct Scripted {
        origin: Url,
        heads: Arc<Mutex<Vec<String>>>,
    }

    /// Answers every connection with `steps`, then holds it open.
    async fn scripted(steps: Vec<Step>) -> Scripted {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let heads = Arc::new(Mutex::new(Vec::new()));
        let recorded = heads.clone();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let (steps, recorded) = (steps.clone(), recorded.clone());
                tokio::spawn(async move {
                    let mut head = Vec::new();
                    let mut byte = [0u8; 1];
                    while !head.ends_with(b"\r\n\r\n") {
                        if stream.read(&mut byte).await.unwrap_or(0) == 0 {
                            return;
                        }
                        head.push(byte[0]);
                    }
                    recorded
                        .lock()
                        .unwrap()
                        .push(String::from_utf8_lossy(&head).into_owned());
                    for step in steps {
                        match step {
                            Step::Send(bytes) => {
                                if stream.write_all(&bytes).await.is_err() {
                                    return;
                                }
                            }
                            Step::Wait(time) => tokio::time::sleep(time).await,
                            Step::Close => return,
                        }
                    }
                    std::future::pending::<()>().await;
                });
            }
        });
        Scripted {
            origin: Url::parse(&format!("http://127.0.0.1:{port}")).unwrap(),
            heads,
        }
    }

    fn answer_with(headers: &str, body: &[u8]) -> Vec<Step> {
        let mut bytes = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n{headers}\r\n",
            body.len()
        )
        .into_bytes();
        bytes.extend_from_slice(body);
        vec![Step::Send(bytes)]
    }

    async fn ask(
        server: &Scripted,
        method: &str,
        query: &BTreeMap<String, String>,
    ) -> Result<SlackAnswer, SlackFailure> {
        let store = Arc::new(MemoryStore::default());
        let session = Session {
            origin: &server.origin,
            store,
            scope: "v1",
        };
        session.connect(TOKEN).await.unwrap();
        session.request(method, query).await
    }

    /// A small seeded generator: the same seed, the same forms.
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            self.0 >> 33
        }
        fn coin(&mut self) -> bool {
            self.next() % 2 == 0
        }
    }

    fn percent(c: char, upper: bool) -> String {
        let hex = format!("%{:02X}", c as u32);
        if upper {
            hex
        } else {
            hex.to_lowercase()
        }
    }

    /// One form the redaction says it strikes: per character plain, percent
    /// (either case, once or twice), or `\u`; or the whole as base64 after a
    /// prefix of any length, in any of the four alphabets; or JSON inside JSON.
    fn guarded_form(rng: &mut Lcg, token: &str) -> String {
        match rng.next() % 4 {
            0 => token
                .chars()
                .map(|c| match rng.next() % 4 {
                    0 => c.to_string(),
                    1 => percent(c, rng.coin()),
                    2 => percent(c, rng.coin()).replacen('%', "%25", 1),
                    _ => {
                        let hex = format!("{:04x}", c as u32);
                        let hex = if rng.coin() { hex.to_uppercase() } else { hex };
                        format!("\\u{hex}")
                    }
                })
                .collect(),
            1 => {
                let prefix: String = "Bearer xyz"
                    .chars()
                    .take((rng.next() % 8) as usize)
                    .collect();
                let plain = format!("{prefix}{token}");
                let engines = [STANDARD, URL_SAFE, STANDARD_NO_PAD, URL_SAFE_NO_PAD];
                engines[(rng.next() % 4) as usize].encode(plain)
            }
            2 => {
                let inner = serde_json::to_string(&serde_json::json!({ "auth": token })).unwrap();
                let once = serde_json::to_string(&inner).unwrap();
                once[1..once.len() - 1].to_string()
            }
            _ => token.replace('-', "\\u002d"),
        }
    }

    /// #105's acceptance, over 64 seeded encodings of the token: no answer
    /// handed back holds it in any form the redaction claims to strike.
    #[tokio::test(flavor = "multi_thread")]
    async fn no_seeded_encoding_of_the_token_reaches_the_webview() {
        let mut rng = Lcg(0x5EED_0105);
        for round in 0..64 {
            let form = guarded_form(&mut rng, TOKEN);
            let body = format!(r#"{{"ok":true,"echo":"{form}"}}"#);
            let server = scripted(answer_with("", body.as_bytes())).await;
            let answer = ask(&server, "auth.test", &BTreeMap::new()).await.unwrap();
            assert!(
                answer.body.contains(STRUCK) && !answer.body.contains(&form),
                "round {round}: {form} was not struck: {}",
                answer.body
            );
        }
    }

    /// The answer handed back for a body echoing `form`, which is the token.
    async fn handed_back_for(form: &str) -> String {
        let body = format!(r#"{{"ok":true,"echo":"{form}"}}"#);
        let server = scripted(answer_with("", body.as_bytes())).await;
        ask(&server, "auth.test", &BTreeMap::new())
            .await
            .unwrap()
            .body
    }

    /// Outside the forms the redaction lists: HTML numeric entities.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_token_as_html_entities_is_struck() {
        let form: String = TOKEN.chars().map(|c| format!("&#{};", c as u32)).collect();
        let body = handed_back_for(&form).await;
        assert!(!body.contains(&form), "the token went back as {body}");
    }

    /// Outside the forms the redaction lists: base64 wrapped into lines.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_token_as_line_wrapped_base64_is_struck() {
        let encoded = STANDARD.encode(format!(r#"{{"authorization":"Bearer {TOKEN}"}}"#));
        let form = encoded
            .as_bytes()
            .chunks(20)
            .map(|line| std::str::from_utf8(line).unwrap())
            .collect::<Vec<_>>()
            .join("\\r\\n");
        let body = handed_back_for(&form).await;
        assert!(!body.contains(&form), "the token went back as {body}");
    }

    /// Outside the forms the redaction lists: the token upper-cased.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_token_upper_cased_is_struck() {
        let form = TOKEN.to_uppercase();
        let body = handed_back_for(&form).await;
        assert!(!body.contains(&form), "the token went back as {body}");
    }

    /// The request is GET, to the method's path, with exactly the host's
    /// headers: no query value, however written, adds or splits a header.
    #[tokio::test(flavor = "multi_thread")]
    async fn no_query_value_adds_a_header_or_leaves_the_query() {
        let server = scripted(answer_with("", br#"{"ok":true}"#)).await;
        let hostile = [
            "a&b=c#d",
            "x\r\nX-Injected: 1",
            "%00\u{0}",
            "ünï\u{1F980}",
            &"L".repeat(8_000),
        ];
        let query: BTreeMap<String, String> = hostile
            .iter()
            .enumerate()
            .map(|(at, value)| (format!("k{at}\r\nX-Name: 1"), value.to_string()))
            .collect();
        ask(&server, "users.info", &query).await.unwrap();
        let head = server.heads.lock().unwrap()[0].clone();
        let mut lines = head.split("\r\n").filter(|line| !line.is_empty());
        let request_line = lines.next().unwrap();
        assert!(
            request_line.starts_with("GET /api/users.info?"),
            "{request_line}"
        );
        assert!(request_line.ends_with(" HTTP/1.1"), "{request_line}");
        let names: Vec<String> = lines
            .map(|line| line.split(':').next().unwrap().to_ascii_lowercase())
            .collect();
        assert_eq!(
            names,
            ["authorization", "accept", "user-agent", "host"],
            "{head}"
        );
        let target = request_line
            .trim_start_matches("GET ")
            .trim_end_matches(" HTTP/1.1");
        let sent = Url::parse(&format!("http://h{target}")).unwrap();
        let pairs: BTreeMap<String, String> = sent.query_pairs().into_owned().collect();
        assert_eq!(pairs, query);
        assert_eq!(sent.fragment(), None);
    }

    /// A Slack that sends its headers and then one byte every few seconds,
    /// forever, is cut off by the request's time limit.
    #[tokio::test(start_paused = true)]
    async fn an_answer_dripped_a_byte_at_a_time_is_cut_off_by_the_time_limit() {
        let mut steps = vec![Step::Send(
            b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n".to_vec(),
        )];
        for _ in 0..1_000 {
            steps.push(Step::Send(b"1\r\n \r\n".to_vec()));
            steps.push(Step::Wait(Duration::from_secs(5)));
        }
        // Ends the answer well past 30 s, so a limit that never fires fails, not hangs.
        steps.push(Step::Send(b"0\r\n\r\n".to_vec()));
        steps.push(Step::Close);
        let server = scripted(steps).await;
        let failure = ask(&server, "auth.test", &BTreeMap::new())
            .await
            .unwrap_err();
        assert_eq!(failure.kind, FailureKind::Timeout, "{}", failure.message);
    }

    /// A chunked answer with no length is held to the same cap as one that
    /// says its length.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_chunked_answer_past_the_cap_is_refused() {
        let chunk = vec![b' '; 1024 * 1024];
        let mut framed = format!("{:x}\r\n", chunk.len()).into_bytes();
        framed.extend_from_slice(&chunk);
        framed.extend_from_slice(b"\r\n");
        let mut steps = vec![Step::Send(
            b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n".to_vec(),
        )];
        steps.extend(std::iter::repeat_n(Step::Send(framed), 17));
        let server = scripted(steps).await;
        let failure = ask(&server, "auth.test", &BTreeMap::new())
            .await
            .unwrap_err();
        assert_eq!(failure.kind, FailureKind::TooLarge, "{}", failure.message);
    }

    /// Only a whole number of seconds is passed back as Slack's wait.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_retry_after_that_is_not_whole_seconds_is_none() {
        for (sent, read) in [
            ("30", Some(30)),
            (" 7 ", Some(7)),
            ("30.5", None),
            ("-1", None),
            ("Wed, 21 Oct 2026 07:28:00 GMT", None),
            ("18446744073709551616", None),
            ("", None),
        ] {
            let server = scripted(answer_with(
                &format!("retry-after: {sent}\r\n"),
                br#"{"ok":false,"error":"ratelimited"}"#,
            ))
            .await;
            let answer = ask(&server, "auth.test", &BTreeMap::new()).await.unwrap();
            assert_eq!(answer.retry_after, read, "Retry-After {sent:?}");
        }
    }
}
