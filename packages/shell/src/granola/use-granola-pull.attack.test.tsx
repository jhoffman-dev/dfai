// @vitest-environment jsdom
// Adversarial probes for PR #156 (P28-12). Diagnose only: a red test here is a defect.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { type GranolaNote } from '@dfai/domain';
import {
  fakeGranola,
  fakeIndexPort,
  fakeVaultFs,
  GranolaError,
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
import { readAgain, vaultReadKey } from '../reads/query-client.ts';
import { queryWrapper } from '../reads/query-wrapper.tsx';

/** Where the fake clock stands until a test moves it: the hook's clock reads it through `Date.now`. */
const FIXED_NOW = new Date('2026-03-02T09:00:00.000Z');

const VAULT = '/Users/mara/Vault';
const OTHER = '/Users/mara/Other';

const KEY_HELD: GranolaKeyStatus = { hasKey: true, lastRefusal: null };
const REFUSED: GranolaKeyStatus = { hasKey: true, lastRefusal: 401 };

/** A vault whose settings note says `frontmatter`. */
const vaultWith = (frontmatter = 'theme: dark') =>
  fakeVaultFs({
    readNotes: async (paths) =>
      paths.includes('.atlas/settings.md')
        ? [{ path: '.atlas/settings.md', text: `---\n${frontmatter}\n---\n`, modified: 1, size: 1 }]
        : [],
  });

function memoryRecords(): GranolaPullRecords & { kept: Map<string, GranolaPullRecord> } {
  const kept = new Map<string, GranolaPullRecord>();
  return {
    kept,
    read: (vault) => kept.get(vault) ?? { watermark: null, lastPullAt: null },
    write: (vault, record) => void kept.set(vault, record),
  };
}

/** A promise the test settles by hand. */
function held<T>() {
  let settle: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => (settle = resolve));
  return { promise, settle };
}

function setUp({
  key = KEY_HELD,
  settings,
  synced = [VAULT],
  catchUpIndex = async () => true,
  notes = [],
  strict = false,
}: {
  key?: GranolaKeyStatus;
  settings?: string;
  synced?: readonly string[];
  catchUpIndex?: () => Promise<boolean>;
  notes?: readonly GranolaNote[];
  strict?: boolean;
} = {}) {
  const granola = fakeGranola({ notes });
  const onWrote = vi.fn();
  const status = { current: key };
  // Each listing waits on this first, so a test can hold one.
  const gate = { current: Promise.resolve() };
  const activity = recordingActivity();
  const records = memoryRecords();
  const options: GranolaPullOptions = {
    granola: {
      ...granola.port,
      status: async () => status.current,
      // As the host does, Granola's answer is kept as the key's status: a 401 marks it refused.
      listNotes: async (args) => {
        await gate.current;
        try {
          return await granola.port.listNotes(args);
        } catch (error) {
          if (error instanceof GranolaError && error.failure.status === 401)
            status.current = REFUSED;
          throw error;
        }
      },
    },
    records,
    fs: vaultWith(settings),
    markdown: remarkMarkdown,
    index: fakeIndexPort(),
    vaultKey: VAULT,
    syncedThisSession: new Set(synced),
    syncPulls: new Map(),
    catchUpIndex,
    clock: { now: () => Date.now() },
    activity,
    onWrote,
  };
  const { wrapper: reads, client } = queryWrapper();
  const hook = renderHook((props: GranolaPullOptions) => useGranolaPull(props), {
    initialProps: options,
    wrapper: reads,
    // StrictMode at the root, as main.tsx renders it. A <StrictMode> nested in a
    // wrapper does not run effects twice under React 19 (issue #159).
    reactStrictMode: strict,
  });
  const lists = () => granola.count('list');
  /** The settings note changed: the window reads it again, as its reads say for its path. */
  const settingsChanged = () => readAgain(client, vaultReadKey(VAULT, 'settings'));
  return {
    hook,
    granola,
    status,
    gate,
    activity,
    records,
    options,
    lists,
    onWrote,
    settingsChanged,
  };
}

/** Lets fifteen minutes pass on the fake timers. */
const fifteenMinutes = () => act(async () => vi.advanceTimersByTime(GRANOLA_PULL_INTERVAL_MS));

beforeEach(() => vi.useFakeTimers({ now: FIXED_NOW }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('useGranolaPull, attacked (PR #156)', () => {
  it('ATTACK: says it is pulling during a Sync now after the vault was closed and reopened mid-pull', async () => {
    const { hook, gate, options } = setUp({ synced: [VAULT, OTHER] });
    let asked = 0;
    const port = options.granola;
    const counting = {
      ...port,
      listNotes: (args: Parameters<typeof port.listNotes>[0]) => (
        (asked += 1),
        port.listNotes(args)
      ),
    };
    const first = held<void>();
    gate.current = first.promise;
    hook.rerender({ ...options, granola: counting });
    // The startup pull of VAULT is under way, its listing held.
    await settles(() => expect(hook.result.current.pulling).toBe(true));

    // Another vault is opened, and VAULT again, while that pull still runs.
    const both = new Set([VAULT, OTHER]);
    hook.rerender({ ...options, granola: counting, vaultKey: OTHER, syncedThisSession: both });
    await act(async () => undefined);
    hook.rerender({ ...options, granola: counting, syncedThisSession: both });
    await settles(() => expect(hook.result.current.key).toEqual(KEY_HELD));
    await act(async () => undefined);

    first.settle();
    await settles(() => expect(hook.result.current.report?.ended).toBe('pulled'));
    await settles(() => expect(hook.result.current.pulling).toBe(false));
    await act(async () => undefined);
    const before = asked;

    // Now a Sync now: the card must say it is pulling, and disable Sync now, until it ends.
    const second = held<void>();
    gate.current = second.promise;
    act(() => hook.result.current.syncNow());
    await settles(() => expect(asked).toBe(before + 1));
    expect(hook.result.current.pulling).toBe(true);
    second.settle();
    await settles(() => expect(hook.result.current.report?.mode).toBe('sync-now'));
  });

  it('ATTACK: React StrictMode (as main.tsx renders) lists Granola once on open', async () => {
    const catchUpIndex = vi.fn(async () => true);
    const { hook, lists } = setUp({ strict: true, catchUpIndex });
    await settles(() => expect(hook.result.current.report?.ended).toBe('pulled'));
    await act(async () => undefined);
    expect(lists()).toBe(1);
    // The double mount reaches the catch-up ask (the pull waits for its answer), so it is asked once.
    expect(catchUpIndex).toHaveBeenCalledOnce();
  });

  it('ATTACK: StrictMode keeps one 15-minute timer', async () => {
    // Two timers firing together list once (the puller joins the second pull to the
    // first), so the listings alone cannot tell: count the 15-minute timers running.
    // (The double mount itself ends before the timer can start: it waits for the key
    // and the index, so a missing cleanup is not what this catches.)
    const started = vi.spyOn(window, 'setInterval');
    const cleared = vi.spyOn(window, 'clearInterval');
    const running = () => {
      const gone = new Set(cleared.mock.calls.map(([id]) => id));
      return started.mock.calls.filter(
        ([, ms], call) =>
          ms === GRANOLA_PULL_INTERVAL_MS && !gone.has(started.mock.results[call]?.value),
      ).length;
    };
    const { lists } = setUp({ strict: true });
    await settles(() => expect(lists()).toBe(1));
    expect(running()).toBe(1);
    await fifteenMinutes();
    await settles(() => expect(lists()).toBe(2));
    await act(async () => undefined);
    expect(lists()).toBe(2);
    expect(running()).toBe(1);
  });

  it('ATTACK: timer + Sync now + key save at the same moment list at most twice', async () => {
    const { hook, gate, lists } = setUp();
    await settles(() => expect(lists()).toBe(1));
    await settles(() => expect(hook.result.current.pulling).toBe(false));
    const listing = held<void>();
    gate.current = listing.promise;
    await act(async () => {
      vi.advanceTimersByTime(GRANOLA_PULL_INTERVAL_MS);
      hook.result.current.syncNow();
      hook.result.current.syncNow();
      hook.result.current.knowKey({ hasKey: true, lastRefusal: null });
    });
    listing.settle();
    await settles(() => expect(hook.result.current.pulling).toBe(false));
    await act(async () => undefined);
    // The periodic pull, then the one Sync now queued behind it.
    expect(lists()).toBe(3);
  });

  it('ATTACK: no timer survives closing the vault', async () => {
    const { hook, lists, options } = setUp();
    await settles(() => expect(lists()).toBe(1));
    hook.rerender({ ...options, vaultKey: null });
    await fifteenMinutes();
    await fifteenMinutes();
    expect(lists()).toBe(1);
    hook.unmount();
    await fifteenMinutes();
    expect(lists()).toBe(1);
  });

  it('ATTACK: a vault reopened while its first catch-up is still out tries again when that one fails', async () => {
    const firstCatch = held<boolean>();
    let calls = 0;
    const catchUpIndex = vi.fn(() => {
      calls += 1;
      return calls === 1 ? firstCatch.promise : Promise.resolve(true);
    });
    const { hook, lists, options } = setUp({ catchUpIndex });
    await settles(() => expect(catchUpIndex).toHaveBeenCalledOnce());

    // Another vault, not yet synced, is opened; then this one again.
    hook.rerender({ ...options, vaultKey: OTHER, catchUpIndex });
    await act(async () => undefined);
    hook.rerender({ ...options, catchUpIndex: vi.fn(() => ((calls += 1), Promise.resolve(true))) });
    await act(async () => undefined);
    // The refresh asked for on the first open is dropped: the vault closed while it waited.
    firstCatch.settle(false);
    await act(async () => undefined);
    await fifteenMinutes();

    // "The vault opened again tries again" (useCaughtUp): it was opened again.
    await settles(() => expect(hook.result.current.ready).toBe(true));
    expect(lists()).toBeGreaterThan(0);
  });

  it('ATTACK: settings read out of order do not leave the 15-minute pull on after granola_periodic: false', async () => {
    const fixture = setUp({ settings: 'granola_periodic: true' });
    await settles(() => expect(fixture.hook.result.current.report?.ended).toBe('pulled'));
    let text = 'granola_periodic: true';
    const slow = held<void>();
    let slowOne = true;
    const fs = fakeVaultFs({
      readNotes: async (paths) => {
        if (!paths.includes('.atlas/settings.md')) return [];
        const said = text;
        if (slowOne) {
          slowOne = false;
          await slow.promise;
        }
        return [{ path: '.atlas/settings.md', text: `---\n${said}\n---\n`, modified: 1, size: 1 }];
      },
    });
    // The settings are read again (a change to the note); that read is slow.
    fixture.hook.rerender({ ...fixture.options, fs });
    void fixture.settingsChanged();
    await act(async () => undefined);
    // The person turns the 15-minute pull off; this read is quick.
    text = 'granola_periodic: false';
    await act(() => fixture.settingsChanged());
    await act(async () => undefined);
    // The slow, older read lands last.
    slow.settle();
    await act(async () => undefined);
    const after = fixture.lists();
    await fifteenMinutes();
    await act(async () => undefined);
    await fifteenMinutes();
    await act(async () => undefined);
    expect(fixture.lists()).toBe(after);
  });
  it('control: the same change read in order turns the 15-minute pull off', async () => {
    const fixture = setUp({ settings: 'granola_periodic: true' });
    await settles(() => expect(fixture.hook.result.current.report?.ended).toBe('pulled'));
    fixture.hook.rerender({ ...fixture.options, fs: vaultWith('granola_periodic: false') });
    await act(() => fixture.settingsChanged());
    await act(async () => undefined);
    const after = fixture.lists();
    await fifteenMinutes();
    await act(async () => undefined);
    expect(fixture.lists()).toBe(after);
  });
});
