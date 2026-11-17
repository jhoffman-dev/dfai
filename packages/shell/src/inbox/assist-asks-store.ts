/**
 * When Suggest asked Claude, per vault, on this machine (#900, #903). Suggest
 * writes no log, so its asks are kept here, in `localStorage` under
 * `atlas.inboxAssist.asks.<vault>`: per-machine state, never the vault's, and
 * shared by every window of the app, so a second window or a restart still
 * counts them. Kept to the last hour: older asks no longer count.
 *
 * Each window also keeps its own copy of every ask it has recorded or read,
 * and counts the two together, so an ask is never lost to storage that
 * cannot be reached, will not take a write (full), or holds something that
 * does not read: then the window's own copy, with the rules' logged asks,
 * is what holds it to the hour. That cannot be perfect — asks another
 * window made and storage lost are not known here — and is the best a
 * per-machine record can do.
 */

const KEY_PREFIX = 'atlas.inboxAssist.asks.';
const HOUR_MS = 3_600_000;
/** Far more than an hour's allowance: a list that grew past it is cut, never trusted to grow. */
const MAX_KEPT = 200;

export interface AssistAsks {
  /**
   * When Suggest asked for `vault`, in wall-clock milliseconds. Given `now`,
   * a time after it — kept while the clock ran fast — is kept as `now` from
   * then on, so it ages out an hour later rather than holding Suggest all day.
   */
  asked(vault: string, now?: number): readonly number[];
  /** Keeps an ask made at `at`, and drops those more than an hour before it. */
  record(vault: string, at: number): void;
  /** Takes back one ask kept at `at`: one that was claimed and never sent. */
  withdraw(vault: string, at: number): void;
}

/** Where the asks are kept: a string per key. Either call may throw. */
export interface AskStorage {
  read(key: string): string | null;
  write(key: string, text: string): void;
}

export function assistAsks(storage: AskStorage = memoryStorage()): AssistAsks {
  const own = new Map<string, readonly number[]>();
  const keep = (vault: string, times: readonly number[]) => {
    own.set(vault, times);
    try {
      storage.write(KEY_PREFIX + vault, JSON.stringify(times));
    } catch {
      // Safe to ignore: the window's own copy holds the ask and is counted with what is stored.
    }
  };
  const asked = (vault: string, now?: number) => {
    const times = together(storedAsks(storage, vault), own.get(vault) ?? []);
    if (now === undefined || !times.some((at) => at > now)) return times;
    const clamped = times.map((at) => Math.min(at, now));
    keep(vault, clamped);
    return clamped;
  };
  return {
    asked,
    record: (vault, at) => {
      const kept = [...asked(vault, at), at].filter((each) => each > at - HOUR_MS);
      keep(vault, kept.slice(-MAX_KEPT));
    },
    withdraw: (vault, at) => {
      const times = [...asked(vault)];
      const index = times.indexOf(at);
      if (index === -1) return;
      times.splice(index, 1);
      keep(vault, times);
    },
  };
}

/** The asks kept in this machine's `localStorage`, shared by its windows. */
export function browserAssistAsks(): AssistAsks {
  return assistAsks({
    read: (key) => window.localStorage.getItem(key),
    write: (key, text) => window.localStorage.setItem(key, text),
  });
}

function memoryStorage(): AskStorage {
  const kept = new Map<string, string>();
  return { read: (key) => kept.get(key) ?? null, write: (key, text) => void kept.set(key, text) };
}

/** What storage holds for `vault`, or null when it cannot be read or does not read as ask times. */
function storedAsks(storage: AskStorage, vault: string): readonly number[] | null {
  try {
    return parseAsks(storage.read(KEY_PREFIX + vault));
  } catch {
    // Storage unreachable: the window's own copy is what it counts.
    return null;
  }
}

/** Both lists as one, oldest first: each time as many times as either list holds it. */
function together(stored: readonly number[] | null, own: readonly number[]): readonly number[] {
  if (stored === null) return own;
  const counts = new Map<number, number>();
  for (const list of [stored, own]) {
    const here = new Map<number, number>();
    for (const at of list) here.set(at, (here.get(at) ?? 0) + 1);
    for (const [at, count] of here) counts.set(at, Math.max(counts.get(at) ?? 0, count));
  }
  return [...counts]
    .flatMap(([at, count]) => Array.from({ length: count }, () => at))
    .sort((a, b) => a - b);
}

/** The ask times a stored text holds; [] for none stored; null for a value that does not read. */
function parseAsks(text: string | null): readonly number[] | null {
  if (text === null) return [];
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value) &&
      value.every((each) => typeof each === 'number' && Number.isFinite(each))
      ? (value as number[])
      : null;
  } catch {
    // Not JSON: cut short or written by something else. Unknown, not none.
    return null;
  }
}
