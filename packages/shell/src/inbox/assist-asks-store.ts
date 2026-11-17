/**
 * When Suggest asked Claude, per vault, on this machine (#900). Suggest
 * writes no log, so its asks are kept here, in `localStorage` under
 * `atlas.inboxAssist.asks.<vault>`: per-machine state, never the vault's, and
 * shared by every window of the app, so a second window or a restart still
 * counts them. Kept to the last hour: older asks no longer count.
 *
 * Every access is guarded, as the sidebar's store is: the accessor throws in
 * a private window and wherever site data is blocked. Then the asks are kept
 * in memory for this window alone, which still holds this window to the hour.
 */

const KEY_PREFIX = 'atlas.inboxAssist.asks.';
const HOUR_MS = 3_600_000;
/** Far more than an hour's allowance: a list that grew past it is cut, never trusted to grow. */
const MAX_KEPT = 200;

export interface AssistAsks {
  /** When Suggest asked for `vault`, in wall-clock milliseconds. */
  asked(vault: string): readonly number[];
  /** Keeps an ask, made at `at`, and drops those more than an hour before it. */
  record(vault: string, at: number): void;
}

/** Where the asks are kept: a string per key. */
export interface AskStorage {
  read(key: string): string | null;
  write(key: string, text: string): void;
}

export function assistAsks(storage: AskStorage = memoryStorage()): AssistAsks {
  const asked = (vault: string) => parseAsks(storage.read(KEY_PREFIX + vault));
  return {
    asked,
    record: (vault, at) => {
      const kept = [...asked(vault), at].filter((each) => each > at - HOUR_MS).slice(-MAX_KEPT);
      storage.write(KEY_PREFIX + vault, JSON.stringify(kept));
    },
  };
}

/** The asks kept in this machine's `localStorage`, shared by its windows. */
export function browserAssistAsks(): AssistAsks {
  return assistAsks(guardedLocalStorage());
}

function memoryStorage(): AskStorage {
  const kept = new Map<string, string>();
  return { read: (key) => kept.get(key) ?? null, write: (key, text) => void kept.set(key, text) };
}

/** `localStorage`, or this window's memory where it cannot be reached. */
function guardedLocalStorage(): AskStorage {
  const fallback = memoryStorage();
  return {
    read: (key) => {
      try {
        return window.localStorage.getItem(key) ?? fallback.read(key);
      } catch {
        // Storage unreachable: what this window kept is what it counts.
        return fallback.read(key);
      }
    },
    write: (key, text) => {
      fallback.write(key, text);
      try {
        window.localStorage.setItem(key, text);
      } catch {
        // Safe to ignore: the ask is kept in this window's memory and still counts here.
      }
    },
  };
}

/** The ask times a stored text holds: finite numbers only; anything else reads as none. */
function parseAsks(text: string | null): readonly number[] {
  if (text === null) return [];
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value)
      ? value.filter((each): each is number => typeof each === 'number' && Number.isFinite(each))
      : [];
  } catch {
    // Not JSON: written by something else, or cut short. No asks is the reading that recovers.
    return [];
  }
}
