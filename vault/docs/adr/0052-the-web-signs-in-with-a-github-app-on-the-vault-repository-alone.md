---
type: adr
id: ADR-0052
title: The web signs in with a GitHub App on the vault repository alone
status: proposed
date: 2026-10-31
---

# The web signs in with a GitHub App on the vault repository alone

## Context

The web build (ADR-0051, epic #678) reads and writes one person's vault, a
private GitHub repository, through the GitHub API: each save a commit sent
with the blob or head it expects, refused when that moved (#664, #665). To do
that the browser needs a GitHub token. This record is how it gets one, what
the token can reach, where it lives and for how long, and what can go wrong
(issue #663).

What is given:

- **A static site** on Firebase Hosting, `dailyflowai-web` in the project
  `dailyflowai-app` (#662), with a strict policy: `script-src 'self';
connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'`,
  plus `frame-ancestors 'none'` in the header. No inline script runs.
- **No server keeps notes.** A server of our own may hold a secret and swap
  a code for a token; it never sees a note.
- **One person, one repository** (ADR-0051 decision 1). Sharing is out of
  scope.

## Decision

1. **A GitHub App, not an OAuth App.** An OAuth App's `repo` scope reaches
   every repository the person can, public and private, with read and write
   to code, issues and settings, and its tokens never expire. A GitHub App
   is installed on chosen repositories, asks for named permissions only, and
   issues user-to-server tokens that act as the person but reach only where
   the person **and** the installation both reach. DFAI's App:
   - **Repository permissions: Contents, read and write. Metadata, read**
     (GitHub requires it). Nothing else: no Administration, Issues, Pull
     requests, Workflows, Actions or Secrets; no organisation or account
     permissions; no webhook; no email.
   - **Installed with "Only select repositories"**: the vault, alone. The
     guide says so. The web build refuses to open a vault unless the
     installation reaches exactly one repository (#664 checks it, through
     `GET /user/installations`, on its first call).
   - **"Expire user authorization tokens" on.** Access tokens live 8 hours;
     each comes with a refresh token that lives 6 months and is spent by its
     use. The function refuses a grant without both, so the App's expiry
     switched off cannot quietly make tokens that never expire, and the
     domain refuses an access token claiming more than a day.
   - **Not public** to begin with: installable by its owner's account. Each
     person who uses DFAI's web build installs it on their own vault.

2. **The code-for-token exchange is a Firebase Function** in its own
   codebase, `dfai-auth` (`apps/auth-function`), reached on the site's own
   origin at `/api/auth/**` through a Hosting rewrite, so `connect-src
'self'` holds and no CORS is needed. It holds the App's **client secret**
   (Secret Manager, as `GITHUB_APP_CLIENT_SECRET`), which never reaches the
   browser. Its four routes:
   - `GET /api/auth/start?state&code_challenge` — 302 to GitHub's authorize
     page with the client id, the callback (`/auth/callback`), the state and
     an S256 challenge. Keeping the client id here keeps the bundle free of
     GitHub settings.
   - `POST /api/auth/token {code, codeVerifier}` — redeems the code; answers
     the access token and its lifetime, and sets the refresh token as a
     cookie.
   - `POST /api/auth/refresh` — a new access token from the cookie; GitHub
     rotates the refresh token and the cookie is reset to the new one.
   - `POST /api/auth/signout {accessToken}` — revokes that access token at
     GitHub (`DELETE /applications/{client_id}/token`) and clears the cookie.

   **It stores nothing**: no database, no log of tokens, no session table.
   What it learns lives in one request and its answer. An error leaves it
   as a bare `{"error":"unavailable"}`, since a message could carry a token.

3. **Where the tokens live in the browser.**
   - **The access token: in memory only**, in the auth service. Never in
     localStorage, sessionStorage or IndexedDB, so a token is not left on
     the iPad's disk and a reload or a closed tab drops it.
   - **The refresh token: in an httpOnly cookie** the function sets:
     `__session=<token>; Max-Age=<its life>; Path=/api/auth; HttpOnly;
Secure; SameSite=Strict`. The name is Firebase Hosting's: it strips
     every other cookie from a rewritten request. `HttpOnly` keeps it from
     the page's scripts; `Path` from every request but the function's.
     Weighed against IndexedDB: a refresh token in IndexedDB is readable by
     any script the page runs, and it is the long-lived credential (six
     months), so an XSS would carry it off and use it from anywhere until it
     is revoked. In the cookie, an XSS can only use it from inside the open
     page, through the function, for as long as the page is open.
   - **The pending sign-in — state and PKCE verifier — in sessionStorage**,
     this tab's alone, taken (read and removed) at the callback. Neither
     redeems anything without the code and the client secret.

4. **Refresh and rotation.** The domain's session model decides, with an
   injected clock — in the browser the page's monotonic clock
   (`performance.timeOrigin + performance.now()`), so a wall clock set back
   cannot keep a token past its expiry: a token is `fresh` until 5 minutes
   before it expires, then `refresh-due` (refreshed before it is sent; sent
   as it is if only the network failed), then `expired` (never sent).
   Refresh is lazy, on the next request, and **single-flight**: callers in
   one tab share the one in flight. Tabs are serialised by **Web Locks**
   (`dfai-auth-refresh`), because a refresh token is spent by its use: two
   tabs sending one at once get one grant and one `bad_refresh_token`.
   - **Where a browser has no Web Locks** (Safari before 15.4), a
     **localStorage lock** stands in (`storage-lock.ts`): a key naming its
     holder and when the hold lapses (30 s, so a tab closed mid-refresh
     cannot keep the rest out); a tab writes a free or lapsed key, waits
     25 ms and reads it back (the later of two near-simultaneous writes
     wins); others wait for the `storage` event or poll every 100 ms. It
     narrows the race, it does not close it. Chosen over BroadcastChannel
     leader election because it needs no tab to stay alive as leader and
     works on the same Safari versions that lack Web Locks.
   - **What gets through is retried.** A refresh refused as revoked waits
     300 ms and is tried once more, by which time the other tab's grant has
     put its replacement in the cookie; revoked twice is revoked. The
     function therefore **does not clear the cookie on a revoked refresh**:
     it cannot know whether the cookie still holds the token it was sent,
     or one another tab has just put there, and clearing it threw the
     winner's away (PR #704's attack). A dead refresh token left in the
     cookie refreshes nothing; a sign-in or sign-out replaces it.
   - A page load restores the session by one refresh. The lifetime is
     counted from before each call, never after.

5. **Revocation and sign-out.**
   - **Sign out** revokes the access token at GitHub and clears the cookie.
     Once it begins, no refresh starts in that tab; it waits out a refresh
     or restore in flight, so the token revoked is the newest (a restore
     that lands then is revoked without the app ever showing), and its call
     to the function runs **under the refresh lock**, so another tab's
     refresh cannot land after it and set the cookie again. GitHub has no
     call to revoke one refresh token alone; cleared from the only place it
     was kept, it is unreachable.
   - **Other tabs** are told on a BroadcastChannel (`dfai-auth`) and end
     their sessions too, showing the sign-in screen. Their access tokens
     are **dropped, not revoked**: each tab revoking its own would clear
     the cookie again, and could clear a new sign-in's; a dropped token is
     never sent again and expires within 8 hours. A browser without
     BroadcastChannel tells nobody, and those tabs end at their next
     refresh, which finds no cookie.
   - **The person removes the App** (or narrows it, or revokes its
     authorization) on GitHub: the next refresh is refused
     (`bad_refresh_token`) twice and the web build signs out with _"GitHub
     no longer lets DFAI reach your vault"_. The cookie is left as it is
     (above).
   - **A 401 from the API** on a request (#664) is first met with one
     refresh, since it may mean only that this clock ran slow; a refused
     refresh ends the session as above, an unreachable one ends it with the
     network message. Only the token the session still holds counts: a slow
     answer to a request sent with a replaced token ends nothing.
   - **"Sign out everywhere"** is GitHub's: remove the App's authorization.

6. **CSRF and the callback.**
   - **`state`**: 32 random bytes from Web Crypto (not the app's `Rng`),
     checked first at the callback, so a crafted callback link is only ever
     a mismatch: it cannot sign the person in to someone else's account
     (login CSRF) nor choose the words on the screen. A callback that fails
     still restores from the cookie, so a crafted link cannot sign out
     someone signed in. A pending sign-in older than 10 minutes is stale.
     The callback is read on `/auth/callback` alone, and its query is taken
     out of the address bar and history before the code is redeemed; on any
     other page the same parameters are taken out and redeem nothing.
   - **PKCE (S256)**, which GitHub supports for GitHub Apps: the verifier,
     32 random bytes, never leaves the tab until the exchange; a code read
     from a log, a Referer or history redeems nothing without it.
   - **The function's POSTs** require `Origin` to be the site's exactly
     (configured as `DFAI_WEB_ORIGIN`) and a JSON body, which a cross-site
     form cannot send without a preflight; with `SameSite=Strict` the cookie
     does not travel on a cross-site request at all. Bodies are capped at
     4 KB, GitHub's answers at 16 KB, and an error name GitHub sends is
     matched only against its own list (no inherited names such as
     `__proto__`). Every answer is `Cache-Control: no-store`.

## Threats

| Threat                                 | What stops it, or what is left                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| XSS in the page                        | The CSP runs no inline or foreign script. **Left:** a script that did run could use the in-memory token and call `/api/auth/refresh` while the page is open, and — since `img-src` is open for pictures in notes — send the access token away; it would work for up to 8 hours or until signed out. It cannot read the refresh token. #664 adds `connect-src https://api.github.com` and nothing more. |
| Token stolen from disk                 | The access token is never written. The cookie is in the browser's cookie store; it works only through the function, from a page on the site's origin.                                                                                                                                                                                                                                                  |
| Login CSRF, code injection             | `state` per tab, checked before anything; PKCE ties the code to the tab.                                                                                                                                                                                                                                                                                                                               |
| CSRF on refresh or sign-out            | `SameSite=Strict`, an exact `Origin`, and JSON only.                                                                                                                                                                                                                                                                                                                                                   |
| Code leaked by Referer or history      | `Referrer-Policy: no-referrer` (#662); the callback query is removed before the exchange; PKCE.                                                                                                                                                                                                                                                                                                        |
| A token reaching more than the vault   | A GitHub App, Contents only, one selected repository; #664 refuses an installation reaching more than one.                                                                                                                                                                                                                                                                                             |
| Client secret leaked                   | In Secret Manager, read only by the function; never in the bundle, the repo, a log or an answer. Rotate it in the App's settings.                                                                                                                                                                                                                                                                      |
| Two tabs spending one refresh token    | Web Locks; where a browser lacks them, a localStorage lock; what still gets through is retried once with the newer cookie, which a refusal no longer clears. **Left:** a retry that runs before the other tab's answer has landed (over 300 ms apart) is refused twice and that tab is told its access was removed; signing in again puts it right.                                                    |
| A sign-out undone by another tab       | No refresh starts once a sign-out has begun; the sign-out's call runs under the refresh lock, after any refresh in flight; the other tabs end their sessions on the broadcast. **Left:** without Web Locks, the localStorage lock's race.                                                                                                                                                              |
| The function or GitHub down            | A due-but-valid token is still used; at start the screen says the service could not be reached. Nothing is lost: no note goes through it.                                                                                                                                                                                                                                                              |
| A hosting deploy reaching another site | Unchanged from #662: `tools/ci/web-hosting.ts` holds firebase.json to the `web` target and now to exactly one functions entry (`dfai-auth`, no hooks) and one function rewrite, first.                                                                                                                                                                                                                 |
| A preview channel (`--pr-n-…` origins) | Sign-in refuses it (its `Origin` is not the site's, and the callback is not registered there). Previews show the sign-in screen only.                                                                                                                                                                                                                                                                  |

## Out of scope

- **Reading and writing the vault** through the GitHub API, the
  one-repository check, and the conflict copies: #664, #665.
- **Deploying the function.** The codebase is built and tested here and
  not deployed; the `web-hosting` workflow deploys hosting only, as before.
  Its Firebase wrapper needs `firebase-functions`, not yet in the lockfile.
- **More than one person per vault**, organisations, and a public App.
- **Encrypting the refresh cookie** with a key of the function's: a stolen
  cookie is only usable through the function anyway, so it would add a
  secret and no protection.

## Consequences

- The web build starts at a sign-in screen; the app opens only while the
  session holds, and the screen comes back, saying why, when it ends.
- `apps/auth-function` deploys alone: it imports no workspace package
  (ESLint and a test hold it), so Firebase can install it from its own
  `package.json`.
- The session's rules are pure (`packages/domain/src/auth`) and held to 90%;
  the service, the browser adapters and the function are each held to 90%
  too, and the function is tested against a fake of GitHub's token
  endpoint, over real HTTP on a loopback port, with the web build's real
  sign-in driving it.
- `pnpm dev` answers `/api/auth/*` itself with a token that reaches nothing,
  so the web build can be worked on without GitHub.
- **Before the first hosting deploy that carries the `/api/**` rewrite**,
  deploy the function: Hosting may refuse a rewrite to a function the
  project does not have, and until it exists `/api/**` cannot answer.
