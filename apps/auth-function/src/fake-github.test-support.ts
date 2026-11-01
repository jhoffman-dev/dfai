import { createHash } from 'node:crypto';
import { GITHUB_TOKEN, githubRevoke } from './github-oauth.ts';

/*
 * GitHub's OAuth token endpoint for a GitHub App, faked as a fetch (#663):
 * the function's tests never reach github.com. It behaves as GitHub
 * documents: errors come back as 200s with `error`, a code is good once and
 * only with its PKCE verifier and redirect, a refresh token is spent by its
 * use and replaced, and a revoked authorization refuses every refresh.
 */

export const CLIENT_ID = 'Iv23liFakeClientId';
export const CLIENT_SECRET = 'fake-client-secret-0000';

export interface IssuedCode {
  readonly challenge: string;
  readonly redirectUri: string;
}

export interface FakeGitHub {
  readonly fetch: typeof globalThis.fetch;
  /** Issues a code as GitHub would after consent, bound to the challenge and redirect. */
  issueCode(args: IssuedCode): string;
  /** The person removed the App, or revoked its authorization: every token stops working. */
  revokeAll(): void;
  /** Every request it was sent, with its form or JSON fields. */
  readonly requests: { url: string; method: string; fields: Record<string, string> }[];
  /** Access tokens revoked one by one through the API. */
  readonly revoked: Set<string>;
  /** Answer each token request with this instead (an outage, a misconfigured App). */
  override: (() => Response | Promise<Response>) | null;
  /** Leave out the expiry fields, as GitHub does when the App's token expiry is off. */
  expiryOff: boolean;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

export function fakeGitHub(): FakeGitHub {
  let counter = 0;
  const codes = new Map<string, IssuedCode>();
  const refreshTokens = new Set<string>();
  const next = (prefix: string) => `${prefix}_${(counter += 1).toString().padStart(4, '0')}`;

  const grant = () => {
    const refreshToken = next('ghr');
    refreshTokens.add(refreshToken);
    const expiry = fake.expiryOff ? {} : { expires_in: 28800, refresh_token_expires_in: 15897600 };
    return json({
      access_token: next('ghu'),
      token_type: 'bearer',
      scope: '',
      ...(fake.expiryOff ? {} : { refresh_token: refreshToken }),
      ...expiry,
    });
  };

  const tokenEndpoint = (fields: Record<string, string>): Response => {
    if (fields.client_id !== CLIENT_ID || fields.client_secret !== CLIENT_SECRET)
      return json({ error: 'incorrect_client_credentials' });
    if (fields.grant_type === 'refresh_token') {
      const token = fields.refresh_token ?? '';
      if (!refreshTokens.delete(token)) return json({ error: 'bad_refresh_token' });
      return grant();
    }
    const issued = codes.get(fields.code ?? '');
    codes.delete(fields.code ?? '');
    if (!issued) return json({ error: 'bad_verification_code' });
    if (fields.redirect_uri !== issued.redirectUri) return json({ error: 'redirect_uri_mismatch' });
    if (s256(fields.code_verifier ?? '') !== issued.challenge)
      return json({ error: 'bad_verification_code' });
    return grant();
  };

  const fake: FakeGitHub = {
    requests: [],
    revoked: new Set(),
    override: null,
    expiryOff: false,
    issueCode: (issued) => {
      const code = next('code').replace('_', '');
      codes.set(code, issued);
      return code;
    },
    revokeAll: () => refreshTokens.clear(),
    fetch: async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const text = typeof init?.body === 'string' ? init.body : String(init?.body ?? '');
      const fields =
        init?.body instanceof URLSearchParams
          ? Object.fromEntries(init.body)
          : (JSON.parse(text || '{}') as Record<string, string>);
      fake.requests.push({ url, method, fields });
      if (url === GITHUB_TOKEN && method === 'POST')
        return fake.override ? fake.override() : tokenEndpoint(fields);
      if (url === githubRevoke(CLIENT_ID) && method === 'DELETE') {
        const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
        if (new Headers(init?.headers).get('authorization') !== `Basic ${basic}`)
          return json({ message: 'Requires authentication' }, 401);
        fake.revoked.add(fields.access_token ?? '');
        return new Response(null, { status: 204 });
      }
      return json({ message: 'Not Found' }, 404);
    },
  };
  return fake;
}
