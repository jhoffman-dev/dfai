//! The Calendar's events, as #31 reads them, through the host's one Calendar
//! command: the host builds none of these calls (TypeScript does), so what is
//! proved here is that it carries them to Google and back unchanged — the
//! query, the pages, the sync token's 410 and every error status — renews a
//! token Google ended, and hands no token back. Against the loopback fake.

use std::time::{Duration, Instant};

use super::*;
use crate::google::api::call_url;
use crate::google::Endpoints;

const EVENTS: &str = "/calendar/v3/calendars/primary/events";

const WINDOW: &str = "timeMin=2026-10-23T00%3A00%3A00-07%3A00&timeMax=2026-10-31T00%3A00%3A00%2B01%3A00&singleEvents=true&showDeleted=true&maxResults=250";

const PAGE_0: &str =
    r#"{"items":[{"id":"ev-standup","summary":"Larkspur Payroll stand-up"}],"nextPageToken":"p1"}"#;
const PAGE_1: &str =
    r#"{"items":[{"id":"ev-review","summary":"Review with Mara Quill"}],"nextSyncToken":"sync-1"}"#;

fn events(query: &str) -> ApiCall {
    get(&format!("{EVENTS}?{query}"))
}

async fn connected_with_pages() -> Setup {
    let setup = Setup::new().await;
    setup.connect(Browser::Allows).await.unwrap();
    setup.google().event_pages = vec![PAGE_0.into(), PAGE_1.into()];
    setup
}

fn refreshes(setup: &Setup) -> usize {
    setup
        .google()
        .token_forms
        .iter()
        .filter(|form| form["grant_type"] == "refresh_token")
        .count()
}

#[tokio::test(flavor = "multi_thread")]
async fn an_events_query_reaches_google_exactly_as_typescript_built_it() {
    let setup = connected_with_pages().await;

    let answer = setup
        .session()
        .call(&events(WINDOW), Service::Calendar)
        .await
        .unwrap();

    assert_eq!(answer.status, 200);
    assert_eq!(setup.google().event_queries, vec![WINDOW.to_string()]);
}

#[tokio::test(flavor = "multi_thread")]
async fn each_page_is_answered_and_the_last_carries_the_sync_token() {
    let setup = connected_with_pages().await;
    let session = setup.session();

    let first = session
        .call(&events(WINDOW), Service::Calendar)
        .await
        .unwrap();
    let second = session
        .call(
            &events(&format!("{WINDOW}&pageToken=p1")),
            Service::Calendar,
        )
        .await
        .unwrap();

    assert_eq!((first.status, first.body.as_str()), (200, PAGE_0));
    assert_eq!((second.status, second.body.as_str()), (200, PAGE_1));
    assert!(second.body.contains(r#""nextSyncToken":"sync-1""#));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_live_sync_token_is_answered_and_a_stale_one_is_handed_back_as_410() {
    let setup = connected_with_pages().await;
    setup.google().live_sync_tokens.insert("sync-1".into());
    let session = setup.session();

    let live = session
        .call(
            &events("syncToken=sync-1&singleEvents=true"),
            Service::Calendar,
        )
        .await
        .unwrap();
    let stale = session
        .call(
            &events("syncToken=sync-0&singleEvents=true"),
            Service::Calendar,
        )
        .await
        .unwrap();

    assert_eq!(live.status, 200);
    assert_eq!(stale.status, 410);
    assert!(stale.body.contains("fullSyncRequired"), "{}", stale.body);
}

#[tokio::test(flavor = "multi_thread")]
async fn error_statuses_are_handed_back_as_answers_without_a_new_token() {
    let setup = connected_with_pages().await;
    let before = refreshes(&setup);
    for status in [403_u16, 429, 500, 503] {
        let body = format!(r#"{{"error":{{"code":{status}}}}}"#);
        setup
            .google()
            .scripted_answers
            .push_back((status, body.clone().into_bytes()));

        let answer = setup
            .session()
            .call(&events(WINDOW), Service::Calendar)
            .await
            .unwrap();

        assert_eq!((answer.status, answer.body), (status, body));
    }
    assert_eq!(refreshes(&setup), before);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_token_google_ended_between_pages_is_renewed_once_and_the_page_answered() {
    let setup = connected_with_pages().await;
    let session = setup.session();
    session
        .call(&events(WINDOW), Service::Calendar)
        .await
        .unwrap();
    let before = refreshes(&setup);
    setup.google().expire_access_tokens();

    let second = session
        .call(
            &events(&format!("{WINDOW}&pageToken=p1")),
            Service::Calendar,
        )
        .await
        .unwrap();

    assert_eq!((second.status, second.body.as_str()), (200, PAGE_1));
    assert_eq!(refreshes(&setup), before + 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_revoked_sign_in_fails_the_events_call_as_invalid_grant_with_no_token_in_it() {
    let setup = connected_with_pages().await;
    setup.google().revoke_everything();
    setup.state.held.forget_access(VAULT);

    let failure = setup
        .session()
        .call(&events(WINDOW), Service::Calendar)
        .await
        .unwrap_err();

    assert_eq!(failure.kind, FailureKind::TokenRefused);
    assert_eq!(failure.code.as_deref(), Some("invalid_grant"));
    let handed = serde_json::to_string(&failure).unwrap();
    for token in &setup.google().ever_issued {
        assert!(!handed.contains(token.as_str()), "{token} in {handed}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_api_that_never_answers_is_unreachable_once_the_call_runs_out_of_time() {
    let setup = connected_with_pages().await;
    let short = Endpoints {
        authorize: setup.fake.endpoints.authorize.clone(),
        token: setup.fake.endpoints.token.clone(),
        revoke: setup.fake.endpoints.revoke.clone(),
        api: setup.fake.endpoints.api.clone(),
        request_timeout: Duration::from_millis(500),
    };
    let session = Session {
        endpoints: &short,
        store: &setup.store,
        scope: VAULT,
        state: &setup.state,
    };
    setup.google().api_stalls = true;
    let started = Instant::now();

    let failure = session
        .call(&events(WINDOW), Service::Calendar)
        .await
        .unwrap_err();

    assert_eq!(failure.kind, FailureKind::Unreachable);
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_body_that_is_not_text_is_malformed_and_text_that_is_not_json_is_handed_back() {
    let setup = connected_with_pages().await;
    setup
        .google()
        .scripted_answers
        .push_back((200, vec![0xff, 0xfe, 0x00, 0x7b]));
    setup
        .google()
        .scripted_answers
        .push_back((200, b"{not json".to_vec()));
    let session = setup.session();

    let binary = session
        .call(&events(WINDOW), Service::Calendar)
        .await
        .unwrap_err();
    let text = session
        .call(&events(WINDOW), Service::Calendar)
        .await
        .unwrap();

    assert_eq!(binary.kind, FailureKind::Malformed);
    assert_eq!((text.status, text.body.as_str()), (200, "{not json"));
}

#[tokio::test(flavor = "multi_thread")]
async fn an_events_answer_echoing_the_token_is_handed_back_with_it_struck() {
    let setup = connected_with_pages().await;
    setup.google().api_echoes = true;

    let answer = setup
        .session()
        .call(&events(WINDOW), Service::Calendar)
        .await
        .unwrap();

    assert!(answer.body.contains("authorization"), "{}", answer.body);
    let handed = serde_json::to_string(&answer).unwrap();
    for token in &setup.google().ever_issued {
        assert!(!handed.contains(token.as_str()), "{token} in {handed}");
    }
}

#[test]
fn an_events_path_stays_under_the_calendar_api_whatever_its_calendar_id() {
    let api = Url::parse("https://www.googleapis.com/").unwrap();
    // An encoded slash is part of the id, not a step up: it stays one segment.
    let encoded = call_url(
        &api,
        "/calendar/v3/calendars/..%2F..%2Fgmail%2Fv1/events",
        Service::Calendar,
    )
    .unwrap();
    assert!(
        encoded.path().starts_with("/calendar/v3/calendars/"),
        "{encoded}"
    );
    for path in [
        "/calendar/v3/calendars/../../../gmail/v1/users/me/messages",
        "/calendar/v3/calendars/%2e%2e/%2e%2e/%2e%2e/oauth2/v4/token",
    ] {
        assert!(call_url(&api, path, Service::Calendar).is_err(), "{path}");
    }
}
