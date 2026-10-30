// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { explainGranolaFailure, type GranolaFailure, type GranolaNote } from '@dfai/domain';
import {
  fakeGranola,
  fakeIndexPort,
  fakeVaultFs,
  granolaNote,
  GranolaError,
  recordingActivity,
  type GranolaKeyStatus,
  type GranolaPullRecord,
  type GranolaPullRecords,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { drained, settles } from '@dfai/ui/testing/settles';
import {
  GRANOLA_PULL_INTERVAL_MS,
  INDEX_WAIT_MS,
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
const REFUSED: GranolaKeyStatus = { hasKey: true, lastRefusal: 401 };

const UNREACHABLE: GranolaFailure = { kind: 'unreachable', message: 'the network is down' };
const KEY_REFUSED: GranolaFailure = {
  kind: 'api_refused',
  status: 401,
  message: 'Granola answered 401',
};

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
}: {
  key?: GranolaKeyStatus;
  settings?: string;
  synced?: readonly string[];
  catchUpIndex?: () => Promise<boolean>;
  notes?: readonly GranolaNote[];
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
  const hook = renderHook((props: GranolaPullOptions) => useGranolaPull(props), {
    wrapper: queryWrapper().wrapper,
    initialProps: options,
  });
  const lists = () => granola.count('list');
  return { hook, granola, status, gate, activity, records, options, lists, onWrote };
}

/** Lets fifteen minutes pass on the fake timers. */
const fifteenMinutes = () => act(async () => vi.advanceTimersByTime(GRANOLA_PULL_INTERVAL_MS));

beforeEach(() => vi.useFakeTimers({ now: FIXED_NOW }));
afterEach(() => vi.useRealTimers());

describe('useGranolaPull', () => {
  it('pulls once as the vault opens, when it has synced and a key is held', async () => {
    const { hook, lists } = setUp();
    await settles(() => expect(hook.result.current.report?.ended).toBe('pulled'));
    expect(lists()).toBe(1);
    expect(hook.result.current.report?.mode).toBe('startup');
    expect(hook.result.current.ready).toBe(true);
  });

  it('waits for the first sync of the session, then for the index to catch up with it', async () => {
    const index = held<boolean>();
    const catchUpIndex = vi.fn(() => index.promise);
    const { hook, lists, options } = setUp({ synced: [], catchUpIndex });
    await act(async () => undefined);
    expect(catchUpIndex).not.toHaveBeenCalled();
    expect(lists()).toBe(0);

    // Sync has pulled: the index is refreshed, and nothing is pulled until it has caught up.
    hook.rerender({ ...options, syncedThisSession: new Set([VAULT]) });
    await settles(() => expect(catchUpIndex).toHaveBeenCalledOnce());
    await act(async () => undefined);
    expect(lists()).toBe(0);
    expect(hook.result.current.ready).toBe(false);

    index.settle(true);
    await settles(() => expect(lists()).toBe(1));
    expect(hook.result.current.ready).toBe(true);
  });

  it('does not pull while the index could not catch up', async () => {
    const { hook, lists } = setUp({ catchUpIndex: async () => false });
    await act(async () => undefined);
    await fifteenMinutes();
    expect(lists()).toBe(0);
    expect(hook.result.current.ready).toBe(false);
  });

  it('after a later sync brings files in, waits for the index to catch up with them before a pull', async () => {
    const later = held<boolean>();
    const catchUpIndex = vi.fn(async () => true);
    const { hook, lists, options } = setUp({ catchUpIndex });
    await settles(() => expect(hook.result.current.report?.ended).toBe('pulled'));
    expect(catchUpIndex).toHaveBeenCalledOnce();

    // Another Mac's files come in with a later sync; the index is asked to catch up with them.
    catchUpIndex.mockImplementationOnce(() => later.promise);
    hook.rerender({ ...options, catchUpIndex, syncPulls: new Map([[VAULT, 1]]) });
    await settles(() => expect(catchUpIndex).toHaveBeenCalledTimes(2));
    await settles(() => expect(hook.result.current.ready).toBe(false));

    // Sync now and the 15-minute pull, asked for meanwhile, wait for it. Sync now is
    // pressed a minute before the timer, so neither has waited the INDEX_WAIT_MS it may.
    await act(async () => vi.advanceTimersByTime(GRANOLA_PULL_INTERVAL_MS - 60_000));
    act(() => hook.result.current.syncNow());
    await act(async () => vi.advanceTimersByTime(60_000));
    await act(async () => undefined);
    expect(lists()).toBe(1);
    expect(hook.result.current.pulling).toBe(true);

    later.settle(true);
    // The Sync now, asked for first, which the timed pull joins.
    await settles(() => expect(lists()).toBe(2));
    expect(hook.result.current.ready).toBe(true);
    await settles(() => expect(hook.result.current.pulling).toBe(false));
    expect(hook.result.current.report?.mode).toBe('sync-now');
    // The catch-up after a later sync starts no pull of its own: no second startup pull.
    await act(async () => undefined);
    expect(lists()).toBe(2);
    expect(catchUpIndex).toHaveBeenCalledTimes(2);
  });

  it('a pull waiting for one catch-up waits for the next too, when a sync lands meanwhile', async () => {
    const second = held<boolean>();
    const third = held<boolean>();
    const catchUpIndex = vi.fn(async () => true);
    const { hook, lists, options } = setUp({ catchUpIndex });
    await settles(() => expect(hook.result.current.report?.ended).toBe('pulled'));
    catchUpIndex.mockImplementationOnce(() => second.promise);
    hook.rerender({ ...options, catchUpIndex, syncPulls: new Map([[VAULT, 1]]) });
    await settles(() => expect(catchUpIndex).toHaveBeenCalledTimes(2));
    act(() => hook.result.current.syncNow());

    // A third sync lands while Sync now waits for the second's catch-up, which then answers.
    catchUpIndex.mockImplementationOnce(() => third.promise);
    hook.rerender({ ...options, catchUpIndex, syncPulls: new Map([[VAULT, 2]]) });
    await settles(() => expect(catchUpIndex).toHaveBeenCalledTimes(3));
    await act(async () => second.settle(true));
    await act(async () => undefined);
    expect(lists()).toBe(1);
    expect(hook.result.current.pulling).toBe(true);
    expect(hook.result.current.report?.mode).toBe('startup');

    await act(async () => third.settle(true));
    await settles(() => expect(hook.result.current.report?.mode).toBe('sync-now'));
    expect(hook.result.current.report?.ended).toBe('pulled');
    expect(lists()).toBe(2);
    await settles(() => expect(hook.result.current.pulling).toBe(false));
  });

  it('gives up a pull whose catch-up has not answered in two minutes, and says so in Activity', async () => {
    const catchUpIndex = vi.fn(async () => true);
    const { hook, lists, options, activity } = setUp({ catchUpIndex });
    const said = () => activity.reports.map((report) => report.message);
    await settles(() => expect(hook.result.current.report?.ended).toBe('pulled'));
    catchUpIndex.mockImplementationOnce(() => new Promise<boolean>(() => {}));
    hook.rerender({ ...options, catchUpIndex, syncPulls: new Map([[VAULT, 1]]) });
    await settles(() => expect(catchUpIndex).toHaveBeenCalledTimes(2));
    act(() => hook.result.current.syncNow());

    await act(async () => vi.advanceTimersByTime(INDEX_WAIT_MS - 1_000));
    expect(hook.result.current.pulling).toBe(true);
    expect(said().join('\n')).not.toContain('timed out');

    await act(async () => vi.advanceTimersByTime(1_000));
    await settles(() => expect(hook.result.current.pulling).toBe(false));
    expect(hook.result.current.report).toMatchObject({ mode: 'sync-now', ended: 'not-synced' });
    expect(lists()).toBe(1);
    expect(said()).toContain(
      'Granola: the pull did not start: waiting for the index timed out. The next sync, or opening the vault again, tries again.',
    );
    expect(INDEX_WAIT_MS).toBe(2 * 60_000);
  });

  it('a newer catch-up takes the place of one that never answers, with its own two minutes', async () => {
    const third = held<boolean>();
    const catchUpIndex = vi.fn(async () => true);
    const { hook, lists, options, activity } = setUp({ catchUpIndex });
    await settles(() => expect(hook.result.current.report?.ended).toBe('pulled'));
    catchUpIndex.mockImplementationOnce(() => new Promise<boolean>(() => {}));
    hook.rerender({ ...options, catchUpIndex, syncPulls: new Map([[VAULT, 1]]) });
    await settles(() => expect(catchUpIndex).toHaveBeenCalledTimes(2));
    act(() => hook.result.current.syncNow());
    await act(async () => vi.advanceTimersByTime(90_000));

    catchUpIndex.mockImplementationOnce(() => third.promise);
    hook.rerender({ ...options, catchUpIndex, syncPulls: new Map([[VAULT, 2]]) });
    await settles(() => expect(catchUpIndex).toHaveBeenCalledTimes(3));
    // Three minutes since Sync now was pressed, ninety seconds into the newer catch-up.
    await act(async () => vi.advanceTimersByTime(90_000));
    expect(hook.result.current.pulling).toBe(true);
    expect(activity.reports.map((report) => report.message).join('\n')).not.toContain('timed out');

    await act(async () => third.settle(true));
    await settles(() => expect(hook.result.current.report?.mode).toBe('sync-now'));
    expect(hook.result.current.report?.ended).toBe('pulled');
    expect(lists()).toBe(2);
    await settles(() => expect(hook.result.current.pulling).toBe(false));
  });

  it('a pull waiting for a vault’s catch-up stops waiting once another vault is opened', async () => {
    const catchUpIndex = vi.fn(async () => true);
    const { hook, options } = setUp({ catchUpIndex, synced: [VAULT, OTHER] });
    await settles(() => expect(hook.result.current.report?.ended).toBe('pulled'));
    catchUpIndex.mockImplementationOnce(() => new Promise<boolean>(() => {}));
    hook.rerender({ ...options, catchUpIndex, syncPulls: new Map([[VAULT, 1]]) });
    await settles(() => expect(catchUpIndex).toHaveBeenCalledTimes(2));
    act(() => hook.result.current.syncNow());
    await act(async () => undefined);
    expect(hook.result.current.pulling).toBe(true);

    // The other vault opens, its catch-up never answering; then this one again, its catch-up held.
    catchUpIndex.mockImplementationOnce(() => new Promise<boolean>(() => {}));
    hook.rerender({ ...options, catchUpIndex, vaultKey: OTHER, syncPulls: new Map([[VAULT, 1]]) });
    await settles(() => expect(catchUpIndex).toHaveBeenCalledTimes(3));
    // The waiting pull has its turns to see the other vault open before this one opens again.
    await drained();
    const back = held<boolean>();
    catchUpIndex.mockImplementationOnce(() => back.promise);
    hook.rerender({ ...options, catchUpIndex, syncPulls: new Map([[VAULT, 1]]) });
    await settles(() => expect(catchUpIndex).toHaveBeenCalledTimes(4));
    // The Sync now asked for before is over: it did not wait on the other vault's index.
    await settles(() => expect(hook.result.current.pulling).toBe(false));
  });

  it('pulls nothing while a later sync’s catch-up has failed, and asks again on the next sync only', async () => {
    const catchUpIndex = vi.fn(async () => true);
    const { hook, lists, options } = setUp({ catchUpIndex });
    await settles(() => expect(lists()).toBe(1));
    catchUpIndex.mockImplementationOnce(async () => false);
    hook.rerender({ ...options, catchUpIndex, syncPulls: new Map([[VAULT, 1]]) });
    await settles(() => expect(catchUpIndex).toHaveBeenCalledTimes(2));
    await act(async () => undefined);
    expect(hook.result.current.ready).toBe(false);

    act(() => hook.result.current.syncNow());
    await fifteenMinutes();
    await act(async () => undefined);
    expect(lists()).toBe(1);
    expect(catchUpIndex).toHaveBeenCalledTimes(2);

    // The next sync that brings files in asks again, and then the vault is pulled into.
    hook.rerender({ ...options, catchUpIndex, syncPulls: new Map([[VAULT, 2]]) });
    await settles(() => expect(hook.result.current.ready).toBe(true));
    expect(catchUpIndex).toHaveBeenCalledTimes(3);
    act(() => hook.result.current.syncNow());
    await settles(() => expect(lists()).toBe(2));
  });

  it('a vault whose catch-up failed asks again when it is opened again', async () => {
    const catchUpIndex = vi.fn(async () => false);
    const { hook, lists, options } = setUp({ synced: [VAULT, OTHER], catchUpIndex });
    await settles(() => expect(catchUpIndex).toHaveBeenCalledOnce());
    await act(async () => undefined);
    expect(hook.result.current.ready).toBe(false);

    hook.rerender({ ...options, catchUpIndex, vaultKey: OTHER });
    await settles(() => expect(catchUpIndex).toHaveBeenCalledTimes(2));
    catchUpIndex.mockImplementation(async () => true);
    hook.rerender({ ...options, catchUpIndex });
    await settles(() => expect(hook.result.current.ready).toBe(true));
    expect(catchUpIndex).toHaveBeenCalledTimes(3);
    await settles(() => expect(lists()).toBe(1));
  });

  it('a catch-up asked for before the vault was opened again does not undo the one after', async () => {
    const first = held<boolean>();
    const catchUpIndex = vi.fn(() => first.promise);
    const { hook, lists, options } = setUp({ catchUpIndex });
    await settles(() => expect(catchUpIndex).toHaveBeenCalledOnce());
    hook.rerender({ ...options, catchUpIndex, vaultKey: OTHER });
    await act(async () => undefined);
    catchUpIndex.mockImplementation(async () => true);
    hook.rerender({ ...options, catchUpIndex });
    await settles(() => expect(hook.result.current.ready).toBe(true));
    await settles(() => expect(lists()).toBe(1));

    // The first open's catch-up answers last.
    first.settle(true);
    await act(async () => undefined);
    expect(hook.result.current.ready).toBe(true);
  });

  it('coming back from a vault that has not synced pulls once, not twice', async () => {
    const { hook, lists, options } = setUp({ synced: [VAULT] });
    await settles(() => expect(lists()).toBe(1));
    hook.rerender({ ...options, vaultKey: OTHER });
    await act(async () => undefined);
    hook.rerender(options);
    await settles(() => expect(lists()).toBe(2));
    await settles(() => expect(hook.result.current.pulling).toBe(false));
    await act(async () => undefined);
    expect(lists()).toBe(2);
  });

  it('says it is pulling only of the vault a pull is under way in', async () => {
    const { hook, gate, options } = setUp({ synced: [VAULT] });
    const listing = held<void>();
    gate.current = listing.promise;
    await settles(() => expect(hook.result.current.pulling).toBe(true));
    hook.rerender({ ...options, vaultKey: OTHER });
    await act(async () => undefined);
    expect(hook.result.current.pulling).toBe(false);
    listing.settle();
  });

  it('pulls nothing without a key, nor with one Granola refused', async () => {
    const none = setUp({ key: NO_KEY });
    await settles(() => expect(none.hook.result.current.key).toEqual(NO_KEY));
    await fifteenMinutes();
    expect(none.lists()).toBe(0);

    const refused = setUp({ key: REFUSED });
    await settles(() => expect(refused.hook.result.current.key).toEqual(REFUSED));
    await fifteenMinutes();
    expect(refused.lists()).toBe(0);
  });

  it('pulls every 15 minutes', async () => {
    const { hook, lists } = setUp();
    await settles(() => expect(lists()).toBe(1));
    await fifteenMinutes();
    await settles(() => expect(lists()).toBe(2));
    expect(hook.result.current.report?.mode).toBe('periodic');
    await fifteenMinutes();
    await settles(() => expect(lists()).toBe(3));
  });

  it('has no 15-minute pull when the vault’s settings say granola_periodic: false', async () => {
    const { lists } = setUp({ settings: 'granola_periodic: false' });
    await settles(() => expect(lists()).toBe(1));
    await fifteenMinutes();
    await fifteenMinutes();
    expect(lists()).toBe(1);
  });

  it('opening another vault and coming back pulls once per open, and keeps one timer', async () => {
    const { hook, lists, options } = setUp({ synced: [VAULT, OTHER] });
    await settles(() => expect(lists()).toBe(1));

    hook.rerender({ ...options, vaultKey: OTHER, syncedThisSession: new Set([VAULT, OTHER]) });
    await settles(() => expect(lists()).toBe(2));
    hook.rerender({ ...options, syncedThisSession: new Set([VAULT, OTHER]) });
    await settles(() => expect(lists()).toBe(3));
    await act(async () => undefined);
    expect(lists()).toBe(3);

    await fifteenMinutes();
    await settles(() => expect(lists()).toBe(4));
    await act(async () => undefined);
    expect(lists()).toBe(4);
  });

  it('says it is pulling while a Sync now runs', async () => {
    const { hook, gate, lists } = setUp();
    await settles(() => expect(lists()).toBe(1));
    await settles(() => expect(hook.result.current.pulling).toBe(false));
    const listing = held<void>();
    gate.current = listing.promise;
    act(() => hook.result.current.syncNow());
    await settles(() => expect(hook.result.current.pulling).toBe(true));
    listing.settle();
    await settles(() => expect(hook.result.current.pulling).toBe(false));
    expect(hook.result.current.report?.mode).toBe('sync-now');
  });

  it('a Sync now for the API settles to its report, and is the card’s too (P28-13)', async () => {
    const { hook, lists } = setUp({
      notes: [granolaNote('not_hook000000002', { updatedAt: '2026-10-13T15:00:00Z' })],
    });
    await settles(() => expect(hook.result.current.report?.mode).toBe('startup'));
    let report: Awaited<ReturnType<typeof hook.result.current.syncNowFor>> | null = null;
    await act(async () => {
      report = await hook.result.current.syncNowFor(VAULT);
    });
    expect(report).toMatchObject({ vault: VAULT, mode: 'sync-now', ended: 'pulled' });
    expect(lists()).toBe(2);
    expect(hook.result.current.report).toBe(report);
    expect(hook.result.current.pulling).toBe(false);
  });

  it('a Sync now for the API of a vault no longer open pulls nothing into it (P28-13)', async () => {
    const { hook, lists } = setUp();
    await settles(() => expect(hook.result.current.report?.ended).toBe('pulled'));
    let ended: string | null = null;
    await act(async () => {
      ended = (await hook.result.current.syncNowFor(OTHER)).ended;
    });
    expect(ended).toBe('not-synced');
    expect(lists()).toBe(1);
  });

  it('a Sync now for the API that fails shows on the card, never as a toast (P28-13)', async () => {
    const { hook, granola, lists } = setUp();
    await settles(() => expect(lists()).toBe(1));
    granola.fail('list', UNREACHABLE);
    await act(async () => {
      await hook.result.current.syncNowFor(VAULT);
    });
    expect(hook.result.current.report).toMatchObject({ mode: 'sync-now', ended: 'failed' });
    expect(hook.result.current.toast).toBeNull();
    expect(hook.result.current.toastShown).toBe(0);
  });

  it('a Sync now for the API that Granola refuses the key on raises no toast either (P28-13)', async () => {
    const { hook, granola, lists } = setUp();
    await settles(() => expect(lists()).toBe(1));
    granola.fail('list', KEY_REFUSED);
    await act(async () => {
      await hook.result.current.syncNowFor(VAULT);
    });
    expect(hook.result.current.report?.keyRefused).toBe(true);
    expect(hook.result.current.toast).toBeNull();
  });

  it('says a vault is ready for the API only once it is open, synced and caught up (P28-13)', async () => {
    const index = held<boolean>();
    const { hook, options } = setUp({ synced: [], catchUpIndex: () => index.promise });
    await act(async () => undefined);
    expect(hook.result.current.readyFor(VAULT)).toBe(false);

    hook.rerender({ ...options, syncedThisSession: new Set([VAULT]) });
    await act(async () => undefined);
    expect(hook.result.current.readyFor(VAULT)).toBe(false);

    index.settle(true);
    await settles(() => expect(hook.result.current.readyFor(VAULT)).toBe(true));
    expect(hook.result.current.readyFor(OTHER)).toBe(false);

    // Another vault opened: the one before is no longer ready, whatever it was.
    hook.rerender({ ...options, syncedThisSession: new Set([VAULT]), vaultKey: OTHER });
    expect(hook.result.current.readyFor(VAULT)).toBe(false);
  });

  it('has the tree and the index read again once a pull has written meetings, and not before', async () => {
    const none = setUp();
    await settles(() => expect(none.hook.result.current.report?.ended).toBe('pulled'));
    expect(none.onWrote).not.toHaveBeenCalled();

    const some = setUp({
      notes: [granolaNote('not_hook000000001', { updatedAt: '2026-10-13T15:00:00Z' })],
    });
    await settles(() => expect(some.hook.result.current.report?.written).toHaveLength(1));
    expect(some.onWrote).toHaveBeenCalledOnce();
  });

  it('keeps the last pull’s time from this Mac’s record', async () => {
    const { hook, records } = setUp();
    await settles(() => expect(hook.result.current.report?.ended).toBe('pulled'));
    expect(hook.result.current.lastPullAt).toBe(records.read(VAULT).lastPullAt);
    expect(hook.result.current.lastPullAt).not.toBeNull();
  });

  it('a startup pull that fails says so in Activity, not as a toast', async () => {
    const { hook, granola, activity } = setUpFailing(UNREACHABLE);
    await settles(() => expect(hook.result.current.report?.ended).toBe('failed'));
    expect(granola.count('list')).toBe(1);
    expect(hook.result.current.toast).toBeNull();
    expect(activity.reports.map((report) => report.message).join('\n')).toContain(
      'Granola could not be reached',
    );
  });

  it('a Sync now that fails says why as a toast, in the words the failure is explained in', async () => {
    const { hook, granola, lists } = setUp();
    await settles(() => expect(lists()).toBe(1));
    granola.fail('list', UNREACHABLE);
    act(() => hook.result.current.syncNow());
    await settles(() => expect(hook.result.current.toast).not.toBeNull());
    expect(hook.result.current.toast).toBe(hook.result.current.report?.problem);
    expect(hook.result.current.toast).toContain('Granola could not be reached');
    expect(hook.result.current.toast).toContain(explainGranolaFailure(UNREACHABLE).problem);

    act(() => hook.result.current.dismissToast(hook.result.current.toastShown));
    expect(hook.result.current.toast).toBeNull();
  });

  it('a Sync now that fails again with the same words shows the toast again (#328)', async () => {
    const { hook, granola, lists } = setUp();
    await settles(() => expect(lists()).toBe(1));
    granola.fail('list', UNREACHABLE);
    act(() => hook.result.current.syncNow());
    await settles(() => expect(hook.result.current.toast).not.toBeNull());
    const first = { words: hook.result.current.toast, shown: hook.result.current.toastShown };
    expect(first.shown).toBe(1);

    act(() => hook.result.current.dismissToast(hook.result.current.toastShown));
    // A scripted failure answers one call: the next Sync now fails the same way again.
    granola.fail('list', UNREACHABLE);
    act(() => hook.result.current.syncNow());
    await settles(() => expect(hook.result.current.toast).not.toBeNull());
    // The same words: the Toast is keyed by the count, so it starts its time afresh.
    expect(hook.result.current.toast).toBe(first.words);
    expect(hook.result.current.toastShown).toBe(2);
  });

  it('a Sync now that fails again while its toast is still up counts a second showing (#328)', async () => {
    const { hook, granola, lists } = setUp();
    await settles(() => expect(lists()).toBe(1));
    granola.fail('list', UNREACHABLE);
    act(() => hook.result.current.syncNow());
    await settles(() => expect(hook.result.current.toastShown).toBe(1));
    const words = hook.result.current.toast;

    // No dismiss: the toast is still showing when the next Sync now fails the same way.
    granola.fail('list', UNREACHABLE);
    act(() => hook.result.current.syncNow());
    await settles(() => expect(hook.result.current.toastShown).toBe(2));
    expect(hook.result.current.toast).toBe(words);
  });

  it('the first showing’s time running out after a second showing leaves the second up', async () => {
    const { hook, granola, lists } = setUp();
    await settles(() => expect(lists()).toBe(1));
    granola.fail('list', UNREACHABLE);
    act(() => hook.result.current.syncNow());
    await settles(() => expect(hook.result.current.toastShown).toBe(1));
    granola.fail('list', UNREACHABLE);
    act(() => hook.result.current.syncNow());
    await settles(() => expect(hook.result.current.toastShown).toBe(2));

    // The first Toast's timer can fire before the window draws the second in its place.
    act(() => hook.result.current.dismissToast(1));
    expect(hook.result.current.toast).toContain('Granola could not be reached');

    act(() => hook.result.current.dismissToast(2));
    expect(hook.result.current.toast).toBeNull();
  });

  it('a key Granola refuses is said as a toast once, and then nothing is pulled by itself', async () => {
    const { hook, granola, lists } = setUp();
    granola.fail('list', KEY_REFUSED);
    await settles(() => expect(hook.result.current.report?.keyRefused).toBe(true));
    await settles(() => expect(hook.result.current.toast).toContain('Granola refused the API key'));
    act(() => hook.result.current.dismissToast(hook.result.current.toastShown));
    await settles(() => expect(hook.result.current.key).toEqual(REFUSED));

    await fifteenMinutes();
    await act(async () => undefined);
    expect(lists()).toBe(1);
    expect(hook.result.current.toast).toBeNull();
  });

  it('sets aside a key read that fails after a newer answer was told', async () => {
    const { hook, options } = setUp({ synced: [] });
    await settles(() => expect(hook.result.current.key).toEqual(KEY_HELD));
    // Another vault opens, and its key is read; the person saves a key before that read answers.
    let fail: (cause: unknown) => void = () => {};
    const failing = new Promise<GranolaKeyStatus>((_, reject) => (fail = reject));
    const granola = { ...options.granola, status: () => failing };
    hook.rerender({ ...options, granola, vaultKey: OTHER });
    act(() => hook.result.current.knowKey(KEY_HELD));
    await act(async () => fail(new Error('the host did not answer')));
    expect(hook.result.current.key).toEqual(KEY_HELD);
    expect(hook.result.current.keyProblem).toBeNull();
  });

  it('pulls once a key is set where there was none', async () => {
    const { hook, lists } = setUp({ key: NO_KEY });
    await settles(() => expect(hook.result.current.key).toEqual(NO_KEY));
    expect(lists()).toBe(0);
    act(() => hook.result.current.knowKey(KEY_HELD));
    await settles(() => expect(lists()).toBe(1));
  });
});

/** A vault whose first listing fails as `failure` says. */
function setUpFailing(failure: GranolaFailure) {
  const fixture = setUp({ synced: [] });
  fixture.granola.fail('list', failure);
  fixture.hook.rerender({ ...fixture.options, syncedThisSession: new Set([VAULT]) });
  return fixture;
}

describe('useGranolaPull for the API, under attack (#613)', () => {
  it('is not ready for the API after the vault is closed and opened again, until its index catches up again', async () => {
    let catchUps = 0;
    const second = held<boolean>();
    const { hook, options } = setUp({
      catchUpIndex: () => {
        catchUps += 1;
        return catchUps === 1 ? Promise.resolve(true) : second.promise;
      },
    });
    await settles(() => expect(hook.result.current.readyFor(VAULT)).toBe(true));

    hook.rerender({ ...options, vaultKey: OTHER });
    await act(async () => undefined);
    hook.rerender({ ...options, vaultKey: VAULT });
    await act(async () => undefined);

    expect(catchUps).toBe(2);
    expect(hook.result.current.readyFor(VAULT)).toBe(false);
    second.settle(true);
    await settles(() => expect(hook.result.current.readyFor(VAULT)).toBe(true));
  });

  it('is not ready for the API once a later sync brings files in, until the index catches up with it', async () => {
    let catchUps = 0;
    const second = held<boolean>();
    const { hook, options } = setUp({
      catchUpIndex: () => {
        catchUps += 1;
        return catchUps === 1 ? Promise.resolve(true) : second.promise;
      },
    });
    await settles(() => expect(hook.result.current.readyFor(VAULT)).toBe(true));

    hook.rerender({ ...options, syncPulls: new Map([[VAULT, 1]]) });
    await act(async () => undefined);

    expect(hook.result.current.readyFor(VAULT)).toBe(false);
    second.settle(true);
    await settles(() => expect(hook.result.current.readyFor(VAULT)).toBe(true));
  });

  it('lists Granola once for a burst of API pulls and the window’s own Sync now together', async () => {
    const { hook, gate, lists } = setUp();
    await settles(() => expect(lists()).toBe(1));
    const listing = held<void>();
    gate.current = listing.promise;

    let reports: Awaited<ReturnType<typeof hook.result.current.syncNowFor>>[] = [];
    await act(async () => {
      const api = [1, 2, 3].map(() => hook.result.current.syncNowFor(VAULT));
      hook.result.current.syncNow();
      listing.settle();
      reports = await Promise.all(api);
    });
    await drained();

    expect(lists()).toBe(2);
    expect(new Set(reports).size).toBe(1);
    expect(hook.result.current.pulling).toBe(false);
  });
});
