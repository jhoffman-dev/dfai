/*
 * GitHub's OAuth endpoints for a GitHub App's user-to-server tokens (#663,
 * ADR-0052). The only hosts the function talks to. The client secret goes
 * in each request's body or Basic credentials and nowhere else.
 */

export const GITHUB_AUTHORIZE = 'https://github.com/login/oauth/authorize';
export const GITHUB_TOKEN = 'https://github.com/login/oauth/access_token';
export const githubRevoke = (clientId: string) =>
  `https://api.github.com/applications/${encodeURIComponent(clientId)}/token`;

/** An access token and the refresh token that replaces it, each with its lifetime in seconds. */
export interface GitHubGrant {
  readonly accessToken: string;
  readonly expiresIn: number;
  readonly refreshToken: string;
  readonly refreshExpiresIn: number;
}

export type GitHubFailure =
  /** The code was used, expired, or is not this App's; or the PKCE verifier does not match. */
  | 'bad-code'
  /** The refresh token is spent, expired, or its authorization was revoked. */
  | 'revoked'
  /** GitHub refused the App itself: wrong secret, callback, or token expiry switched off. */
  | 'misconfigured'
  /** GitHub could not be reached, or answered nonsense. */
  | 'upstream';

export type GitHubResult =
  | { readonly ok: true; readonly grant: GitHubGrant }
  | { readonly ok: false; readonly failure: GitHubFailure };

export interface GitHubOAuth {
  exchange(args: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<GitHubResult>;
  refresh(refreshToken: string): Promise<GitHubResult>;
  /** Revokes one access token; whether GitHub confirmed it. */
  revoke(accessToken: string): Promise<boolean>;
}

/** GitHub's token errors, which come back as 200s with an `error`. */
const GITHUB_ERRORS: Readonly<Record<string, GitHubFailure>> = {
  bad_verification_code: 'bad-code',
  bad_refresh_token: 'revoked',
  incorrect_client_credentials: 'misconfigured',
  redirect_uri_mismatch: 'misconfigured',
  unsupported_grant_type: 'misconfigured',
};

const TOKEN = /^[A-Za-z0-9_.-]{1,512}$/;
const misconfigured: GitHubResult = { ok: false, failure: 'misconfigured' };
const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

/** GitHub's answer to a token request, held to what an expiring token's grant must have. */
export function readTokenAnswer(answer: unknown): GitHubResult {
  const body = (answer ?? {}) as Record<string, unknown>;
  if (typeof body.error === 'string')
    return { ok: false, failure: GITHUB_ERRORS[body.error] ?? 'upstream' };
  const { access_token, expires_in, refresh_token, refresh_token_expires_in } = body;
  if (typeof access_token !== 'string' || !TOKEN.test(access_token))
    return { ok: false, failure: 'upstream' };
  // Without these the App's token expiry is off: a token that never expires is refused (ADR-0052).
  if (typeof refresh_token !== 'string' || !TOKEN.test(refresh_token)) return misconfigured;
  if (!positive(expires_in) || !positive(refresh_token_expires_in)) return misconfigured;
  return {
    ok: true,
    grant: {
      accessToken: access_token,
      expiresIn: expires_in,
      refreshToken: refresh_token,
      refreshExpiresIn: refresh_token_expires_in,
    },
  };
}

export interface GitHubOAuthDeps {
  readonly fetch: typeof globalThis.fetch;
  readonly clientId: string;
  readonly clientSecret: string;
  /** How long a call to GitHub may take before it counts as unreachable. */
  readonly timeoutMs?: number;
}

export function githubOAuth(deps: GitHubOAuthDeps): GitHubOAuth {
  const { clientId, clientSecret } = deps;
  const signal = () => AbortSignal.timeout(deps.timeoutMs ?? 10_000);
  const tokenRequest = async (fields: Record<string, string>): Promise<GitHubResult> => {
    try {
      const response = await deps.fetch(GITHUB_TOKEN, {
        method: 'POST',
        // A form, as RFC 6749 has it; Accept asks GitHub to answer in JSON.
        headers: { Accept: 'application/json' },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...fields }),
        signal: signal(),
      });
      if (!response.ok) return { ok: false, failure: 'upstream' };
      return readTokenAnswer(await response.json());
    } catch {
      // Unreachable, timed out, or not JSON: all the same to the browser, which may try again.
      return { ok: false, failure: 'upstream' };
    }
  };
  return {
    exchange: ({ code, codeVerifier, redirectUri }) =>
      tokenRequest({ code, code_verifier: codeVerifier, redirect_uri: redirectUri }),
    refresh: (refreshToken) =>
      tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    revoke: async (accessToken) => {
      const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      try {
        const response = await deps.fetch(githubRevoke(clientId), {
          method: 'DELETE',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Basic ${basic}`,
            'X-GitHub-Api-Version': '2022-11-28',
          },
          body: JSON.stringify({ access_token: accessToken }),
          signal: signal(),
        });
        return response.status === 204;
      } catch {
        // Sign-out goes on without it: the cookie is cleared and the token expires within hours.
        return false;
      }
    },
  };
}
