import { AuthError, type AuthGateway } from '@dfai/application';
import type { AuthFailureKind, TokenGrant } from '@dfai/domain';

/*
 * The sign-in function, reached on the page's own origin (#663, ADR-0052):
 * Hosting rewrites /api/** to it, so the page's `connect-src 'self'` holds.
 * The refresh token travels only in the function's httpOnly cookie, which
 * this code never sees; what comes back is an access token and its lifetime.
 */

/** Where the function answers, relative to the page. */
export const AUTH_API = '/api/auth';

/** The lock that keeps two tabs from spending one rotated refresh token at once. */
export const REFRESH_LOCK = 'dfai-auth-refresh';

/** Runs `task` while holding the named lock across this origin's tabs. */
export type CrossTabLock = <T>(name: string, task: () => Promise<T>) => Promise<T>;

export interface FunctionAuthGatewayDeps {
  readonly fetch: typeof globalThis.fetch;
  /** Leaves the page for `url` (location.assign). */
  readonly navigate: (url: string) => void;
  readonly lock: CrossTabLock;
  /** Waits `ms` before a refresh refused as revoked is tried once more. setTimeout by default. */
  readonly delay?: (ms: number) => Promise<void>;
  /** Resolves once a request has run `ms`, when it is given up. setTimeout by default. */
  readonly timeout?: (ms: number) => Promise<void>;
}

/**
 * How long a refresh refused as revoked waits before its one retry: long
 * enough for another tab's refresh, which spent the same token a moment
 * before, to land and put its replacement in the cookie.
 */
export const REVOKED_RETRY_MS = 300;

/**
 * How long a call to the function may run before it is given up as
 * unreachable: a fetch on a captive or dropped network may otherwise hang
 * for minutes, holding the refresh lock and a sign-out behind it.
 */
export const REQUEST_TIMEOUT_MS = 15_000;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The function's error codes, as the app names them; anything else is a refusal. */
const FAILURES: Readonly<Record<string, AuthFailureKind>> = {
  'bad-code': 'bad-code',
  'no-session': 'no-session',
  revoked: 'revoked',
  refused: 'refused',
  unavailable: 'network',
};

export function functionAuthGateway(deps: FunctionAuthGatewayDeps): AuthGateway {
  const post = (path: string, body: unknown) =>
    postJson({ fetch: deps.fetch, timeout: deps.timeout ?? wait }, path, body);
  return {
    start: ({ state, codeChallenge }) => {
      const query = new URLSearchParams({ state, code_challenge: codeChallenge });
      deps.navigate(`${AUTH_API}/start?${query}`);
    },
    exchange: async ({ code, verifier }) =>
      readGrant(await post('/token', { code, codeVerifier: verifier })),
    refresh: () =>
      deps.lock(REFRESH_LOCK, () =>
        refreshOnceMore(() => post('/refresh', {}), deps.delay ?? wait),
      ),
    // Under the refresh's lock, so no tab's refresh lands after it and sets the cookie again.
    signOut: ({ accessToken }) =>
      deps.lock(REFRESH_LOCK, async () => {
        await post('/signout', { accessToken });
      }),
  };
}

/**
 * A refresh, tried once more after a short wait when it is refused as
 * revoked: another tab may have spent the cookie's token a moment before
 * (where there is no lock to stop it) and the cookie now holds the token
 * that replaced it. Revoked twice is revoked.
 */
async function refreshOnceMore(
  refresh: () => Promise<unknown>,
  delay: (ms: number) => Promise<void>,
): Promise<TokenGrant> {
  try {
    return readGrant(await refresh());
  } catch (error) {
    if (!(error instanceof AuthError) || error.kind !== 'revoked') throw error;
    await delay(REVOKED_RETRY_MS);
    return readGrant(await refresh());
  }
}

/** A POST to the function, its answer's JSON when it says yes, else an {@link AuthError}. */
async function postJson(
  { fetch, timeout }: Pick<Required<FunctionAuthGatewayDeps>, 'fetch' | 'timeout'>,
  path: string,
  body: unknown,
): Promise<unknown> {
  const controller = new AbortController();
  // Aborting a request that has already answered does nothing.
  void timeout(REQUEST_TIMEOUT_MS).then(() => controller.abort());
  let response: Response;
  try {
    response = await fetch(`${AUTH_API}${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    throw new AuthError('network', `the sign-in service could not be reached: ${String(error)}`);
  }
  if (response.status === 204) return null;
  const answer: unknown = await response.json().catch(() => null);
  if (response.ok) return answer;
  throw new AuthError(failureOf(response.status, answer));
}

function failureOf(status: number, answer: unknown): AuthFailureKind {
  const code = (answer as { error?: unknown } | null)?.error;
  if (typeof code === 'string' && Object.hasOwn(FAILURES, code)) return FAILURES[code] ?? 'refused';
  return status >= 500 ? 'network' : 'refused';
}

/** The function's grant, held to its shape; the domain then holds it to its rules. */
function readGrant(answer: unknown): TokenGrant {
  const { accessToken, expiresIn } = (answer ?? {}) as {
    accessToken?: unknown;
    expiresIn?: unknown;
  };
  if (typeof accessToken !== 'string' || typeof expiresIn !== 'number')
    throw new AuthError('malformed', 'the sign-in service answered without a token');
  return { accessToken, expiresInSeconds: expiresIn };
}
