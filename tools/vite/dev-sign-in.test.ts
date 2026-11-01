import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { answerDevSignIn, devSignIn } from './dev-sign-in.ts';

/** #663: `pnpm dev`'s stand-in for the sign-in function, never in a build. */

let server: Server | undefined;
afterEach(
  () => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())),
);

async function serve() {
  server = createServer(answerDevSignIn);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('the dev sign-in', () => {
  it('is for the dev server alone', () => {
    expect(devSignIn().apply).toBe('serve');
  });

  it('sends a start straight back to the callback with its state', async () => {
    const base = await serve();
    const response = await fetch(`${base}/api/auth/start?state=abc`, { redirect: 'manual' });
    expect(response.headers.get('location')).toBe('/auth/callback?code=dev&state=abc');
  });

  it('grants a token on the code, refreshes with its cookie, and signs out', async () => {
    const base = await serve();
    const post = (path: string, cookie = '') =>
      fetch(`${base}/api/auth/${path}`, { method: 'POST', headers: { cookie } });
    const token = await post('token');
    expect(await token.json()).toEqual({ accessToken: 'dev-only-token', expiresIn: 28800 });
    expect(token.headers.getSetCookie()[0]).toMatch(/^__session=dev; Path=\/api\/auth; HttpOnly/);
    expect((await post('refresh', '__session=dev')).status).toBe(200);
    expect((await post('refresh')).status).toBe(401);
    expect((await post('signout')).headers.getSetCookie()[0]).toMatch(/Max-Age=0/);
    expect((await post('elsewhere')).status).toBe(404);
  });
});
