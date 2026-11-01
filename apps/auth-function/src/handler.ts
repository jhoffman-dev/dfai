import { CALLBACK_PATH, type AuthFunctionConfig } from './config.ts';
import { GITHUB_AUTHORIZE, type GitHubGrant, type GitHubOAuth } from './github-oauth.ts';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from './session-cookie.ts';

/*
 * The sign-in function's routes (#663, ADR-0052), as a fetch handler:
 *
 *   GET  /api/auth/start    → 302 to GitHub's consent screen, with the App's client id
 *   POST /api/auth/token    → redeems a code + PKCE verifier; sets the refresh cookie
 *   POST /api/auth/refresh  → a new access token from the cookie, which it rotates
 *   POST /api/auth/signout  → revokes the access token handed to it; clears the cookie
 *
 * It stores nothing: what it learns lives in the request and the answer. It
 * never logs a token, and never sees a note.
 */

export interface AuthHandlerDeps {
  readonly config: AuthFunctionConfig;
  readonly github: GitHubOAuth;
}

/** The error codes the browser's adapter reads (packages/adapters/src/auth). */
export type AuthErrorCode = 'bad-code' | 'no-session' | 'revoked' | 'refused' | 'unavailable';

/** The most a POST's body may hold: a code and a verifier, or a token, fit many times over. */
export const MAX_BODY_BYTES = 4096;

const SECRET = /^[A-Za-z0-9\-._~]{43,128}$/;
const CODE = /^[A-Za-z0-9_-]{1,256}$/;
const TOKEN = /^[A-Za-z0-9_.-]{1,512}$/;

const NO_STORE = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

function answer(status: number, body: unknown, cookie?: string): Response {
  const headers = new Headers({ ...NO_STORE, 'Content-Type': 'application/json' });
  if (cookie) headers.append('Set-Cookie', cookie);
  return new Response(body === null ? null : JSON.stringify(body), { status, headers });
}

const refusal = (status: number, error: AuthErrorCode, cookie?: string) =>
  answer(status, { error }, cookie);

type Route = (request: Request, deps: AuthHandlerDeps) => Promise<Response>;

const ROUTES: Readonly<Record<string, { method: 'GET' | 'POST'; route: Route }>> = {
  '/api/auth/start': { method: 'GET', route: async (request, deps) => start(request, deps) },
  '/api/auth/token': { method: 'POST', route: (request, deps) => posted(request, deps, token) },
  '/api/auth/refresh': {
    method: 'POST',
    route: (request, deps) => posted(request, deps, refresh),
  },
  '/api/auth/signout': {
    method: 'POST',
    route: (request, deps) => posted(request, deps, signOut),
  },
};

export function authHandler(deps: AuthHandlerDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    const path = new URL(request.url).pathname;
    const entry = Object.hasOwn(ROUTES, path) ? ROUTES[path] : undefined;
    if (!entry) return refusal(404, 'refused');
    if (request.method !== entry.method) return refusal(405, 'refused');
    return entry.route(request, deps);
  };
}

/** Off to GitHub: the browser's state and challenge, the App's id and callback, S256. */
function start(request: Request, { config }: AuthHandlerDeps): Response {
  const query = new URL(request.url).searchParams;
  const state = query.get('state') ?? '';
  const challenge = query.get('code_challenge') ?? '';
  if (!SECRET.test(state) || !SECRET.test(challenge)) return refusal(400, 'refused');
  const authorize = new URL(GITHUB_AUTHORIZE);
  authorize.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: `${config.origin}${CALLBACK_PATH}`,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  return new Response(null, { status: 302, headers: { ...NO_STORE, Location: authorize.href } });
}

type PostRoute = (
  body: Record<string, unknown>,
  request: Request,
  deps: AuthHandlerDeps,
) => Promise<Response>;

/**
 * A POST from the web build's own page, or a refusal: its Origin must be the
 * site's (CSRF, beside SameSite=Strict), its body a small JSON object.
 */
async function posted(
  request: Request,
  deps: AuthHandlerDeps,
  route: PostRoute,
): Promise<Response> {
  if (request.headers.get('origin') !== deps.config.origin) return refusal(403, 'refused');
  if (!(request.headers.get('content-type') ?? '').startsWith('application/json'))
    return refusal(415, 'refused');
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_BODY_BYTES) return refusal(413, 'refused');
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return refusal(400, 'refused');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    return refusal(400, 'refused');
  return route(body as Record<string, unknown>, request, deps);
}

/** The browser's grant: the access token alone. The refresh token goes in the cookie. */
const granted = (grant: GitHubGrant) =>
  answer(
    200,
    { accessToken: grant.accessToken, expiresIn: grant.expiresIn },
    setRefreshCookie(grant.refreshToken, grant.refreshExpiresIn),
  );

const token: PostRoute = async (body, _request, { config, github }) => {
  const { code, codeVerifier } = body;
  if (typeof code !== 'string' || !CODE.test(code)) return refusal(400, 'refused');
  if (typeof codeVerifier !== 'string' || !SECRET.test(codeVerifier))
    return refusal(400, 'refused');
  const result = await github.exchange({
    code,
    codeVerifier,
    redirectUri: `${config.origin}${CALLBACK_PATH}`,
  });
  if (result.ok) return granted(result.grant);
  if (result.failure === 'bad-code') return refusal(401, 'bad-code');
  return refusal(result.failure === 'misconfigured' ? 500 : 502, 'unavailable');
};

const refresh: PostRoute = async (_body, request, { github }) => {
  const refreshToken = readRefreshCookie(request.headers.get('cookie'));
  if (!refreshToken) return refusal(401, 'no-session', clearRefreshCookie());
  const result = await github.refresh(refreshToken);
  if (result.ok) return granted(result.grant);
  if (result.failure === 'revoked') return refusal(401, 'revoked', clearRefreshCookie());
  // The cookie is kept: GitHub did not say the token is bad, and the browser may try again.
  return refusal(result.failure === 'misconfigured' ? 500 : 502, 'unavailable');
};

const signOut: PostRoute = async (body, _request, { github }) => {
  const { accessToken } = body;
  if (accessToken !== null && (typeof accessToken !== 'string' || !TOKEN.test(accessToken)))
    return refusal(400, 'refused');
  // Best effort: the cookie is cleared whatever GitHub says, and the token expires within hours.
  if (accessToken !== null) await github.revoke(accessToken);
  return answer(204, null, clearRefreshCookie());
};
