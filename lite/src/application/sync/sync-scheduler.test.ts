import { FixedClock } from '../testing/index.ts';
import { createSyncScheduler, type SyncResult, type SyncStatus, type SyncTimers } from './index.ts';

/** Timers moved by hand: `advance(ms)` runs whatever falls due, in order. */
class ManualTimers implements SyncTimers {
  private now = 0;
  private pending: { at: number; run: () => void; id: number }[] = [];
  private nextId = 0;

  after(ms: number, run: () => void): () => void {
    const id = this.nextId++;
    this.pending.push({ at: this.now + ms, run, id });
    return () => {
      this.pending = this.pending.filter((timer) => timer.id !== id);
    };
  }

  get scheduled(): number {
    return this.pending.length;
  }

  async advance(ms: number): Promise<void> {
    const until = this.now + ms;
    for (;;) {
      const due = this.pending.filter(({ at }) => at <= until).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.pending = this.pending.filter((timer) => timer !== due);
      this.now = due.at;
      due.run();
      await flush();
    }
    this.now = until;
  }
}

const flush = async () => {
  for (let tick = 0; tick < 20; tick++) await Promise.resolve();
};

const SYNCED: SyncResult = { kind: 'synced', pulled: 0, pushed: 0, conflicts: [], headSha: 'h' };

function setup(results: SyncResult[] = []) {
  const timers = new ManualTimers();
  const clock = new FixedClock(new Date(2026, 10, 21, 9, 0));
  let calls = 0;
  let release: (() => void) | null = null;
  let hold = false;
  const syncNow = async () => {
    calls += 1;
    if (hold) await new Promise<void>((resolve) => (release = resolve));
    return results.shift() ?? SYNCED;
  };
  const scheduler = createSyncScheduler({
    syncNow,
    timers,
    clock,
    pushDelayMs: 3000,
    pullEveryMs: 60_000,
  });
  const seen: SyncStatus[] = [];
  scheduler.subscribe((status) => seen.push(status));
  return {
    timers,
    clock,
    scheduler,
    seen,
    calls: () => calls,
    holdNext: () => (hold = true),
    releaseHeld: () => {
      hold = false;
      release?.();
    },
  };
}

describe('the sync scheduler', () => {
  it('syncs on start, then pulls on its interval until stopped', async () => {
    const { scheduler, timers, calls, clock } = setup();
    await scheduler.start();
    expect(calls()).toBe(1);
    expect(scheduler.status()).toMatchObject({ phase: 'idle', lastSyncedAt: clock.now() });
    await timers.advance(60_000);
    expect(calls()).toBe(2);
    scheduler.stop();
    await timers.advance(600_000);
    expect(calls()).toBe(2);
    expect(timers.scheduled).toBe(0);
  });

  it('pushes a few seconds after the last change, once', async () => {
    const { scheduler, timers, calls } = setup();
    scheduler.noteChanged();
    await timers.advance(2000);
    scheduler.noteChanged();
    await timers.advance(2000);
    expect(calls()).toBe(0);
    await timers.advance(1000);
    expect(calls()).toBe(1);
  });

  it('never runs two syncs at once: a request meanwhile is one more run after', async () => {
    const { scheduler, calls, holdNext, releaseHeld, seen } = setup();
    holdNext();
    const first = scheduler.wake();
    await flush();
    expect(scheduler.status().phase).toBe('syncing');
    void scheduler.wake();
    void scheduler.wake();
    expect(calls()).toBe(1);
    releaseHeld();
    await first;
    expect(calls()).toBe(2);
    expect(seen.map(({ phase }) => phase)).toEqual(['syncing', 'idle', 'syncing', 'idle']);
  });

  it('says offline, then sign-in needed, and clears both on a good sync', async () => {
    const { scheduler } = setup([
      { kind: 'failed', reason: 'unreachable', message: 'GitHub could not be reached.' },
      { kind: 'failed', reason: 'auth', message: 'GitHub refused the token.' },
      { ...SYNCED, conflicts: [{ path: 'A.md', copy: 'A (conflict 2026-11-21).md' }] },
    ]);
    await scheduler.wake();
    expect(scheduler.status()).toMatchObject({ phase: 'offline', lastSyncedAt: null });
    await scheduler.wake();
    expect(scheduler.status()).toMatchObject({
      phase: 'needs-sign-in',
      message: 'GitHub refused the token.',
    });
    await scheduler.wake();
    expect(scheduler.status()).toMatchObject({ phase: 'idle', conflicts: 1, message: null });
  });

  it('keeps syncing when a status listener throws', async () => {
    const timers = new ManualTimers();
    const errors: unknown[] = [];
    let calls = 0;
    const scheduler = createSyncScheduler({
      syncNow: async () => {
        calls += 1;
        return SYNCED;
      },
      timers,
      clock: new FixedClock(),
      pushDelayMs: 3000,
      pullEveryMs: 60_000,
      onListenerError: (error) => errors.push(error),
    });
    scheduler.subscribe(() => {
      throw new Error('broken view');
    });
    await scheduler.wake();
    await scheduler.wake();
    expect(calls).toBe(2);
    expect(errors).toHaveLength(4);
    expect(scheduler.status().phase).toBe('idle');
  });

  it('arms no push after it is stopped', async () => {
    const { scheduler, timers, calls } = setup();
    await scheduler.start();
    scheduler.stop();
    scheduler.noteChanged();
    expect(timers.scheduled).toBe(0);
    await timers.advance(10_000);
    expect(calls()).toBe(1);
  });

  it('keeps going after a sync that throws', async () => {
    const timers = new ManualTimers();
    const scheduler = createSyncScheduler({
      syncNow: () => Promise.reject(new Error('bug')),
      timers,
      clock: new FixedClock(),
      pushDelayMs: 3000,
      pullEveryMs: 60_000,
    });
    await scheduler.start();
    expect(scheduler.status()).toMatchObject({ phase: 'error', message: 'bug' });
    expect(timers.scheduled).toBe(1);
  });
});
