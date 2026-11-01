// @vitest-environment jsdom
// Adversarial probes, round 2, for PR #156 (P28-12) fix commits. Diagnose only: a red test is a defect.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  fakeGranola,
  fakeIndexPort,
  fakeVaultFs,
  recordingActivity,
  type GranolaKeyStatus,
  type GranolaPullRecord,
  type GranolaPullRecords,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { settles } from '@dfai/ui/testing/settles';
import {
  GRANOLA_PULL_INTERVAL_MS,
  useGranolaPull,
  type GranolaPullOptions,
} from './use-granola-pull.ts';
import { queryWrapper } from '../reads/query-wrapper.tsx';

/** Where the fake clock stands until a test moves it: the hook's clock reads it through `Date.now`. */
const FIXED_NOW = new Date('2026-03-02T09:00:00.000Z');

const VAULT = '/Users/mara/Vault';
const OTHER = '/Users/mara/Other';
const KEY_HELD: GranolaKeyStatus = { hasKey: true, lastRefusal: null };
const NO_KEY: GranolaKeyStatus = { hasKey: false, lastRefusal: null };

const vaultWith = (frontmatter = 'granola_periodic: true') =>
  fakeVaultFs({
    readNotes: async (paths) =>
      paths.includes('.atlas/settings.md')
        ? [{ path: '.atlas/settings.md', text: `---\n${frontmatter}\n---\n`, modified: 1, size: 1 }]
        : [],
  });

function memoryRecords(): GranolaPullRecords {
  const kept = new Map<string, GranolaPullRecord>();
  return {
    read: (vault) => kept.get(vault) ?? { watermark: null, lastPullAt: null },
    write: (vault, record) => void kept.set(vault, record),
  };
}

function held<T>() {
  let settle: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => (settle = resolve));
  return { promise, settle };
}

function setUp(overrides: Partial<GranolaPullOptions> = {}) {
  const granola = fakeGranola();
  const options: GranolaPullOptions = {
    granola: granola.port,
    records: memoryRecords(),
    fs: vaultWith(),
    markdown: remarkMarkdown,
    index: fakeIndexPort(),
    vaultKey: VAULT,
    syncedThisSession: new Set([VAULT, OTHER]),
    syncPulls: new Map(),
    catchUpIndex: async () => true,
    clock: { now: () => Date.now() },
    activity: recordingActivity(),
    onWrote: vi.fn(),
    ...overrides,
  };
  const hook = renderHook((props: GranolaPullOptions) => useGranolaPull(props), {
    wrapper: queryWrapper().wrapper,
    initialProps: options,
  });
  return { hook, granola, options, lists: () => granola.count('list') };
}

const fifteenMinutes = () => act(async () => vi.advanceTimersByTime(GRANOLA_PULL_INTERVAL_MS));

beforeEach(() => vi.useFakeTimers({ now: FIXED_NOW }));
afterEach(() => vi.useRealTimers());

describe('useGranolaPull, attacked round 2 (PR #156 fixes)', () => {
  it('ATTACK: one catch-up that never answers leaves the card "Pulling…" (Sync now disabled) after a later catch-up succeeds', async () => {
    const hung = new Promise<boolean>(() => {});
    const { hook, options, lists } = setUp();
    await settles(() => expect(hook.result.current.report?.ended).toBe('pulled'));
    await settles(() => expect(hook.result.current.pulling).toBe(false));

    // A sync brings files in; the index's catch-up for it never answers.
    hook.rerender({ ...options, syncPulls: new Map([[VAULT, 1]]), catchUpIndex: () => hung });
    await act(async () => undefined);
    // The 15-minute pull starts and waits on that catch-up.
    await fifteenMinutes();
    expect(hook.result.current.pulling).toBe(true);

    // The next sync brings files in and its catch-up succeeds: the vault is ready again.
    hook.rerender({ ...options, syncPulls: new Map([[VAULT, 2]]), catchUpIndex: async () => true });
    await settles(() => expect(hook.result.current.ready).toBe(true));
    // Sync now pulls fine now...
    act(() => hook.result.current.syncNow());
    await settles(() => expect(lists()).toBe(2));
    await settles(() => expect(hook.result.current.report?.mode).toBe('sync-now'));
    // ...but the waiting 15-minute pull is never let go: the card says "Pulling" and Sync now stays disabled.
    await act(async () => undefined);
    expect(hook.result.current.pulling).toBe(false);
  });

  it('ATTACK: a key status read on open that lands after knowKey overwrites the newer answer (readKey out of order)', async () => {
    const slow = held<GranolaKeyStatus>();
    let first = true;
    const granola = fakeGranola();
    const port = {
      ...granola.port,
      status: () => {
        if (first) {
          first = false;
          return slow.promise;
        }
        return Promise.resolve(KEY_HELD);
      },
    };
    const { hook } = setUp({ granola: port });
    // The person saves a key while the open's read is still out; the host answers with its status.
    act(() => hook.result.current.knowKey(KEY_HELD));
    expect(hook.result.current.key).toEqual(KEY_HELD);
    // The read asked as the vault opened, before the key was saved, answers last.
    await act(async () => slow.settle(NO_KEY));
    expect(hook.result.current.key).toEqual(KEY_HELD);
  });
});
