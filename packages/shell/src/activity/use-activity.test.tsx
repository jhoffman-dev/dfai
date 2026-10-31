// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ActivityReport } from '@dfai/domain';
import { createActivityLog, memoryActivityStore } from '@dfai/application';
import type { ActivitySeenStore } from './browser-activity-seen-store.ts';
import { useActivity } from './use-activity.ts';

const VAULT = '/Users/j/Vault';

function setUp() {
  let now = Date.UTC(2026, 8, 28, 9);
  const log = createActivityLog({
    store: memoryActivityStore(),
    clock: { now: () => now },
    vault: () => VAULT,
    // Written at once, so each record is read back without a timer.
    schedule: (write) => write(),
    onError: (cause) => {
      throw cause;
    },
  });
  const seenBy = new Map<string, number>();
  const seen: ActivitySeenStore = {
    read: (vault) => seenBy.get(vault) ?? null,
    write: (vault, at) => void seenBy.set(vault, at),
  };
  const clock = { now: () => now };
  // Every count the hook ever answered, render by render.
  const counts: number[] = [];
  const hook = renderHook(
    (props: { open: boolean }) => {
      const activity = useActivity({ log, vaultKey: VAULT, open: props.open, seen, clock });
      counts.push(activity.unseenErrors);
      return activity;
    },
    { initialProps: { open: false } },
  );
  const record = async (report: ActivityReport) => {
    now += 1000;
    await act(async () => {
      log.record(report);
      await log.flush();
    });
  };
  return { hook, record, log, seenBy, counts, tick: (ms: number) => (now += ms) };
}

const error = (message: string): ActivityReport => ({
  level: 'error',
  kind: 'app',
  message,
  subject: null,
});
const info = (message: string): ActivityReport => ({ ...error(message), level: 'info' });

describe('useActivity', () => {
  it('reads the lines newest first, as they are kept', async () => {
    const { hook, record } = setUp();
    await record(info('first'));
    await record(error('second'));
    await waitFor(() =>
      expect(hook.result.current.shown?.map((e) => e.message)).toEqual(['second', 'first']),
    );
    expect(hook.result.current.total).toBe(2);
  });

  it('counts the errors that arrived while the page was not open, and not the rest', async () => {
    const { hook, record } = setUp();
    await record(error('one'));
    await record(info('fine'));
    await record(error('two'));
    await waitFor(() => expect(hook.result.current.unseenErrors).toBe(2));
  });

  it('clears the count when the page opens, keeps it clear while open, and counts afresh after', async () => {
    const { hook, record, seenBy, tick } = setUp();
    await record(error('before'));
    await waitFor(() => expect(hook.result.current.unseenErrors).toBe(1));

    tick(1000);
    hook.rerender({ open: true });
    await waitFor(() => expect(seenBy.get(VAULT)).toBeGreaterThan(0));
    expect(hook.result.current.unseenErrors).toBe(0);
    await record(error('while open'));
    expect(hook.result.current.unseenErrors).toBe(0);

    tick(1000);
    hook.rerender({ open: false });
    await record(error('after'));
    await waitFor(() => expect(hook.result.current.unseenErrors).toBe(1));
  });

  it('never shows a count while the page is open, not even for the moment new lines arrive', async () => {
    const { hook, record, counts } = setUp();
    hook.rerender({ open: true });
    await record(error('while open'));
    await waitFor(() => expect(hook.result.current.total).toBe(1));
    expect(counts.slice(1)).not.toContain(1);
  });

  it('narrows what it shows by the query, keeping the newest first', async () => {
    const { hook, record } = setUp();
    await record(info('kept apple'));
    await record(error('broken apple'));
    await record(error('broken pear'));
    act(() => hook.result.current.setQuery({ level: 'errors', kinds: [], text: 'apple' }));
    await waitFor(() =>
      expect(hook.result.current.shown?.map((e) => e.message)).toEqual(['broken apple']),
    );
    expect(hook.result.current.total).toBe(3);
  });
});

describe('useActivity, adversarial (U-28)', () => {
  it('clears the badge on opening the page, even for an error dated while the clock ran ahead', async () => {
    const { hook, record, tick } = setUp();
    // The Mac's clock is a year fast when the error is kept, then corrected.
    tick(365 * 86_400_000);
    await record(error('kept while the clock was fast'));
    tick(-365 * 86_400_000);
    await waitFor(() => expect(hook.result.current.unseenErrors).toBe(1));

    hook.rerender({ open: true });
    await waitFor(() => expect(hook.result.current.unseenErrors).toBe(0));
    hook.rerender({ open: false });
    await waitFor(() => expect(hook.result.current.total).toBe(1));
    expect(hook.result.current.unseenErrors).toBe(0);
  });
});

describe('useActivity, after review (A28-01)', () => {
  it('takes the lines just kept from the log, rather than reading its file again', async () => {
    const files = memoryActivityStore();
    let reads = 0;
    const store = { ...files, read: (args: { vault: string }) => ((reads += 1), files.read(args)) };
    let now = Date.UTC(2026, 8, 28, 9);
    const log = createActivityLog({
      store,
      clock: { now: () => now },
      vault: () => VAULT,
      schedule: (write) => write(),
      onError: (cause) => {
        throw cause;
      },
    });
    const seen: ActivitySeenStore = { read: () => null, write: () => undefined };
    const hook = renderHook(() =>
      useActivity({ log, vaultKey: VAULT, open: false, seen, clock: { now: () => now } }),
    );
    await waitFor(() => expect(hook.result.current.shown).toEqual([]));
    const readsAtOpen = reads;
    for (const message of ['one', 'two', 'three']) {
      now += 1000;
      await act(async () => {
        log.record(error(message));
        await log.flush();
      });
    }
    await waitFor(() =>
      expect(hook.result.current.shown?.map((e) => e.message)).toEqual(['three', 'two', 'one']),
    );
    expect(reads).toBe(readsAtOpen);
  });

  it('leaves out lines kept in another vault’s log', async () => {
    const { hook, record, log } = setUp();
    await record(error('here'));
    await act(async () => {
      log.inVault('/Users/j/Other').record(error('elsewhere'));
      await log.flush();
    });
    await waitFor(() => expect(hook.result.current.total).toBe(1));
    expect(hook.result.current.shown?.map((e) => e.message)).toEqual(['here']);
  });
});
