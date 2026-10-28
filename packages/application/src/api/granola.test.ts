import { describe, expect, it } from 'vitest';
import type { GranolaPullReport } from '../granola/pull-granola-meetings.ts';
import type { GranolaKeyStatus, GranolaPullRecord } from '../granola/ports.ts';
import type { ApiResponse } from './contract.ts';
import type { ApiGranola } from './ports.ts';
import { apiFixture, bodyOf, codeOf, NOW, OTHER_VAULT, VAULT } from '../testing/api-fixture.ts';

/* P28-13: Granola through the local API — its status, and one guarded pull. */

/** A key as Granola issues them; made up. Nothing in DFAI's TypeScript ever holds one. */
const KEY = 'grn_fictional0123456789abcdef';

type Api = ReturnType<typeof apiFixture>;

const pulledReport = (vault: string): GranolaPullReport => ({
  vault,
  mode: 'sync-now',
  ended: 'pulled',
  written: ['Meetings/2026/10/2026-10-06 Larkspur Payroll renewal.md' as never],
  held: 2,
  refused: [],
  skipped: [],
  failed: [{ id: 'not_e2e1', title: 'Tobias one on one', url: null, problem: 'timed out' }],
  failure: null,
  problem: null,
  keyRefused: false,
  watermark: '2026-10-13T16:00:00Z',
});

/**
 * The app's Granola, faked. Every answer the host or the puller gives also
 * carries the key in a field of its own, as a careless host could: the
 * routes must build their answers field by field, never pass one on.
 */
function fakeGranola(api: Api) {
  const state = {
    key: { hasKey: true, lastRefusal: null } as GranolaKeyStatus,
    record: { watermark: '2026-10-13T16:00:00Z', lastPullAt: NOW - 60_000 } as GranolaPullRecord,
    ready: true,
    pulls: [] as string[],
    /** Runs while a pull is under way; a test switches the vault in it. */
    during: () => {},
    report: (vault: string): GranolaPullReport => pulledReport(vault),
  };
  const granola: ApiGranola = {
    keyStatus: async () => {
      state.during();
      return { ...state.key, key: KEY } as GranolaKeyStatus;
    },
    record: () => ({ ...state.record, key: KEY }) as GranolaPullRecord,
    ready: () => state.ready,
    syncNow: async (vault) => {
      state.pulls.push(vault);
      state.during();
      return { ...state.report(vault), key: KEY } as GranolaPullReport;
    },
  };
  api.deps = { ...api.deps, granola };
  return state;
}

const status = (api: Api) => api.send({ method: 'GET', path: '/v1/granola' });
const pull = (api: Api) => api.send({ method: 'POST', path: '/v1/granola/pull' });

describe('GET /v1/granola', () => {
  it('says whether a key is held, and the last pull and watermark, never the key', async () => {
    const api = apiFixture();
    fakeGranola(api);

    const response = await status(api);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      hasKey: true,
      keyRefused: false,
      lastPullAt: NOW - 60_000,
      watermark: '2026-10-13T16:00:00Z',
    });
  });

  it('says so when this Mac holds no key and has never pulled', async () => {
    const api = apiFixture();
    const granola = fakeGranola(api);
    granola.key = { hasKey: false, lastRefusal: null };
    granola.record = { watermark: null, lastPullAt: null };

    expect((await status(api)).body).toEqual({
      hasKey: false,
      keyRefused: false,
      lastPullAt: null,
      watermark: null,
    });
  });

  it('says when Granola refused the key this Mac holds', async () => {
    const api = apiFixture();
    const granola = fakeGranola(api);
    granola.key = { hasKey: true, lastRefusal: 401 };

    expect((await status(api)).body).toMatchObject({ hasKey: true, keyRefused: true });
  });

  it('answers no_vault when the vault is switched while the host is asked', async () => {
    const api = apiFixture();
    const granola = fakeGranola(api);
    granola.during = () => (api.open = OTHER_VAULT);

    expect(codeOf(await status(api))).toBe('no_vault');
  });

  it('answers no_vault with no vault open', async () => {
    const api = apiFixture();
    fakeGranola(api);
    api.open = null;

    expect(codeOf(await status(api))).toBe('no_vault');
  });

  it('is conflict when the app has given the API no Granola', async () => {
    const api = apiFixture();

    expect(codeOf(await status(api))).toBe('conflict');
    expect(codeOf(await pull(api))).toBe('conflict');
  });
});

describe('POST /v1/granola/pull', () => {
  it("runs the app's own Sync now for the vault and answers with its report", async () => {
    const api = apiFixture();
    const granola = fakeGranola(api);

    const response = await pull(api);

    expect(response.status).toBe(200);
    expect(granola.pulls).toEqual([VAULT.absolutePath]);
    expect(bodyOf(response)['report']).toEqual({
      mode: 'sync-now',
      ended: 'pulled',
      written: ['Meetings/2026/10/2026-10-06 Larkspur Payroll renewal.md'],
      held: 2,
      refused: [],
      skipped: [],
      failed: [{ id: 'not_e2e1', title: 'Tobias one on one', url: null, problem: 'timed out' }],
      problem: null,
      keyRefused: false,
      watermark: '2026-10-13T16:00:00Z',
    });
  });

  it('is conflict a second time within 30 s, with retryAfter, and pulls once', async () => {
    const api = apiFixture();
    const granola = fakeGranola(api);
    await pull(api);
    api.now = NOW + 20_000;

    const second = await pull(api);

    expect(bodyOf(second)['error']).toMatchObject({ code: 'conflict', retryAfter: 10 });
    expect(granola.pulls).toHaveLength(1);
  });

  it('pulls again once 30 s have passed', async () => {
    const api = apiFixture();
    const granola = fakeGranola(api);
    await pull(api);
    api.now = NOW + 30_000;

    expect((await pull(api)).status).toBe(200);
    expect(granola.pulls).toHaveLength(2);
  });

  it('spaces each vault on its own', async () => {
    const api = apiFixture();
    const granola = fakeGranola(api);
    await pull(api);
    api.open = OTHER_VAULT;

    expect((await pull(api)).status).toBe(200);
    expect(granola.pulls).toEqual([VAULT.absolutePath, OTHER_VAULT.absolutePath]);
  });

  it('is conflict, and asks Granola nothing, when this Mac holds no key', async () => {
    const api = apiFixture();
    const granola = fakeGranola(api);
    granola.key = { hasKey: false, lastRefusal: null };

    const response = await pull(api);

    expect(codeOf(response)).toBe('conflict');
    expect(bodyOf(response)['error']).toMatchObject({
      message: expect.stringMatching(/no Granola key/),
    });
    expect(granola.pulls).toEqual([]);
  });

  it('is conflict, and asks Granola nothing, while the app would not pull the vault either', async () => {
    const api = apiFixture();
    const granola = fakeGranola(api);
    granola.ready = false;

    const response = await pull(api);

    expect(codeOf(response)).toBe('conflict');
    expect(bodyOf(response)['error']).toMatchObject({
      message: expect.stringMatching(/once sync has pulled it/),
    });
    expect(bodyOf(response)['error']).not.toHaveProperty('retryAfter');
    expect(granola.pulls).toEqual([]);
  });

  it('is conflict, and asks Granola nothing, when Granola refused the key', async () => {
    const api = apiFixture();
    const granola = fakeGranola(api);
    granola.key = { hasKey: true, lastRefusal: 401 };

    const response = await pull(api);

    expect(codeOf(response)).toBe('conflict');
    expect(bodyOf(response)['error']).toMatchObject({
      message: expect.stringMatching(/Granola refused this Mac's key/),
    });
    expect(bodyOf(response)['error']).not.toHaveProperty('retryAfter');
    expect(granola.pulls).toEqual([]);
  });

  it('counts the 30 s from when a pull ends, so full listings never run back to back', async () => {
    const api = apiFixture();
    const granola = fakeGranola(api);
    // Asking the key and the pull each take 40 s.
    granola.during = () => (api.now += 40_000);
    await pull(api);
    granola.during = () => {};
    api.now += 20_000;

    const second = await pull(api);

    expect(bodyOf(second)['error']).toMatchObject({ code: 'conflict', retryAfter: 10 });
    expect(granola.pulls).toHaveLength(1);
  });

  it('does not spend the 30 s on a pull refused for want of a key', async () => {
    const api = apiFixture();
    const granola = fakeGranola(api);
    granola.key = { hasKey: false, lastRefusal: null };
    await pull(api);
    granola.key = { hasKey: true, lastRefusal: null };

    expect((await pull(api)).status).toBe(200);
  });

  it('does not spend the 30 s on a pull it refused', async () => {
    const api = apiFixture();
    const granola = fakeGranola(api);
    granola.ready = false;
    await pull(api);
    granola.ready = true;

    expect((await pull(api)).status).toBe(200);
  });

  it('answers no_vault when the vault is switched during the pull', async () => {
    const api = apiFixture();
    const granola = fakeGranola(api);
    granola.report = (vault) => ({ ...pulledReport(vault), ended: 'vault-changed', written: [] });
    let calls = 0;
    // The key is asked first, with the vault still open; the switch lands during the pull.
    granola.during = () => {
      calls += 1;
      if (calls === 2) api.open = OTHER_VAULT;
    };

    expect(codeOf(await pull(api))).toBe('no_vault');
    expect(granola.pulls).toEqual([VAULT.absolutePath]);
  });

  it('answers no_vault, and pulls nothing, when the vault is switched while the key is asked', async () => {
    const api = apiFixture();
    const granola = fakeGranola(api);
    granola.during = () => (api.open = OTHER_VAULT);

    expect(codeOf(await pull(api))).toBe('no_vault');
    expect(granola.pulls).toEqual([]);
  });
});

describe('the key', () => {
  it('appears in no answer of either route, errors included', async () => {
    const api = apiFixture();
    const granola = fakeGranola(api);
    const answers: ApiResponse[] = [];
    const ask = async (send: () => Promise<ApiResponse>) => answers.push(await send());

    await ask(() => status(api));
    await ask(() => pull(api));
    await ask(() => pull(api)); // conflict, retryAfter
    api.now = NOW + 30_000;
    granola.report = (vault) => ({
      ...pulledReport(vault),
      ended: 'failed',
      keyRefused: true,
      problem: 'Granola refused the key',
    });
    await ask(() => pull(api)); // a refused key
    granola.key = { hasKey: false, lastRefusal: 401 };
    await ask(() => status(api));
    await ask(() => pull(api)); // no key
    granola.key = { hasKey: true, lastRefusal: 401 };
    await ask(() => pull(api)); // a key Granola refused
    granola.key = { hasKey: true, lastRefusal: null };
    granola.ready = false;
    await ask(() => pull(api)); // not ready
    granola.during = () => (api.open = OTHER_VAULT);
    await ask(() => status(api)); // no_vault
    api.open = VAULT;
    granola.during = () => {
      throw new Error(`host fault with ${KEY}`);
    };
    await ask(() => status(api)); // internal

    expect(answers.map(codeOf)).toEqual([
      null,
      null,
      'conflict',
      null,
      null,
      'conflict',
      'conflict',
      'conflict',
      'no_vault',
      'internal',
    ]);
    for (const answer of answers) expect(JSON.stringify(answer)).not.toContain(KEY);
  });
});
