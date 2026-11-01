import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_BODY_BYTES } from './handler.ts';
import { nodeListener, type FunctionRequest } from './node-listener.ts';
import { ORIGIN, serveFunction, type ServedFunction } from './serve.test-support.ts';

/** #663: the function over real HTTP on a loopback port, as Node runs it. */

let served: ServedFunction | undefined;
afterEach(async () => {
  await served?.close();
  served = undefined;
});

describe('the function over HTTP', () => {
  it('answers a POST with its JSON and its cookie', async () => {
    served = await serveFunction();
    const response = await fetch(`${served.base}/api/auth/signout`, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: null }),
    });
    expect(response.status).toBe(204);
    expect(response.headers.getSetCookie()).toEqual([
      '__session=; Max-Age=0; Path=/api/auth; HttpOnly; Secure; SameSite=Strict',
    ]);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('refuses a body over the limit, read no further than one byte past it', async () => {
    served = await serveFunction();
    const response = await fetch(`${served.base}/api/auth/token`, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: 'x'.repeat(MAX_BODY_BYTES * 50),
    });
    expect(response.status).toBe(413);
  });

  it('redirects a start without following it', async () => {
    served = await serveFunction();
    const response = await fetch(
      `${served.base}/api/auth/start?state=${'s'.repeat(43)}&code_challenge=${'c'.repeat(43)}`,
      { redirect: 'manual' },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toMatch(/^https:\/\/github\.com\/login\/oauth\//);
  });
});

describe('the listener', () => {
  async function serve(listener: ReturnType<typeof nodeListener>, rawBody?: string) {
    const server = createServer((req, res) => {
      if (rawBody !== undefined) (req as FunctionRequest).rawBody = Buffer.from(rawBody);
      void listener(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    served = {
      base: `http://127.0.0.1:${port}`,
      github: undefined as never,
      close: () => new Promise((resolve) => server.close(() => resolve())),
    };
    return served.base;
  }

  it('hands on the body Firebase already read', async () => {
    const seen: string[] = [];
    const base = await serve(
      nodeListener(async (request) => {
        seen.push(await request.text());
        return new Response(null, { status: 204 });
      }),
      '{"from":"rawBody"}',
    );
    await fetch(`${base}/api/auth/refresh`, { method: 'POST', body: 'ignored' });
    expect(seen).toEqual(['{"from":"rawBody"}']);
  });

  it('answers a failure with a bare 500 that says nothing of it', async () => {
    const base = await serve(
      nodeListener(async () => {
        throw new Error('secret ghr_leaked in a message');
      }),
    );
    const response = await fetch(`${base}/api/auth/refresh`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toBe('{"error":"unavailable"}');
    expect(text).not.toMatch(/ghr_/);
  });
});
