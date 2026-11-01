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
}

/** The function's error codes, as the app names them; anything else is a refusal. */
const FAILURES: Readonly<Record<string, AuthFailureKind>> = {
  'bad-code': 'bad-code',
  'no-session': 'no-session',
  revoked: 'revoked',
  refused: 'refused',
  unavailable: 'network',
};

export function functionAuthGateway(deps: FunctionAuthGatewayDeps): AuthGateway {
  const post = (path: string, body: unknown) => postJson(deps.fetch, path, body);
  return {
    start: ({ state, codeChallenge }) => {
      const query = new URLSearchParams({ state, code_challenge: codeChallenge });
      deps.navigate(`${AUTH_API}/start?${query}`);
    },
    exchange: async ({ code, verifier }) =>
      readGrant(await post('/token', { code, codeVerifier: verifier })),
    refresh: () => deps.lock(REFRESH_LOCK, async () => readGrant(await post('/refresh', {}))),
    signOut: async ({ accessToken }) => {
      await post('/signout', { accessToken });
    },
  };
}

/** A POST to the function, its answer's JSON when it says yes, else an {@link AuthError}. */
async function postJson(
  fetch: typeof globalThis.fetch,
  path: string,
  body: unknown,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${AUTH_API}${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
