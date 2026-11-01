import { createVaultPath as p } from '@dfai/domain';
import { describe, expect, it } from 'vitest';
import {
  GITHUB_REQUEST_TIMEOUT_MS,
  GitHubRateLimitedError,
  GitHubRefusedError,
  MAX_RATE_LIMIT_WAIT_MS,
} from './github-api.ts';
import { FAKE_TOKEN, FakeGitHub, type Received } from './fake-github.test-support.ts';
import { NOW, tokenSource, vaultOver } from './github-vault.test-support.ts';

/**
 * #664: the transport under the GitHub vault, against the API's stand-in —
 * the sign-in's 401, rate limits on a fixed clock, a request that hangs given
 * up on a timer the test fires, and an answer that is not JSON.
 */

const SEED = { 'Welcome.md': '# Welcome\n' };
const isRef = (request: Received) => request.path.includes('/git/ref/heads/');
const limited = (status: number, headers: Record<string, string>) => () =>
  new Response(JSON.stringify({ message: 'API rate limit exceeded' }), { status, headers });

describe('a request to GitHub', () => {
  it('goes to api.github.com with the token, the API version, and no cache', async () => {
    const github = new FakeGitHub({ files: SEED });
    const seen: string[] = [];
    const { fs } = vaultOver(github, {
      fetch: (input, init) => {
        seen.push(String(input));
        return github.fetch(input, init);
      },
    });
    await fs.readTextFile(p('Welcome.md'));
    expect(seen[0]).toBe(
      'https://api.github.com/repos/mara-quill/larkspur-vault/git/ref/heads/main',
    );
    const [first] = github.received;
    expect(first!.headers.get('Authorization')).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(first!.headers.get('X-GitHub-Api-Version')).toBe('2022-11-28');
    expect(github.received.every((request) => request.cache === 'no-store')).toBe(true);
  });

  it('meets a 401 with one refresh, then sends again with the new token', async () => {
    const github = new FakeGitHub({ files: SEED });
    github.tokens.clear();
    const { token, rejected } = tokenSource(github, 'ghu_expired');
    const { fs } = vaultOver(github, { token });
    expect((await fs.readTextFile(p('Welcome.md'))).text).toBe('# Welcome\n');
    expect(rejected).toEqual(['ghu_expired']);
    expect(github.received[1]!.headers.get('Authorization')).toBe('Bearer ghu_refreshed-1');
  });

  it('gives up after one refresh when GitHub still answers 401', async () => {
    const github = new FakeGitHub({ files: SEED });
    const rejected: string[] = [];
    const { fs } = vaultOver(github, {
      token: {
        tokenForRequest: async () => 'ghu_revoked',
        rejected: async (t) => void rejected.push(t),
      },
    });
    const error = await fs.readTextFile(p('Welcome.md')).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitHubRefusedError);
    expect((error as GitHubRefusedError).status).toBe(401);
    expect(rejected).toEqual(['ghu_revoked']);
    expect(github.received).toHaveLength(2);
  });

  it('passes on a sign-in that has ended, without asking GitHub', async () => {
    const github = new FakeGitHub({ files: SEED });
    const ended = new Error('no-session');
    const { fs } = vaultOver(github, {
      token: { tokenForRequest: () => Promise.reject(ended), rejected: async () => undefined },
    });
    await expect(fs.readTextFile(p('Welcome.md'))).rejects.toBe(ended);
    expect(github.received).toEqual([]);
  });
});

describe('GitHub’s rate limit', () => {
  it('waits until the limit resets, by the clock, then asks again', async () => {
    const github = new FakeGitHub({ files: SEED });
    const reset = String(NOW / 1000 + 30);
    github.intercept(
      isRef,
      limited(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }),
    );
    const { fs, waits } = vaultOver(github);
    expect((await fs.readTextFile(p('Welcome.md'))).text).toBe('# Welcome\n');
    expect(waits).toEqual([30_000]);
  });

  it('waits as long as retry-after says, on a 429 or a secondary limit’s 403', async () => {
    const github = new FakeGitHub({ files: SEED });
    github.intercept(isRef, limited(429, { 'retry-after': '5' }));
    github.intercept(isRef, limited(403, { 'retry-after': '2' }));
    const { fs, waits } = vaultOver(github);
    await fs.readTextFile(p('Welcome.md'));
    expect(waits).toEqual([5_000, 2_000]);
  });

  it('waits a minute for a 429 that does not say how long', async () => {
    const github = new FakeGitHub({ files: SEED });
    github.intercept(isRef, limited(429, {}));
    const { fs, waits } = vaultOver(github);
    await fs.readTextFile(p('Welcome.md'));
    expect(waits).toEqual([60_000]);
  });

  it('says when to try again, rather than wait, for a limit that lifts later than a minute', async () => {
    const github = new FakeGitHub({ files: SEED });
    const reset = NOW / 1000 + 3600;
    github.intercept(
      isRef,
      limited(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }),
    );
    const { fs, waits } = vaultOver(github);
    const error = await fs.readTextFile(p('Welcome.md')).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitHubRateLimitedError);
    expect((error as GitHubRateLimitedError).retryAt).toBe(reset * 1000);
    expect(waits).toEqual([]);
    expect(MAX_RATE_LIMIT_WAIT_MS).toBeLessThan(3_600_000);
  });

  it('gives up after waiting out two limits in a row', async () => {
    const github = new FakeGitHub({ files: SEED });
    for (let time = 0; time < 3; time++)
      github.intercept(isRef, limited(429, { 'retry-after': '1' }));
    const { fs, waits } = vaultOver(github);
    await expect(fs.readTextFile(p('Welcome.md'))).rejects.toThrow(GitHubRateLimitedError);
    expect(waits).toEqual([1_000, 1_000]);
  });

  it('takes a 403 that is no rate limit as GitHub’s refusal, without waiting', async () => {
    const github = new FakeGitHub({ files: SEED });
    github.intercept(isRef, limited(403, { 'x-ratelimit-remaining': '4999' }));
    const { fs, waits } = vaultOver(github);
    const error = await fs.readTextFile(p('Welcome.md')).catch((caught: unknown) => caught);
    expect((error as GitHubRefusedError).status).toBe(403);
    expect((error as Error).message).toContain('API rate limit exceeded');
    expect(waits).toEqual([]);
  });
});

describe('a request that hangs, fails or answers oddly', () => {
  it('is given up once its timer fires, through its abort signal', async () => {
    const github = new FakeGitHub({ files: SEED });
    github.hang(isRef);
    const timers: { ms: number; fire: () => void }[] = [];
    const { fs } = vaultOver(github, {
      timeout: (ms) => new Promise<void>((fire) => timers.push({ ms, fire })),
    });
    const reading = fs.readTextFile(p('Welcome.md'));
    await expect.poll(() => timers.length).toBe(1);
    expect(timers[0]!.ms).toBe(GITHUB_REQUEST_TIMEOUT_MS);
    timers[0]!.fire();
    await expect(reading).rejects.toThrow('did not answer in time');
  });

  it('leaves the branch as it was when a commit’s ref update hangs and is given up', async () => {
    const github = new FakeGitHub({ files: SEED });
    const timers: (() => void)[] = [];
    const { fs, vault } = vaultOver(github, {
      timeout: () => new Promise<void>((fire) => timers.push(fire)),
    });
    github.hang((request) => request.method === 'PATCH');
    const creating = fs.createNote({ vault, path: p('Ideas.md'), contents: 'x' });
    await expect
      .poll(() => github.received.some((request) => request.method === 'PATCH'))
      .toBe(true);
    // Firing the timers of requests that already answered does nothing.
    for (const fire of timers) fire();
    await expect(creating).rejects.toThrow('did not answer in time');
    expect(await github.paths()).toEqual(['Welcome.md']);
  });

  it('says GitHub could not be reached when the network fails', async () => {
    const { fs } = vaultOver(new FakeGitHub({ files: SEED }), {
      fetch: () => Promise.reject(new TypeError('Load failed')),
    });
    await expect(fs.readTextFile(p('Welcome.md'))).rejects.toThrow('could not be reached');
  });

  it('refuses a yes that is not JSON, and keeps the status of a no that is not', async () => {
    const github = new FakeGitHub({ files: SEED });
    github.intercept(isRef, () => new Response('<html>unicorn</html>', { status: 200 }));
    const { fs } = vaultOver(github);
    await expect(fs.readTextFile(p('Welcome.md'))).rejects.toThrow('cannot read');
    github.intercept(isRef, () => new Response('<html>unicorn</html>', { status: 502 }));
    const error = await fs.readTextFile(p('Welcome.md')).catch((caught: unknown) => caught);
    expect((error as GitHubRefusedError).status).toBe(502);
  });
});
