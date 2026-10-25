//! Google Calendar, reached through a sign-in the host keeps (ADR-0030).
//!
//! The person signs in in their own browser: an OAuth 2.0 authorization-code
//! flow for a native app — a loopback redirect on 127.0.0.1 and PKCE (RFC
//! 8252, RFC 7636). The host makes the verifier and `state`, listens for the
//! redirect, trades the code for tokens, keeps the refresh token in the
//! Keychain and the access token in memory, and sends the calls. None of
//! those values is ever handed to the webview: what comes back is whether a
//! sign-in is kept, and an API call's answer with the tokens struck from it.
//!
//! What is decided in TypeScript, as every rule is (ADR-0005): which client
//! and which scopes to ask for, which calls to make and what their answers
//! mean, which calendar the blocks go to, and what each failure tells the
//! person. What the host holds is the protocol and where a token may go —
//! Google's endpoints, fixed here rather than named by the webview, the way
//! `model_http` fixes its one endpoint.

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use reqwest::Url;
use serde::Serialize;
use tauri::State;
use tokio::sync::Notify;

use crate::opener::open_web_link;
use crate::secrets::{redact_off_worker, vault_scope, SecretState, SecretStore};
use crate::vault::{root_for_write, VaultState};

pub use api::{ApiCall, GoogleAnswer, Service};
pub use failure::{FailureKind, GoogleFailure};
use grant::Grant;
use held::{Access, HeldSignIns};
use loopback::{Callback, Ending, Loopback};
use pkce::{new_state, Pkce};

const AUTHORIZE: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN: &str = "https://oauth2.googleapis.com/token";
const REVOKE: &str = "https://oauth2.googleapis.com/revoke";
const API: &str = "https://www.googleapis.com/";

/// Long enough to sign in, pick an account and read a consent screen.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);

/// How many times a call starts its refresh again when the sign-in changed
/// under it, before it gives up.
const REFRESH_ATTEMPTS: usize = 2;

/// Where each part of the flow is sent. Google's in the app; a local fake in
/// the tests, which is the only reason this is not four constants.
pub struct Endpoints {
    pub authorize: Url,
    pub token: Url,
    pub revoke: Url,
    pub api: Url,
    /// How long an API call may take before it counts as unreachable; short
    /// in the tests that are about it running out.
    pub request_timeout: Duration,
}

impl Endpoints {
    pub fn google() -> Self {
        let fixed = |url: &str| Url::parse(url).expect("a fixed Google endpoint parses");
        Self {
            authorize: fixed(AUTHORIZE),
            token: fixed(TOKEN),
            revoke: fixed(REVOKE),
            api: fixed(API),
            request_timeout: token::REQUEST_TIMEOUT,
        }
    }
}

/// Whether this vault has a sign-in on this Mac, and what it is for. Never a
/// token.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleConnection {
    pub connected: bool,
    pub client_id: Option<String>,
    pub scopes: Vec<String>,
}

impl GoogleConnection {
    fn of(grant: Option<&Grant>) -> Self {
        Self {
            connected: grant.is_some(),
            client_id: grant.map(|grant| grant.client_id.clone()),
            scopes: grant.map(|grant| grant.scopes.clone()).unwrap_or_default(),
        }
    }
}

/// What disconnecting did. The sign-in is always forgotten here; `revoked`
/// is false when Google was not told, so the person can remove DFAI's access
/// from their Google account themselves — and `shared` says it was not told
/// on purpose, because another vault on this Mac signs in with the same
/// client and revoking one grant may end the other's (ADR-0030).
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct GoogleDisconnection {
    pub revoked: bool,
    pub shared: bool,
}

/// What a sign-in asks Google for, as TypeScript decided it.
pub struct ConnectRequest {
    pub client_id: String,
    pub client_secret: Option<String>,
    pub scopes: Vec<String>,
}

/// The host's Google state: each vault's sign-in as held between calls, and
/// the sign-in waiting in the browser, if any.
#[derive(Default)]
pub struct GoogleState {
    held: HeldSignIns,
    signing_in: Mutex<Option<Arc<Notify>>>,
}

/// A lock on state whose every write is one whole value, so a thread that
/// panicked holding it cannot have left it half-changed (as `VaultState`).
fn held<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl GoogleState {
    /// Claims the one sign-in that may wait in the browser at a time.
    fn begin_sign_in(&self) -> Result<SigningIn<'_>, GoogleFailure> {
        let mut waiting = held(&self.signing_in);
        if waiting.is_some() {
            return Err(GoogleFailure::new(
                FailureKind::Busy,
                "a Google sign-in is already waiting in the browser",
            ));
        }
        let cancel = Arc::new(Notify::new());
        *waiting = Some(cancel.clone());
        Ok(SigningIn {
            state: self,
            cancel,
        })
    }

    /// Ends the sign-in waiting in the browser, if there is one.
    pub fn cancel_sign_in(&self) {
        if let Some(cancel) = held(&self.signing_in).as_ref() {
            cancel.notify_one();
        }
    }
}

/// The sign-in in progress; dropping it lets the next one start.
struct SigningIn<'a> {
    state: &'a GoogleState,
    cancel: Arc<Notify>,
}

impl Drop for SigningIn<'_> {
    fn drop(&mut self) {
        *held(&self.state.signing_in) = None;
    }
}

/// How the person is sent to sign in, and how long they have.
pub struct SignIn<'a> {
    pub open: &'a (dyn Fn(&Url) -> Result<(), String> + Sync),
    pub timeout: Duration,
}

/// Google, for one vault's sign-in.
pub struct Session<'a> {
    pub endpoints: &'a Endpoints,
    pub store: &'a dyn SecretStore,
    pub scope: &'a str,
    pub state: &'a GoogleState,
}

fn invalid(message: impl Into<String>) -> GoogleFailure {
    GoogleFailure::new(FailureKind::Invalid, message)
}

/// The backstop for what TypeScript already checked: a client and at least
/// one scope, neither able to break the request it is written into.
fn check_request(request: &ConnectRequest) -> Result<(), GoogleFailure> {
    let usable = |text: &str| !text.is_empty() && !text.chars().any(char::is_whitespace);
    if !usable(&request.client_id) {
        return Err(invalid("a sign-in needs a Google OAuth client ID"));
    }
    if request.scopes.is_empty() || !request.scopes.iter().all(|scope| usable(scope)) {
        return Err(invalid("a sign-in needs the scopes it asks for"));
    }
    Ok(())
}

struct Authorization<'a> {
    client_id: &'a str,
    scopes: &'a [String],
    redirect_uri: &'a str,
    state: &'a str,
    challenge: &'a str,
}

fn authorization_url(authorize: &Url, request: &Authorization) -> Url {
    let mut url = authorize.clone();
    url.query_pairs_mut()
        .append_pair("client_id", request.client_id)
        .append_pair("redirect_uri", request.redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", &request.scopes.join(" "))
        .append_pair("state", request.state)
        .append_pair("code_challenge", request.challenge)
        .append_pair("code_challenge_method", "S256")
        // A refresh token is given only for offline access, and only from a
        // consent screen: without `prompt=consent`, connecting again after a
        // disconnect would bring back an access token alone.
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent")
        // Asking for one more scope (Drive, for an export) keeps those
        // granted before: Google answers with all of them, so the grant kept
        // still reaches the Calendar (#501).
        .append_pair("include_granted_scopes", "true");
    url
}

/// The scopes Google granted, refused unless they include every one asked
/// for: a consent screen lets the person untick a scope and still allow.
fn granted_scopes(granted: Option<&str>, asked: &[String]) -> Result<Vec<String>, GoogleFailure> {
    // RFC 6749 §5.1: a token response may leave `scope` out when it is
    // exactly what was asked for.
    let mut granted: Vec<String> = match granted {
        Some(listed) => listed.split_whitespace().map(str::to_string).collect(),
        None => asked.to_vec(),
    };
    if let Some(missing) = asked.iter().find(|scope| !granted.contains(scope)) {
        return Err(GoogleFailure::new(
            FailureKind::ScopeNotGranted,
            format!("Google did not grant {missing}"),
        ));
    }
    granted.sort();
    granted.dedup();
    Ok(granted)
}

fn not_connected() -> GoogleFailure {
    GoogleFailure::new(
        FailureKind::NotConnected,
        "Google Calendar is not connected for this vault on this Mac",
    )
}

fn ending_of(kept: &Result<GoogleConnection, GoogleFailure>) -> Ending {
    if kept.is_ok() {
        Ending::Connected
    } else {
        Ending::NotConnected
    }
}

impl Session<'_> {
    pub fn status(&self) -> Result<GoogleConnection, GoogleFailure> {
        Ok(GoogleConnection::of(
            grant::load(self.store, self.scope)?.as_ref(),
        ))
    }

    /// Signs in in the browser and keeps what Google grants.
    pub async fn connect(
        &self,
        request: &ConnectRequest,
        sign_in: &SignIn<'_>,
    ) -> Result<GoogleConnection, GoogleFailure> {
        check_request(request)?;
        let signing_in = self.state.begin_sign_in()?;
        let pkce = Pkce::new().map_err(invalid)?;
        let state = new_state().map_err(invalid)?;
        let loopback = Loopback::bind().await?;
        let redirect_uri = loopback.redirect_uri().to_string();
        let url = authorization_url(
            &self.endpoints.authorize,
            &Authorization {
                client_id: &request.client_id,
                scopes: &request.scopes,
                redirect_uri: &redirect_uri,
                state: &state,
                challenge: &pkce.challenge,
            },
        );
        (sign_in.open)(&url).map_err(invalid)?;

        let (heard, answering) = tokio::select! {
            heard = loopback.wait(state) => heard,
            _ = tokio::time::sleep(sign_in.timeout) => return Err(GoogleFailure::new(
                FailureKind::Timeout,
                "the browser did not come back from Google in time",
            )),
            _ = signing_in.cancel.notified() => return Err(GoogleFailure::new(
                FailureKind::Cancelled,
                "the sign-in was cancelled",
            )),
        };
        let kept = match heard {
            Ok(Callback::Code(code)) => {
                self.keep(request, &code, &pkce.verifier, &redirect_uri)
                    .await
            }
            Ok(Callback::Refused(code)) => Err(GoogleFailure::new(
                FailureKind::Refused,
                "Google did not let DFAI in",
            )
            .with_code(&code)),
            Err(failure) => Err(failure),
        };
        // The browser's tab hears how it ended only now, so it never says
        // connected for a sign-in that was then refused or not kept.
        answering.finish(ending_of(&kept)).await;
        kept
    }

    /// Trades the code for tokens and keeps the refresh token.
    async fn keep(
        &self,
        request: &ConnectRequest,
        code: &str,
        verifier: &str,
        redirect_uri: &str,
    ) -> Result<GoogleConnection, GoogleFailure> {
        let client_secret = request
            .client_secret
            .clone()
            .or_else(|| self.kept_client_secret(&request.client_id));
        let tokens = token::exchange(
            &self.endpoints.token,
            &token::Exchange {
                client_id: &request.client_id,
                client_secret: client_secret.as_deref(),
                code,
                verifier,
                redirect_uri,
            },
        )
        .await?;
        let refresh_token = tokens.refresh_token.ok_or_else(|| {
            GoogleFailure::new(
                FailureKind::Malformed,
                "Google gave no refresh token, so DFAI could not stay connected",
            )
        })?;
        let scopes = match granted_scopes(tokens.scope.as_deref(), &request.scopes) {
            Ok(scopes) => scopes,
            Err(failure) => {
                // Not kept. Revoking it would end the app's whole grant at
                // Google — with `include_granted_scopes` that is the Calendar
                // sign-in kept here or in another vault too — so it is only
                // revoked when nothing on this Mac rides on that grant (#502).
                if !self.grant_in_use(&request.client_id)? {
                    token::revoke(&self.endpoints.revoke, &refresh_token).await;
                }
                return Err(failure);
            }
        };
        let grant = Grant {
            client_id: request.client_id.clone(),
            client_secret,
            refresh_token,
            scopes,
        };
        // Every check has passed: from here the sign-in is kept whole, and a
        // refresh still out from an earlier one is discarded when it lands.
        let access = Access {
            value: &tokens.access_token,
            expires_in: tokens.expires_in,
        };
        self.state.held.replace(
            self.scope,
            || grant::save(self.store, self.scope, &grant),
            Some(&access),
        )?;
        log::info!("Google Calendar connected");
        Ok(GoogleConnection::of(Some(&grant)))
    }

    /// Whether a sign-in with this client is kept for this vault or another:
    /// one Google grant, which a revocation would end for all of them.
    fn grant_in_use(&self, client_id: &str) -> Result<bool, GoogleFailure> {
        let kept = grant::load(self.store, self.scope).ok().flatten();
        if kept
            .as_ref()
            .is_some_and(|kept| kept.client_id == client_id)
        {
            return Ok(true);
        }
        let probe = Grant {
            client_id: client_id.to_string(),
            client_secret: None,
            refresh_token: String::new(),
            scopes: Vec::new(),
        };
        grant::shared_with_another_vault(self.store, self.scope, &probe)
    }

    /// The client secret kept with the last sign-in, when it was for the same
    /// client: connecting again need not ask for it twice.
    fn kept_client_secret(&self, client_id: &str) -> Option<String> {
        // A kept sign-in that cannot be read is about to be replaced, so it
        // has no secret worth reusing; the new sign-in goes without.
        let kept = grant::load(self.store, self.scope).ok().flatten()?;
        (kept.client_id == client_id)
            .then_some(kept.client_secret)
            .flatten()
    }

    /// An access token: the one held, while it lasts, or a fresh one. A
    /// refresh whose sign-in was replaced or removed while it was out keeps
    /// nothing, and starts again from what is kept now.
    async fn access_token(&self, renew: bool) -> Result<String, GoogleFailure> {
        let mut renew = renew;
        for _ in 0..REFRESH_ATTEMPTS {
            let (seen, held) = self.state.held.current(self.scope);
            if let (false, Some(token)) = (renew, held) {
                return Ok(token);
            }
            let grant = grant::load(self.store, self.scope)?.ok_or_else(not_connected)?;
            let tokens = token::refresh(&self.endpoints.token, &grant).await?;
            let rotated = tokens
                .refresh_token
                .filter(|token| *token != grant.refresh_token);
            let access = Access {
                value: &tokens.access_token,
                expires_in: tokens.expires_in,
            };
            let kept = self.state.held.settle(
                self.scope,
                seen,
                || match rotated {
                    Some(refresh_token) => grant::save(
                        self.store,
                        self.scope,
                        &Grant {
                            refresh_token,
                            ..grant
                        },
                    ),
                    None => Ok(()),
                },
                &access,
            )?;
            if kept {
                return Ok(tokens.access_token);
            }
            // A token from a sign-in since replaced is not this sign-in's.
            renew = false;
        }
        Err(GoogleFailure::new(
            FailureKind::NotConnected,
            "the Google sign-in changed while a call was waiting for it",
        ))
    }

    /// Sends one call to `service` and hands back its answer.
    pub async fn call(
        &self,
        call: &ApiCall,
        service: Service,
    ) -> Result<GoogleAnswer, GoogleFailure> {
        let checked = api::check(&self.endpoints.api, call, service)?;
        let mut access = self.access_token(false).await?;
        let mut answer = api::send(&checked, &access, self.endpoints.request_timeout).await?;
        if answer.0 == 401 {
            // Revoked or ended early at Google's end: one fresh token, one
            // more try, and whatever that answers is the answer.
            self.state.held.forget_access(self.scope);
            access = self.access_token(true).await?;
            answer = api::send(&checked, &access, self.endpoints.request_timeout).await?;
        }
        let (status, body) = answer;
        let text = String::from_utf8(body).map_err(|_| {
            GoogleFailure::new(
                FailureKind::Malformed,
                "the Google API did not answer with text",
            )
        })?;
        let sent = [("google-access-token".to_string(), access)];
        Ok(GoogleAnswer {
            status,
            body: redact_off_worker(text, sent.into()).await,
        })
    }

    /// Asks Google to revoke the sign-in, unless another vault may share its
    /// grant, and forgets it here either way.
    pub async fn disconnect(&self) -> Result<GoogleDisconnection, GoogleFailure> {
        let kept = grant::load(self.store, self.scope);
        let shared = match &kept {
            Ok(Some(grant)) => grant::shared_with_another_vault(self.store, self.scope, grant)?,
            _ => false,
        };
        let revoked = match kept {
            Ok(Some(_)) if shared => false,
            Ok(Some(grant)) => token::revoke(&self.endpoints.revoke, &grant.refresh_token).await,
            Ok(None) => true,
            // Unreadable, so it cannot be revoked; it is still removed, which
            // is what the person asked for.
            Err(_) => false,
        };
        // Forgotten under the same lock a refresh settles under, so one that
        // was out during the revocation cannot write the grant back.
        self.state
            .held
            .replace(self.scope, || grant::forget(self.store, self.scope), None)?;
        log::info!("Google Calendar disconnected (revoked: {revoked}, shared: {shared})");
        Ok(GoogleDisconnection { revoked, shared })
    }
}

/// The vault a command names, checked to be the open one, as its Keychain
/// scope: a call that lands after a switch is refused, never sent with the
/// other vault's sign-in.
fn scope_of(state: &VaultState, vault: &str) -> Result<String, GoogleFailure> {
    let root = root_for_write(state.root(), Some(vault)).map_err(invalid)?;
    Ok(vault_scope(&root))
}

// The commands are async so that the Keychain, which can block on a prompt,
// is never asked from the main thread.

#[tauri::command]
pub async fn google_status(
    vaults: State<'_, VaultState>,
    secrets: State<'_, SecretState>,
    google: State<'_, GoogleState>,
    vault: String,
) -> Result<GoogleConnection, GoogleFailure> {
    let scope = scope_of(&vaults, &vault)?;
    let endpoints = Endpoints::google();
    Session {
        endpoints: &endpoints,
        store: secrets.store(),
        scope: &scope,
        state: &google,
    }
    .status()
}

/// Signs in in the person's browser. Settles when Google sends the browser
/// back, the sign-in is cancelled, or it times out.
#[tauri::command]
pub async fn google_connect(
    vaults: State<'_, VaultState>,
    secrets: State<'_, SecretState>,
    google: State<'_, GoogleState>,
    vault: String,
    client_id: String,
    client_secret: Option<String>,
    scopes: Vec<String>,
) -> Result<GoogleConnection, GoogleFailure> {
    let scope = scope_of(&vaults, &vault)?;
    let endpoints = Endpoints::google();
    let request = ConnectRequest {
        client_id,
        client_secret,
        scopes,
    };
    let sign_in = SignIn {
        open: &open_web_link,
        timeout: SIGN_IN_TIMEOUT,
    };
    Session {
        endpoints: &endpoints,
        store: secrets.store(),
        scope: &scope,
        state: &google,
    }
    .connect(&request, &sign_in)
    .await
}

#[tauri::command]
pub fn google_connect_cancel(google: State<'_, GoogleState>) {
    google.cancel_sign_in();
}

#[tauri::command]
pub async fn google_disconnect(
    vaults: State<'_, VaultState>,
    secrets: State<'_, SecretState>,
    google: State<'_, GoogleState>,
    vault: String,
) -> Result<GoogleDisconnection, GoogleFailure> {
    let scope = scope_of(&vaults, &vault)?;
    let endpoints = Endpoints::google();
    Session {
        endpoints: &endpoints,
        store: secrets.store(),
        scope: &scope,
        state: &google,
    }
    .disconnect()
    .await
}

/// One Calendar API call, as TypeScript builds it; the host adds the token.
#[tauri::command]
pub async fn google_calendar_request(
    vaults: State<'_, VaultState>,
    secrets: State<'_, SecretState>,
    google: State<'_, GoogleState>,
    vault: String,
    call: ApiCall,
) -> Result<GoogleAnswer, GoogleFailure> {
    let scope = scope_of(&vaults, &vault)?;
    let endpoints = Endpoints::google();
    Session {
        endpoints: &endpoints,
        store: secrets.store(),
        scope: &scope,
        state: &google,
    }
    .call(&call, Service::Calendar)
    .await
}

/// One Drive API call for an export (#501), as TypeScript builds it; the
/// host adds the token. Only files and the upload are reachable, and with
/// `drive.file` Google keeps those to the files this app made.
#[tauri::command]
pub async fn google_drive_request(
    vaults: State<'_, VaultState>,
    secrets: State<'_, SecretState>,
    google: State<'_, GoogleState>,
    vault: String,
    call: ApiCall,
) -> Result<GoogleAnswer, GoogleFailure> {
    let scope = scope_of(&vaults, &vault)?;
    let endpoints = Endpoints::google();
    Session {
        endpoints: &endpoints,
        store: secrets.store(),
        scope: &scope,
        state: &google,
    }
    .call(&call, Service::Drive)
    .await
}

mod api;
mod failure;
#[cfg(test)]
mod fake_google;
mod grant;
mod held;
mod loopback;
mod pkce;
#[cfg(test)]
mod tests;
mod token;
