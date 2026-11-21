import type { Clock, SyncTimers } from '../../application/index.ts';

/** The device's clock. */
export const systemClock: Clock = { now: () => new Date() };

/** The browser's timers, for the sync scheduler. */
export const systemTimers: SyncTimers = {
  after(ms, run) {
    const handle = setTimeout(run, ms);
    return () => clearTimeout(handle);
  },
};
