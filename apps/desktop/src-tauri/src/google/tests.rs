//! The sign-in end to end, against a fake Google on this machine's loopback:
//! the browser, the redirect, the token endpoint, the API and revocation are
//! real HTTP, and the Keychain is the in-memory store.

use std::time::Duration;

use reqwest::Url;

use super::fake_google::{Browser, CodeAnswer, FakeGoogle, CLIENT_ID, SCOPE};
use super::grant;
use super::{
    ApiCall, ConnectRequest, FailureKind, GoogleConnection, GoogleFailure, GoogleState, Service,
    Session, SignIn,
};
use crate::secrets::{MemoryStore, SecretStore};

const VAULT: &str = "v1";
const CLIENT_SECRET: &str = "GOCSPX-fictional-secret";

/// The sign-in a test waits for. Long, because time is paused where the test
/// is about it running out, and real everywhere else.
const PATIENCE: Duration = Duration::from_secs(30);

struct Setup {
    fake: FakeGoogle,
    store: MemoryStore,
    state: GoogleState,
}

impl Setup {
    async fn new() -> Self {
        Self {
            fake: FakeGoogle::start().await,
            store: MemoryStore::default(),
            state: GoogleState::default(),
        }
    }

    fn session(&self) -> Session<'_> {
        self.session_for(VAULT)
    }

    fn session_for<'a>(&'a self, scope: &'a str) -> Session<'a> {
        Session {
            endpoints: &self.fake.endpoints,
            store: &self.store,
            scope,
            state: &self.state,
        }
    }

    async fn connect_as(
        &self,
        person: Browser,
        client_secret: Option<&str>,
    ) -> Result<GoogleConnection, GoogleFailure> {
        let open = self.fake.browser(person);
        let sign_in = SignIn {
            open: &open,
            timeout: PATIENCE,
        };
        self.session()
            .connect(&request(client_secret), &sign_in)
            .await
    }

    async fn connect(&self, person: Browser) -> Result<GoogleConnection, GoogleFailure> {
        self.connect_as(person, None).await
    }

    fn kept(&self) -> Option<grant::Grant> {
        grant::load(&self.store, VAULT).unwrap()
    }

    fn google(&self) -> std::sync::MutexGuard<'_, super::fake_google::Google> {
        self.fake.google.lock().unwrap()
    }
}

fn request(client_secret: Option<&str>) -> ConnectRequest {
    ConnectRequest {
        client_id: CLIENT_ID.into(),
        client_secret: client_secret.map(str::to_string),
        scopes: vec![SCOPE.into()],
    }
}

fn get(path: &str) -> ApiCall {
    ApiCall {
        method: "GET".into(),
        path: path.into(),
        body: None,
        content_type: None,
    }
}

fn create_calendar() -> ApiCall {
    ApiCall {
        method: "POST".into(),
        path: "/calendar/v3/calendars".into(),
        body: Some(r#"{"summary":"DFAI blocks"}"#.into()),
        content_type: None,
    }
}

const CALENDAR_LIST: &str = "/calendar/v3/users/me/calendarList?minAccessRole=owner";

#[tokio::test(flavor = "multi_thread")]
async fn connecting_keeps_the_refresh_token_and_lists_the_dedicated_calendar() {
    let setup = Setup::new().await;

    let connection = setup.connect(Browser::Allows).await.unwrap();
    assert!(connection.connected);
    assert_eq!(connection.client_id.as_deref(), Some(CLIENT_ID));
    assert_eq!(connection.scopes, vec![SCOPE.to_string()]);

    let kept = setup.kept().expect("the refresh token was kept");
    assert!(kept.refresh_token.starts_with("1//REFRESH-"));
    assert_eq!(setup.session().status().unwrap(), connection);

    setup
        .session()
        .call(&create_calendar(), Service::Calendar)
        .await
        .unwrap();
    let listed = setup
        .session()
        .call(&get(CALENDAR_LIST), Service::Calendar)
        .await
        .unwrap();
    assert_eq!(listed.status, 200);
    assert!(
        listed.body.contains(r#""summary":"DFAI blocks""#),
        "{}",
        listed.body
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_code_is_traded_with_the_verifier_behind_the_challenge_the_browser_carried() {
    let setup = Setup::new().await;
    setup.connect(Browser::Allows).await.unwrap();

    // The fake refuses a code whose verifier does not hash to the challenge
    // it recorded; this is what was sent, for the record.
    let google = setup.google();
    let form = google.token_forms.first().expect("the code was traded");
    assert_eq!(form["grant_type"], "authorization_code");
    assert_eq!(form["code_verifier"].len(), 43);
    assert!(form["redirect_uri"].starts_with("http://127.0.0.1:"));
    assert!(!form.contains_key("client_secret"));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_authorization_url_asks_for_a_refresh_token_with_s256() {
    let setup = Setup::new().await;
    let seen = std::sync::Mutex::new(None::<Url>);
    let browser = setup.fake.browser(Browser::Allows);
    let open = |url: &Url| {
        *seen.lock().unwrap() = Some(url.clone());
        browser(url)
    };
    let sign_in = SignIn {
        open: &open,
        timeout: PATIENCE,
    };
    setup
        .session()
        .connect(&request(None), &sign_in)
        .await
        .unwrap();

    let url = seen.lock().unwrap().clone().unwrap();
    let query: std::collections::HashMap<String, String> = url.query_pairs().into_owned().collect();
    assert_eq!(query["response_type"], "code");
    assert_eq!(query["code_challenge_method"], "S256");
    assert_eq!(query["access_type"], "offline");
    assert_eq!(query["prompt"], "consent");
    assert_eq!(query["include_granted_scopes"], "true");
    assert_eq!(query["scope"], SCOPE);
    assert_eq!(query["client_id"], CLIENT_ID);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_redirect_with_another_state_is_ignored_and_its_code_never_spent() {
    let setup = Setup::new().await;

    setup.connect(Browser::AllowsAfterAStranger).await.unwrap();

    let google = setup.google();
    assert_eq!(google.codes_sent.len(), 1);
    assert!(!google
        .codes_sent
        .iter()
        .any(|code| code.contains("STRANGER")));
}

#[tokio::test(flavor = "multi_thread")]
async fn refused_consent_ends_the_sign_in_with_googles_code_and_keeps_nothing() {
    let setup = Setup::new().await;

    let failure = setup.connect(Browser::Denies).await.unwrap_err();

    assert_eq!(failure.kind, FailureKind::Refused);
    assert_eq!(failure.code.as_deref(), Some("access_denied"));
    assert!(setup.kept().is_none());
    assert!(setup.google().codes_sent.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_redirect_with_neither_code_nor_error_is_malformed() {
    let setup = Setup::new().await;

    let failure = setup.connect(Browser::ComesBackEmpty).await.unwrap_err();

    assert_eq!(failure.kind, FailureKind::Malformed);
    assert!(setup.kept().is_none());
}

#[tokio::test(start_paused = true)]
async fn a_browser_that_never_comes_back_times_out_and_the_next_sign_in_can_start() {
    let setup = Setup::new().await;

    let failure = setup.connect(Browser::Abandons).await.unwrap_err();

    assert_eq!(failure.kind, FailureKind::Timeout);
    assert!(setup.kept().is_none());
    assert!(setup.state.begin_sign_in().is_ok());
}

#[tokio::test(flavor = "multi_thread")]
async fn cancelling_ends_the_sign_in_waiting_in_the_browser() {
    let setup = Setup::new().await;
    // The person clicks Cancel in DFAI once the browser is open.
    let open = |_: &Url| {
        setup.state.cancel_sign_in();
        Ok(())
    };
    let sign_in = SignIn {
        open: &open,
        timeout: PATIENCE,
    };

    let failure = setup
        .session()
        .connect(&request(None), &sign_in)
        .await
        .unwrap_err();

    assert_eq!(failure.kind, FailureKind::Cancelled);
    assert!(setup.state.begin_sign_in().is_ok());
}

#[tokio::test(flavor = "multi_thread")]
async fn only_one_sign_in_waits_at_a_time() {
    let state = GoogleState::default();
    let first = state.begin_sign_in().unwrap();
    assert_eq!(state.begin_sign_in().err().unwrap().kind, FailureKind::Busy);
    drop(first);
    assert!(state.begin_sign_in().is_ok());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_token_answer_that_is_not_oauth_is_malformed_and_nothing_is_kept() {
    let setup = Setup::new().await;
    setup.google().code_answer = Some(CodeAnswer::NotJson);

    let failure = setup.connect(Browser::Allows).await.unwrap_err();

    assert_eq!(failure.kind, FailureKind::Malformed);
    assert!(setup.kept().is_none());
}

/// Google answered, at length: that is not a Google that cannot be reached.
#[tokio::test(flavor = "multi_thread")]
async fn a_token_answer_larger_than_the_cap_is_malformed_and_nothing_is_kept() {
    let setup = Setup::new().await;
    setup.google().code_answer = Some(CodeAnswer::Oversized);

    let failure = setup.connect(Browser::Allows).await.unwrap_err();

    assert_eq!(failure.kind, FailureKind::Malformed, "{}", failure.message);
    assert!(setup.kept().is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn without_a_refresh_token_nothing_is_kept() {
    let setup = Setup::new().await;
    setup.google().code_answer = Some(CodeAnswer::WithoutRefreshToken);

    let failure = setup.connect(Browser::Allows).await.unwrap_err();

    assert_eq!(failure.kind, FailureKind::Malformed);
    assert!(setup.kept().is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_sign_in_without_the_calendar_scope_is_revoked_not_kept() {
    let setup = Setup::new().await;
    setup.google().code_answer = Some(CodeAnswer::WithoutTheScope);

    let failure = setup.connect(Browser::Allows).await.unwrap_err();

    assert_eq!(failure.kind, FailureKind::ScopeNotGranted);
    assert!(setup.kept().is_none());
    assert_eq!(setup.google().revoked.len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_access_token_google_ended_early_is_renewed_and_the_call_tried_once_more() {
    let setup = Setup::new().await;
    setup.connect(Browser::Allows).await.unwrap();
    setup.google().expire_access_tokens();

    let listed = setup
        .session()
        .call(&get(CALENDAR_LIST), Service::Calendar)
        .await
        .unwrap();

    assert_eq!(listed.status, 200);
    let google = setup.google();
    let refreshes = google
        .token_forms
        .iter()
        .filter(|form| form["grant_type"] == "refresh_token")
        .count();
    assert_eq!(refreshes, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_access_token_near_its_end_is_renewed_before_the_call() {
    let setup = Setup::new().await;
    setup.connect(Browser::Allows).await.unwrap();
    // Held, but inside the margin: it would die on the way.
    let nearly_over = super::held::Access {
        value: "ya29.NEARLY-OVER",
        expires_in: 30,
    };
    setup
        .state
        .held
        .replace(VAULT, || Ok(()), Some(&nearly_over))
        .unwrap();

    setup
        .session()
        .call(&get(CALENDAR_LIST), Service::Calendar)
        .await
        .unwrap();

    let google = setup.google();
    assert!(google
        .token_forms
        .iter()
        .any(|form| form["grant_type"] == "refresh_token"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_held_access_token_with_time_left_is_used_without_a_refresh() {
    let setup = Setup::new().await;
    setup.connect(Browser::Allows).await.unwrap();

    setup
        .session()
        .call(&get(CALENDAR_LIST), Service::Calendar)
        .await
        .unwrap();

    let google = setup.google();
    assert!(google
        .token_forms
        .iter()
        .all(|form| form["grant_type"] != "refresh_token"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refresh_token_google_no_longer_honours_is_reported_as_invalid_grant() {
    let setup = Setup::new().await;
    setup.connect(Browser::Allows).await.unwrap();
    setup.google().revoke_everything();

    let failure = setup
        .session()
        .call(&get(CALENDAR_LIST), Service::Calendar)
        .await
        .unwrap_err();

    assert_eq!(failure.kind, FailureKind::TokenRefused);
    assert_eq!(failure.code.as_deref(), Some("invalid_grant"));
}

#[tokio::test(flavor = "multi_thread")]
async fn disconnecting_revokes_the_sign_in_and_forgets_it() {
    let setup = Setup::new().await;
    setup.connect(Browser::Allows).await.unwrap();
    let refresh = setup.kept().unwrap().refresh_token;

    let disconnected = setup.session().disconnect().await.unwrap();

    assert!(disconnected.revoked);
    assert!(setup.kept().is_none());
    assert_eq!(setup.google().revoked, vec![refresh]);
    assert!(!setup.session().status().unwrap().connected);
    let failure = setup
        .session()
        .call(&get(CALENDAR_LIST), Service::Calendar)
        .await
        .unwrap_err();
    assert_eq!(failure.kind, FailureKind::NotConnected);
}

#[tokio::test(flavor = "multi_thread")]
async fn disconnecting_while_google_cannot_be_told_still_forgets_and_says_so() {
    let setup = Setup::new().await;
    setup.connect(Browser::Allows).await.unwrap();
    setup.google().revoke_unreachable = true;

    let disconnected = setup.session().disconnect().await.unwrap();

    assert!(!disconnected.revoked);
    assert!(setup.kept().is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn disconnecting_a_sign_in_google_already_ended_counts_as_revoked() {
    let setup = Setup::new().await;
    setup.connect(Browser::Allows).await.unwrap();
    // Removed from the Google account's settings, say, before DFAI was told.
    setup.google().revoke_everything();

    let disconnected = setup.session().disconnect().await.unwrap();

    assert!(disconnected.revoked);
    assert!(setup.kept().is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_client_secret_is_sent_when_google_needs_one_and_kept_for_the_next_sign_in() {
    let setup = Setup::new().await;
    setup.google().client_secret = Some(CLIENT_SECRET.into());

    let without = setup.connect(Browser::Allows).await.unwrap_err();
    assert_eq!(without.code.as_deref(), Some("invalid_client"));

    setup
        .connect_as(Browser::Allows, Some(CLIENT_SECRET))
        .await
        .unwrap();
    // Connecting again, for the same client, need not ask for it twice.
    setup.connect(Browser::Allows).await.unwrap();
    setup.google().expire_access_tokens();
    setup
        .session()
        .call(&get(CALENDAR_LIST), Service::Calendar)
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn one_vaults_sign_in_is_never_used_for_another() {
    let setup = Setup::new().await;
    setup.connect(Browser::Allows).await.unwrap();

    let other = setup.session_for("v2");

    assert!(!other.status().unwrap().connected);
    let failure = other
        .call(&get(CALENDAR_LIST), Service::Calendar)
        .await
        .unwrap_err();
    assert_eq!(failure.kind, FailureKind::NotConnected);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_call_off_the_calendar_api_is_refused_before_any_token_is_sent() {
    let setup = Setup::new().await;
    setup.connect(Browser::Allows).await.unwrap();

    for path in ["/oauth2/v4/token", "/calendar/v3/../../gmail/v1/users/me"] {
        let failure = setup
            .session()
            .call(&get(path), Service::Calendar)
            .await
            .unwrap_err();
        assert_eq!(failure.kind, FailureKind::Invalid, "{path}");
    }
}

/// P31-03's acceptance: no command answers with a token. Every value each
/// Google command can hand the webview — its answer or its failure — is
/// serialized as Tauri would, and searched for every token the fake issued,
/// every code, and the client secret. The API is made to echo the token back.
/// What Tauri would hand the webview for a command's result.
fn as_handed<T: serde::Serialize>(result: Result<T, GoogleFailure>) -> String {
    match result {
        Ok(value) => serde_json::to_string(&value).unwrap(),
        Err(failure) => serde_json::to_string(&failure).unwrap(),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn no_answer_or_failure_handed_to_the_webview_carries_a_token() {
    let setup = Setup::new().await;
    setup.google().client_secret = Some(CLIENT_SECRET.into());
    setup.google().api_echoes = true;
    let session = setup.session();
    let mut handed = vec![
        as_handed(setup.connect_as(Browser::Allows, Some(CLIENT_SECRET)).await),
        as_handed(session.status()),
    ];
    let echoed = session.call(&get(CALENDAR_LIST), Service::Calendar).await;
    assert!(echoed.as_ref().unwrap().body.contains("authorization"));
    handed.push(as_handed(echoed));
    setup.google().expire_access_tokens();
    handed.push(as_handed(
        session.call(&get(CALENDAR_LIST), Service::Calendar).await,
    ));
    setup.google().revoke_everything();
    setup.state.held.forget_access(VAULT);
    handed.push(as_handed(
        session.call(&get(CALENDAR_LIST), Service::Calendar).await,
    ));
    handed.push(as_handed(setup.connect(Browser::Denies).await));
    handed.push(as_handed(session.disconnect().await));

    let google = setup.google();
    let mut tokens = google.ever_issued.clone();
    for form in &google.token_forms {
        tokens.extend(
            ["refresh_token", "code_verifier"]
                .iter()
                .filter_map(|field| form.get(*field).cloned()),
        );
    }
    tokens.push(CLIENT_SECRET.into());
    assert!(tokens.len() > 8, "the fake issued too little to check");
    for value in &handed {
        for token in &tokens {
            assert!(
                !value.contains(token.as_str()),
                "{token} reached the webview in {value}"
            );
        }
    }
}

#[test]
fn the_store_holds_nothing_but_the_grant_after_connecting() {
    // The access token is memory only: nothing else is written to the Keychain.
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let setup = Setup::new().await;
        setup.connect(Browser::Allows).await.unwrap();
        let accounts = setup.store.accounts().unwrap();
        assert_eq!(accounts, vec![format!("{VAULT}:oauth/google")]);
        let stored = setup.store.get(&accounts[0]).unwrap().unwrap();
        assert!(
            !stored.contains("ya29."),
            "an access token was kept: {stored}"
        );
    });
}

#[tokio::test(flavor = "multi_thread")]
async fn the_browser_hears_connected_only_once_the_sign_in_is_kept() {
    let setup = Setup::new().await;
    setup.connect(Browser::Allows).await.unwrap();
    assert_eq!(
        pages_shown(&setup).await,
        vec![page_saying("DFAI is connected to Google Calendar.")]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_browser_hears_not_connected_when_the_sign_in_is_not_kept() {
    let setup = Setup::new().await;
    setup.google().code_answer = Some(CodeAnswer::WithoutTheScope);

    setup.connect(Browser::Allows).await.unwrap_err();

    let pages = pages_shown(&setup).await;
    assert_eq!(pages.len(), 1);
    assert!(pages[0].contains("DFAI was not connected"), "{}", pages[0]);
}

/// What the browser's tab showed, once it has read the page: the sign-in
/// settles as the page is sent, not when the browser has read it.
async fn pages_shown(setup: &Setup) -> Vec<String> {
    let read = async {
        loop {
            let pages = setup.google().pages.clone();
            if !pages.is_empty() {
                return pages;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    };
    tokio::time::timeout(PATIENCE, read)
        .await
        .expect("the browser's tab never showed a page")
}

/// The page the loopback answers with, around `text`.
fn page_saying(text: &str) -> String {
    let pages = [
        "DFAI is connected to Google Calendar. You can close this tab.",
        "DFAI was not connected to Google Calendar. You can close this tab; DFAI says why in Settings.",
    ];
    let full = pages.iter().find(|page| page.starts_with(text)).unwrap();
    format!(
        "<!doctype html><meta charset=\"utf-8\"><title>DFAI</title>\
         <body style=\"font:16px system-ui;margin:3em\"><p>{full}</p>"
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn disconnecting_a_vault_whose_client_another_vault_shares_forgets_without_revoking() {
    let setup = Setup::new().await;
    setup.connect(Browser::Allows).await.unwrap();
    let other = setup.session_for("v2");
    let open = setup.fake.browser(Browser::Allows);
    let sign_in = SignIn {
        open: &open,
        timeout: PATIENCE,
    };
    other.connect(&request(None), &sign_in).await.unwrap();

    let disconnected = setup.session().disconnect().await.unwrap();

    assert!(disconnected.shared);
    assert!(!disconnected.revoked);
    assert!(setup.kept().is_none());
    assert!(setup.google().revoked.is_empty());
    other
        .call(&get(CALENDAR_LIST), Service::Calendar)
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn disconnecting_a_vault_whose_client_no_other_vault_uses_revokes() {
    let setup = Setup::new().await;
    setup.connect(Browser::Allows).await.unwrap();

    let disconnected = setup.session().disconnect().await.unwrap();

    assert!(!disconnected.shared);
    assert!(disconnected.revoked);
}

// ---------------------------------------------------------------------------
// Adversarial: answers the faithful fake never gives, and orderings it never
// produces. Each test below is a defect report; all ids are fictional.
// ---------------------------------------------------------------------------

/// A token endpoint, revocation and API that answer as a test scripts them,
/// with the token endpoint (or `path`) optionally held until the test lets it
/// answer.
#[derive(Default)]
struct Hold {
    reached: tokio::sync::Notify,
    release: tokio::sync::Notify,
    path: Option<&'static str>,
}

type Script = dyn Fn(&str) -> (u16, String) + Send + Sync;

async fn scripted_google(
    script: std::sync::Arc<Script>,
    hold: Option<std::sync::Arc<Hold>>,
) -> &'static super::Endpoints {
    use http_body_util::Full;
    use hyper::body::Bytes;
    use hyper::service::service_fn;
    use hyper_util::rt::TokioIo;

    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let base = format!(
        "http://127.0.0.1:{}/",
        listener.local_addr().unwrap().port()
    );
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let (script, hold) = (script.clone(), hold.clone());
            let service = service_fn(move |request: hyper::Request<hyper::body::Incoming>| {
                let (script, hold) = (script.clone(), hold.clone());
                async move {
                    let path = request.uri().path().to_string();
                    let held = hold.filter(|hold| path == hold.path.unwrap_or("/token"));
                    if let Some(hold) = held {
                        hold.reached.notify_one();
                        hold.release.notified().await;
                    }
                    let (status, body) = script(&path);
                    let mut response = hyper::Response::new(Full::new(Bytes::from(body)));
                    *response.status_mut() = hyper::StatusCode::from_u16(status).unwrap();
                    Ok::<_, std::convert::Infallible>(response)
                }
            });
            tokio::spawn(
                hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(stream), service),
            );
        }
    });
    let at = |path: &str| Url::parse(&base).unwrap().join(path).unwrap();
    Box::leak(Box::new(super::Endpoints {
        authorize: at("/auth"),
        token: at("/token"),
        revoke: at("/revoke"),
        api: at("/"),
        request_timeout: super::token::REQUEST_TIMEOUT,
    }))
}

fn kept_grant(refresh_token: &str) -> grant::Grant {
    grant::Grant {
        client_id: CLIENT_ID.into(),
        client_secret: None,
        refresh_token: refresh_token.into(),
        scopes: vec![SCOPE.into()],
    }
}

fn leaked_session(endpoints: &'static super::Endpoints) -> Session<'static> {
    let store: &'static MemoryStore = Box::leak(Box::new(MemoryStore::default()));
    let state: &'static GoogleState = Box::leak(Box::new(GoogleState::default()));
    Session {
        endpoints,
        store,
        scope: VAULT,
        state,
    }
}

/// `expires_in` is read as any u64, and `Instant + Duration` panics past the
/// clock's range: a token answer the host cannot represent must be answered
/// somehow, not take the command down (its promise would never settle).
#[tokio::test(flavor = "multi_thread")]
async fn an_access_token_expiry_past_the_clocks_range_is_answered_not_a_panic() {
    let endpoints = scripted_google(
        std::sync::Arc::new(|path: &str| match path {
            "/token" => (
                200,
                r#"{"access_token":"ya29.FICTIONAL-FAR","expires_in":18446744073709551615,"token_type":"Bearer"}"#
                    .into(),
            ),
            _ => (200, r#"{"items":[]}"#.into()),
        }),
        None,
    )
    .await;
    let session = leaked_session(endpoints);
    grant::save(session.store, VAULT, &kept_grant("1//FICTIONAL-REFRESH")).unwrap();

    let outcome = tokio::spawn(async move {
        session
            .call(&get(CALENDAR_LIST), Service::Calendar)
            .await
            .map(|_| ())
    })
    .await;

    // Refused as malformed or held for a bounded time: either answers.
    assert!(
        outcome.is_ok(),
        "the call panicked on expires_in = u64::MAX instead of answering"
    );
}

/// The same answer at sign-in: the grant is written to the Keychain and only
/// then does the host panic, so the person is left with a kept sign-in and a
/// Connect button that never finishes (Cancel finds no sign-in to end).
#[tokio::test(flavor = "multi_thread")]
async fn a_sign_in_whose_token_expiry_overflows_the_clock_settles_and_keeps_what_it_says() {
    let endpoints = scripted_google(
        std::sync::Arc::new(|path: &str| match path {
            "/token" => (
                200,
                format!(
                    r#"{{"access_token":"ya29.FICTIONAL-FAR","expires_in":18446744073709551615,"refresh_token":"1//FICTIONAL-REFRESH","scope":"{SCOPE}"}}"#
                ),
            ),
            _ => (200, "{}".into()),
        }),
        None,
    )
    .await;
    let session = leaked_session(endpoints);
    let store = session.store;

    let outcome = tokio::spawn(async move {
        // A browser that comes straight back with this sign-in's state.
        let open = |url: &Url| {
            let query: std::collections::HashMap<String, String> =
                url.query_pairs().into_owned().collect();
            let back = format!(
                "{}?state={}&code=4/0A-FICTIONAL-CODE",
                query["redirect_uri"], query["state"]
            );
            tokio::spawn(async move { reqwest::get(back).await.map(|_| ()) });
            Ok(())
        };
        let sign_in = SignIn {
            open: &open,
            timeout: PATIENCE,
        };
        session.connect(&request(None), &sign_in).await.map(|_| ())
    })
    .await;

    let kept = grant::load(store, VAULT).unwrap();
    let Ok(connected) = outcome else {
        panic!(
            "connect panicked after keeping the grant (kept: {})",
            kept.is_some()
        );
    };
    assert_eq!(
        connected.is_ok(),
        kept.is_some(),
        "kept a sign-in that failed, or lost one that did not"
    );
}

/// A refresh that is under way when the person disconnects lands afterwards
/// and writes its (rotated) refresh token back to the Keychain: the sign-in
/// they just removed is kept again, and `status` says connected.
#[tokio::test(flavor = "multi_thread")]
async fn a_refresh_that_lands_after_disconnecting_does_not_bring_the_sign_in_back() {
    let hold = std::sync::Arc::new(Hold::default());
    let endpoints = scripted_google(
        std::sync::Arc::new(|path: &str| match path {
            "/token" => (
                200,
                r#"{"access_token":"ya29.FICTIONAL-LATE","expires_in":3599,"refresh_token":"1//FICTIONAL-ROTATED"}"#
                    .into(),
            ),
            "/revoke" => (200, "{}".into()),
            _ => (200, r#"{"items":[]}"#.into()),
        }),
        Some(hold.clone()),
    )
    .await;
    let session = leaked_session(endpoints);
    grant::save(session.store, VAULT, &kept_grant("1//FICTIONAL-ORIGINAL")).unwrap();

    let listing = get(CALENDAR_LIST);
    let (_, disconnected) = tokio::join!(session.call(&listing, Service::Calendar), async {
        hold.reached.notified().await;
        let disconnected = session.disconnect().await;
        hold.release.notify_one();
        disconnected
    });

    assert!(disconnected.unwrap().revoked);
    assert!(
        !session.status().unwrap().connected,
        "the sign-in is kept again after disconnecting: {:?}",
        grant::load(session.store, VAULT).unwrap()
    );
}

/// The same race without rotation, while Google cannot be told: the access
/// token the late refresh brought is held in memory and used for every call
/// for its hour, though the sign-in was forgotten and Settings says
/// disconnected.
#[tokio::test(flavor = "multi_thread")]
async fn no_access_token_outlives_a_disconnect() {
    let hold = std::sync::Arc::new(Hold::default());
    let endpoints = scripted_google(
        std::sync::Arc::new(|path: &str| match path {
            "/token" => (
                200,
                r#"{"access_token":"ya29.FICTIONAL-LATE","expires_in":3599}"#.into(),
            ),
            "/revoke" => (503, "unavailable".into()),
            _ => (200, r#"{"items":[]}"#.into()),
        }),
        Some(hold.clone()),
    )
    .await;
    let session = leaked_session(endpoints);
    grant::save(session.store, VAULT, &kept_grant("1//FICTIONAL-ORIGINAL")).unwrap();

    let listing = get(CALENDAR_LIST);
    let (_, disconnected) = tokio::join!(session.call(&listing, Service::Calendar), async {
        hold.reached.notified().await;
        let disconnected = session.disconnect().await;
        hold.release.notify_one();
        disconnected
    });
    assert!(!disconnected.unwrap().revoked);
    assert!(!session.status().unwrap().connected);

    let after = session.call(&get(CALENDAR_LIST), Service::Calendar).await;

    assert_eq!(
        after
            .map(|answer| answer.status)
            .map_err(|failure| failure.kind),
        Err(FailureKind::NotConnected),
        "a Calendar call went out with an access token after disconnecting"
    );
}

const FLOOD_TEST: &str =
    "google::tests::another_program_flooding_the_loopback_cannot_end_the_sign_in";
const FLOOD_CHILD: &str = "ATLAS_TEST_LOOPBACK_FLOOD_CHILD";

/// ADR-0030: "another program on the Mac can neither end the sign-in nor slip
/// its own code into it". A program that opens more connections to the
/// loopback than DFAI has file descriptors makes `accept` fail once, and
/// `Loopback::wait` turns that one transient error into the end of the
/// sign-in. (A Finder-launched app has 256 descriptors; the listener takes
/// connections without limit.) The flood comes from this test process; the
/// sign-in runs in a child of it with few descriptors, so no other test is
/// starved.
#[test]
fn another_program_flooding_the_loopback_cannot_end_the_sign_in() {
    if std::env::var_os(FLOOD_CHILD).is_some() {
        return flooded_sign_in();
    }
    use std::io::{BufRead, BufReader, Read, Write};
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", FLOOD_TEST, "--nocapture", "--test-threads=1"])
        .env(FLOOD_CHILD, "1")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut seen = String::new();
    let port: u16 = loop {
        let mut line = String::new();
        assert!(
            stdout.read_line(&mut line).unwrap() > 0,
            "no port from the child: {seen}"
        );
        // The harness prints the test's name on the same line, before it.
        if let Some((_, port)) = line.trim().split_once("ATLAS_LOOPBACK_PORT=") {
            break port.parse().unwrap();
        }
        seen.push_str(&line);
    };

    let flood: Vec<std::net::TcpStream> = (0..200)
        .filter_map(|_| {
            let at = (std::net::Ipv4Addr::LOCALHOST, port).into();
            std::net::TcpStream::connect_timeout(&at, std::time::Duration::from_millis(200)).ok()
        })
        .collect();
    // Fewer than were tried got through when the listener closed under them.
    let flooded = flood.len();
    drop(flood);
    // The child may already have given up; then there is no one to tell.
    let _ = writeln!(child.stdin.take().unwrap(), "come back");

    let mut rest = String::new();
    stdout.read_to_string(&mut rest).unwrap();
    let mut errors = String::new();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut errors)
        .unwrap();
    assert!(
        child.wait().unwrap().success(),
        "the sign-in ended under a flood of {flooded} connections:\n{rest}\n{errors}"
    );
}

/// The child's half: a sign-in with 64 descriptors, whose browser comes back
/// honestly once the parent's flood is over.
fn flooded_sign_in() {
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: plain syscalls on a struct this function owns.
    unsafe {
        libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit);
        limit.rlim_cur = 64;
        assert_eq!(libc::setrlimit(libc::RLIMIT_NOFILE, &limit), 0);
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    let connected = runtime.block_on(async {
        let setup = Setup::new().await;
        let honest = std::sync::Arc::new(setup.fake.browser(Browser::Allows));
        let open = move |url: &Url| {
            let redirect = url
                .query_pairs()
                .find(|(name, _)| name == "redirect_uri")
                .map(|(_, value)| value.into_owned())
                .unwrap();
            let port = Url::parse(&redirect).unwrap().port().unwrap();
            println!("ATLAS_LOOPBACK_PORT={port}");
            let (url, honest) = (url.clone(), honest.clone());
            tokio::spawn(async move {
                let _ =
                    tokio::task::spawn_blocking(|| std::io::stdin().read_line(&mut String::new()))
                        .await;
                honest(&url).unwrap();
            });
            Ok(())
        };
        let sign_in = SignIn {
            open: &open,
            timeout: PATIENCE,
        };

        setup.session().connect(&request(None), &sign_in).await
    });
    // The browser's task may still be waiting on stdin.
    runtime.shutdown_background();
    assert!(connected.is_ok(), "{:?}", connected.err());
}

/// A refresh still out when the person connects again must not write the
/// old sign-in's rotated token over the new one, nor hold its access token.
#[tokio::test(flavor = "multi_thread")]
async fn a_refresh_that_lands_after_connecting_again_leaves_the_new_sign_in_kept() {
    let hold = std::sync::Arc::new(Hold::default());
    let endpoints = scripted_google(
        std::sync::Arc::new(|path: &str| match path {
            "/token" => (
                200,
                r#"{"access_token":"ya29.FICTIONAL-LATE","expires_in":3599,"refresh_token":"1//FICTIONAL-ROTATED"}"#
                    .into(),
            ),
            _ => (200, r#"{"items":[]}"#.into()),
        }),
        Some(hold.clone()),
    )
    .await;
    let session = leaked_session(endpoints);
    grant::save(session.store, VAULT, &kept_grant("1//FICTIONAL-ORIGINAL")).unwrap();

    let listing = get(CALENDAR_LIST);
    let (late, _) = tokio::join!(session.call(&listing, Service::Calendar), async {
        hold.reached.notified().await;
        // What connecting again keeps, as `keep` does.
        let newer = kept_grant("1//FICTIONAL-NEWER");
        let access = super::held::Access {
            value: "ya29.FICTIONAL-NEWER",
            expires_in: 3599,
        };
        session
            .state
            .held
            .replace(
                VAULT,
                || grant::save(session.store, VAULT, &newer),
                Some(&access),
            )
            .unwrap();
        hold.release.notify_one();
    });

    assert_eq!(
        grant::load(session.store, VAULT)
            .unwrap()
            .map(|kept| kept.refresh_token),
        Some("1//FICTIONAL-NEWER".to_string())
    );
    assert_eq!(late.unwrap().status, 200);
    assert_eq!(
        session.state.held.current(VAULT).1.as_deref(),
        Some("ya29.FICTIONAL-NEWER")
    );
}

/// A call whose refresh lands after Disconnect does not go out with that
/// refresh's token: the sign-in it was for is gone.
#[tokio::test(flavor = "multi_thread")]
async fn a_call_whose_refresh_lands_after_disconnecting_is_not_connected() {
    let hold = std::sync::Arc::new(Hold::default());
    let endpoints = scripted_google(
        std::sync::Arc::new(|path: &str| match path {
            "/token" => (
                200,
                r#"{"access_token":"ya29.FICTIONAL-LATE","expires_in":3599}"#.into(),
            ),
            _ => (200, r#"{"items":[]}"#.into()),
        }),
        Some(hold.clone()),
    )
    .await;
    let session = leaked_session(endpoints);
    grant::save(session.store, VAULT, &kept_grant("1//FICTIONAL-ORIGINAL")).unwrap();

    let listing = get(CALENDAR_LIST);
    let (late, _) = tokio::join!(session.call(&listing, Service::Calendar), async {
        hold.reached.notified().await;
        session.disconnect().await.unwrap();
        hold.release.notify_one();
    });

    assert_eq!(
        late.map(|answer| answer.status)
            .map_err(|failure| failure.kind),
        Err(FailureKind::NotConnected)
    );
}

/// A refresh that starts and settles while Disconnect is revoking still
/// leaves no access token held once Disconnect has forgotten the sign-in.
#[tokio::test(flavor = "multi_thread")]
async fn a_refresh_made_during_the_revocation_leaves_no_token_held() {
    let hold = std::sync::Arc::new(Hold {
        path: Some("/revoke"),
        ..Hold::default()
    });
    let endpoints = scripted_google(
        std::sync::Arc::new(|path: &str| match path {
            "/token" => (
                200,
                r#"{"access_token":"ya29.FICTIONAL-DURING","expires_in":3599}"#.into(),
            ),
            "/revoke" => (200, "{}".into()),
            _ => (200, r#"{"items":[]}"#.into()),
        }),
        Some(hold.clone()),
    )
    .await;
    let session = leaked_session(endpoints);
    grant::save(session.store, VAULT, &kept_grant("1//FICTIONAL-ORIGINAL")).unwrap();

    let (disconnected, during) = tokio::join!(session.disconnect(), async {
        hold.reached.notified().await;
        let during = session.call(&get(CALENDAR_LIST), Service::Calendar).await;
        hold.release.notify_one();
        during
    });
    assert!(disconnected.unwrap().revoked);
    assert_eq!(during.unwrap().status, 200);

    let after = session.call(&get(CALENDAR_LIST), Service::Calendar).await;

    assert_eq!(
        after
            .map(|answer| answer.status)
            .map_err(|failure| failure.kind),
        Err(FailureKind::NotConnected)
    );
}

const DRIVE: &str = "https://www.googleapis.com/auth/drive.file";

fn drive_call(method: &str, path: &str, body: &str, content_type: Option<&str>) -> ApiCall {
    ApiCall {
        method: method.into(),
        path: path.into(),
        body: Some(body.into()),
        content_type: content_type.map(str::to_string),
    }
}

/// Signs in again asking for the Calendar's scope and Drive's, as an export does (#501).
async fn connect_with_drive(setup: &Setup) -> GoogleConnection {
    setup.google().granted_scope = Some(format!("{SCOPE} {DRIVE}"));
    let open = setup.fake.browser(Browser::Allows);
    let sign_in = SignIn {
        open: &open,
        timeout: PATIENCE,
    };
    let asking = ConnectRequest {
        scopes: vec![SCOPE.into(), DRIVE.into()],
        ..request(None)
    };
    setup.session().connect(&asking, &sign_in).await.unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn asking_for_drive_keeps_the_calendar_and_a_doc_is_uploaded_as_multipart() {
    let setup = Setup::new().await;
    setup.connect(Browser::Allows).await.unwrap();
    let connection = connect_with_drive(&setup).await;
    assert_eq!(
        connection.scopes,
        vec![SCOPE.to_string(), DRIVE.to_string()]
    );
    // The Calendar still answers on the grant that now reaches Drive too.
    setup
        .session()
        .call(&get(CALENDAR_LIST), Service::Calendar)
        .await
        .unwrap();

    let folder = r#"{"name":"Northwind exports","mimeType":"application/vnd.google-apps.folder"}"#;
    let made = setup
        .session()
        .call(
            &drive_call("POST", "/drive/v3/files", folder, None),
            Service::Drive,
        )
        .await
        .unwrap();
    assert_eq!(made.body, r#"{"id":"folder-1"}"#);

    let multipart = "multipart/related; boundary=atlas-export-1";
    let page =
        "--atlas-export-1\r\n\r\n{}\r\n--atlas-export-1\r\n\r\n<p>Hi</p>\r\n--atlas-export-1--";
    let path = "/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink";
    let uploaded = setup
        .session()
        .call(
            &drive_call("POST", path, page, Some(multipart)),
            Service::Drive,
        )
        .await
        .unwrap();
    assert_eq!(uploaded.status, 200);
    assert!(uploaded.body.contains("docs.example.com/document/d/doc-1"));
    assert_eq!(
        setup.google().uploads,
        vec![(multipart.to_string(), page.to_string())]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_drive_call_off_files_or_through_the_calendar_command_is_refused_before_any_token() {
    let setup = Setup::new().await;
    connect_with_drive(&setup).await;
    for path in [
        "/drive/v3/about",
        "/gmail/v1/users/me/messages",
        "/calendar/v3/calendars",
    ] {
        let failure = setup
            .session()
            .call(&drive_call("GET", path, "", None), Service::Drive)
            .await
            .unwrap_err();
        assert_eq!(failure.kind, FailureKind::Invalid, "{path}");
    }
    let through_calendar = setup
        .session()
        .call(
            &drive_call("GET", "/drive/v3/files", "", None),
            Service::Calendar,
        )
        .await
        .unwrap_err();
    assert_eq!(through_calendar.kind, FailureKind::Invalid);
    assert!(setup.google().drive_files.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_drive_sign_in_the_person_unticked_is_not_kept() {
    let setup = Setup::new().await;
    setup.connect(Browser::Allows).await.unwrap();
    // Google granted the Calendar only: the consent screen's Drive box was unticked.
    let open = setup.fake.browser(Browser::Allows);
    let sign_in = SignIn {
        open: &open,
        timeout: PATIENCE,
    };
    let asking = ConnectRequest {
        scopes: vec![SCOPE.into(), DRIVE.into()],
        ..request(None)
    };
    let failure = setup
        .session()
        .connect(&asking, &sign_in)
        .await
        .unwrap_err();
    assert_eq!(failure.kind, FailureKind::ScopeNotGranted);
}

/// Attack on PR #502: asking for Drive uses `include_granted_scopes=true`, so
/// the refresh token Google hands back carries the Calendar's scope as well.
/// Google ends the app's whole combined grant when any token of it is
/// revoked, so revoking the new token when the person unticks Drive also ends
/// the Calendar sign-in still kept in the Keychain. The unticked sign-in must
/// be dropped without revoking it.
#[tokio::test(flavor = "multi_thread")]
async fn attack_502_unticking_drive_never_revokes_the_combined_grant_the_calendar_rides_on() {
    let setup = Setup::new().await;
    setup.connect(Browser::Allows).await.unwrap();
    let open = setup.fake.browser(Browser::Allows);
    let sign_in = SignIn {
        open: &open,
        timeout: PATIENCE,
    };
    let asking = ConnectRequest {
        scopes: vec![SCOPE.into(), DRIVE.into()],
        ..request(None)
    };
    let failure = setup
        .session()
        .connect(&asking, &sign_in)
        .await
        .unwrap_err();
    assert_eq!(failure.kind, FailureKind::ScopeNotGranted);
    assert!(
        setup.google().revoked.is_empty(),
        "revoked {:?}: at Google that ends the Calendar's grant too",
        setup.google().revoked
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_calendar_still_refreshes_after_the_person_declines_drive() {
    let setup = Setup::new().await;
    setup.connect(Browser::Allows).await.unwrap();
    let open = setup.fake.browser(Browser::Allows);
    let sign_in = SignIn {
        open: &open,
        timeout: PATIENCE,
    };
    let asking = ConnectRequest {
        scopes: vec![SCOPE.into(), DRIVE.into()],
        ..request(None)
    };
    let declined = setup
        .session()
        .connect(&asking, &sign_in)
        .await
        .unwrap_err();
    assert_eq!(declined.kind, FailureKind::ScopeNotGranted);
    // The hour runs out: the Calendar's kept refresh token must still be live at Google.
    setup.google().expire_access_tokens();
    setup.state.held.forget_access(VAULT);
    setup
        .session()
        .call(&get(CALENDAR_LIST), Service::Calendar)
        .await
        .unwrap();
    assert_eq!(
        setup.session().status().unwrap().scopes,
        vec![SCOPE.to_string()]
    );
}

mod events;
