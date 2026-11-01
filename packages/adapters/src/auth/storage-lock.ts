import type { CrossTabLock } from './function-auth-gateway.ts';

/*
 * The cross-tab lock where a browser has no Web Locks (Safari before 15.4),
 * kept in localStorage (#663, PR #704's attack): a key naming its holder and
 * when the hold lapses. A tab takes a free or lapsed key, waits a moment and
 * reads it back, since two tabs can write it at nearly the same time and the
 * later write wins; the one that reads its own name holds it. Others wait
 * for the `storage` event that says it was let go, or poll. A hold lapses
 * after HOLD_MS, so a tab closed mid-refresh cannot keep the rest out.
 *
 * It narrows the race, not closes it: the refresh's one retry on a refusal
 * (function-auth-gateway.ts) covers what gets through.
 */

/** Longer than a refresh can take: the function gives GitHub 10 s, and the retry waits 0.3 s. */
export const HOLD_MS = 30_000;
/** How long a tab waits before reading its claim back. */
export const SETTLE_MS = 25;
/** How often a waiting tab looks again, when no `storage` event comes. */
export const POLL_MS = 100;

export interface StorageLockDeps {
  readonly storage: Storage;
  /** Where other tabs' `storage` events arrive (the window); absent: polling alone. */
  readonly events?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  readonly now: () => number;
  /** A name for each hold, unique across tabs. */
  readonly holderId: () => string;
  /** Waits `ms`. setTimeout in the browser. */
  readonly wait: (ms: number) => Promise<void>;
}

interface Hold {
  readonly holder: string;
  readonly until: number;
}

const keyOf = (name: string) => `dfai.lock.${name}`;

function readHold(storage: Storage, key: string): Hold | null {
  try {
    const hold = JSON.parse(storage.getItem(key) ?? 'null') as Partial<Hold> | null;
    if (typeof hold?.holder === 'string' && typeof hold.until === 'number')
      return { holder: hold.holder, until: hold.until };
  } catch {
    // An unreadable key is no hold: it is taken over and written afresh.
  }
  return null;
}

export function storageLock(deps: StorageLockDeps): CrossTabLock {
  return async (name, task) => {
    const key = keyOf(name);
    const holder = deps.holderId();
    try {
      await acquire(deps, key, holder);
    } catch {
      // Storage refused the write (full, or private browsing): run unlocked, as with no lock at all.
      return task();
    }
    try {
      return await task();
    } finally {
      if (readHold(deps.storage, key)?.holder === holder) deps.storage.removeItem(key);
    }
  };
}

async function acquire(deps: StorageLockDeps, key: string, holder: string): Promise<void> {
  for (;;) {
    const hold = readHold(deps.storage, key);
    if (hold === null || hold.until <= deps.now()) {
      deps.storage.setItem(key, JSON.stringify({ holder, until: deps.now() + HOLD_MS }));
      await deps.wait(SETTLE_MS);
      if (readHold(deps.storage, key)?.holder === holder) return;
    } else {
      await letGoOrPoll(deps, key);
    }
  }
}

/** Until another tab changes the key, or POLL_MS, whichever comes first. */
function letGoOrPoll(deps: StorageLockDeps, key: string): Promise<void> {
  const { events } = deps;
  if (!events) return deps.wait(POLL_MS);
  let onStorage: (event: StorageEvent) => void = () => {};
  const changed = new Promise<void>((resolve) => {
    onStorage = (event) => {
      if (event.key === key || event.key === null) resolve();
    };
    events.addEventListener('storage', onStorage);
  });
  return Promise.race([changed, deps.wait(POLL_MS)]).finally(() =>
    events.removeEventListener('storage', onStorage),
  );
}
