import { describe, expect, it } from 'vitest';
import type { GranolaPullReport } from '../granola/pull-granola-meetings.ts';
import type { ApiGranola } from './ports.ts';
import { apiFixture, bodyOf, codeOf, NOW, VAULT } from '../testing/api-fixture.ts';
import { API_REFRESH_SPACING_MS } from './refresh-spacing.ts';

/* Attack on PR #613 (P28-13): the guarded Granola pull under concurrency, clock edges and faults. */

/** A made-up key; nothing real. */
const KEY = 'grn_fictional_attack_613_abcdef';

type Api = ReturnType<typeof apiFixture>;

const report = (vault: string): GranolaPullReport => ({
  vault,
  mode: 'sync-now',
  ended: 'pulled',
  written: [],
  held: 0,
  refused: [],
  skipped: [],
  failed: [],
  failure: null,
  problem: null,
  keyRefused: false,
  watermark: null,
});

/** A Granola whose Sync now runs `syncNow`, counting each call. */
function granolaWith(api: Api, syncNow: (vault: string) => Promise<GranolaPullReport>) {
  const calls: string[] = [];
  const granola: ApiGranola = {
    keyStatus: async () => ({ hasKey: true, lastRefusal: null }),
    record: () => ({ watermark: null, lastPullAt: null }),
    ready: () => true,
    syncNow: (vault) => {
      calls.push(vault);
      return syncNow(vault);
    },
  };
  api.deps = { ...api.deps, granola };
  return calls;
}

const pull = (api: Api) => api.send({ method: 'POST', path: '/v1/granola/pull' });
const retryAfterOf = (response: Awaited<ReturnType<typeof pull>>) =>
  (bodyOf(response)['error'] as { retryAfter?: number } | undefined)?.retryAfter;

describe('POST /v1/granola/pull under attack (#613)', () => {
  it('runs exactly one Sync now for a burst of simultaneous POSTs', async () => {
    const api = apiFixture();
    const calls = granolaWith(api, async (vault) => report(vault));

    const answers = await Promise.all(Array.from({ length: 8 }, () => pull(api)));

    expect(calls).toEqual([VAULT.absolutePath]);
    expect(answers.filter((answer) => answer.status === 200)).toHaveLength(1);
    expect(answers.map(codeOf).filter((code) => code === 'conflict')).toHaveLength(7);
  });

  it('answers internal, with neither the key nor a path, when Sync now rejects', async () => {
    const api = apiFixture();
    const secretPath = `${VAULT.absolutePath}/Inbox/Meetings/Mara Quill.md`;
    granolaWith(api, () => Promise.reject(new Error(`EACCES ${secretPath} with ${KEY}`)));

    const response = await pull(api);

    expect(codeOf(response)).toBe('internal');
    expect(JSON.stringify(response)).not.toContain(KEY);
    expect(JSON.stringify(response)).not.toContain(VAULT.absolutePath);
    expect(api.notices).toEqual([]);
  });

  it('restarts the 30 s from when a rejected Sync now ended', async () => {
    const api = apiFixture();
    granolaWith(api, () => {
      api.now += 40_000;
      return Promise.reject(new Error('host fault'));
    });
    await pull(api);
    api.now += 20_000;

    const second = await pull(api);

    expect(codeOf(second)).toBe('conflict');
    expect(retryAfterOf(second)).toBe(10);
  });

  it('allows a pull exactly 30 s after the last ended, and refuses one at 29.999 s', async () => {
    const api = apiFixture();
    const calls = granolaWith(api, async (vault) => report(vault));
    await pull(api);
    api.now = NOW + API_REFRESH_SPACING_MS - 1;

    const early = await pull(api);
    api.now = NOW + API_REFRESH_SPACING_MS;
    const onTime = await pull(api);

    expect(retryAfterOf(early)).toBe(1);
    expect(onTime.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it('never holds a pull off for longer than 30 s, even after the clock is set back', async () => {
    const api = apiFixture();
    granolaWith(api, async (vault) => report(vault));
    await pull(api);
    // The Mac's clock is corrected back an hour (NTP, a manual change, a time zone fault).
    api.now = NOW - 60 * 60_000;

    const after = await pull(api);

    expect(retryAfterOf(after) ?? 0).toBeLessThanOrEqual(API_REFRESH_SPACING_MS / 1000);
  });
});
