import { NO_KINDLE_SYNC_RECORD, type KindleLastSync, type KindleSyncRecord } from '@dfai/domain';
import type { KindleSyncRecords } from '@dfai/application';

const KEY = 'atlas.kindle-sync';

const timeOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

function lastOf(value: unknown): KindleLastSync | null {
  if (typeof value !== 'object' || value === null) return null;
  const { at, message, ok } = value as Record<string, unknown>;
  const when = timeOf(at);
  if (when === null || typeof message !== 'string' || typeof ok !== 'boolean') return null;
  return { at: when, message, ok };
}

/** A record as kept, or none when what is kept is not one. */
function recordOf(kept: string | null): KindleSyncRecord {
  if (kept === null) return NO_KINDLE_SYNC_RECORD;
  const parsed: unknown = JSON.parse(kept);
  if (typeof parsed !== 'object' || parsed === null) return NO_KINDLE_SYNC_RECORD;
  const { connected, lastHoldAt, last } = parsed as Record<string, unknown>;
  return { connected: connected === true, lastHoldAt: timeOf(lastHoldAt), last: lastOf(last) };
}

/**
 * Where this Mac keeps Kindle sync's record (#508): whether it is connected,
 * when Amazon last held syncs back, and how the last sync ended. It is the
 * app's, not the vault's: the session is this Mac's, and the vault syncs.
 *
 * Every access is guarded: the accessor throws where site data is blocked,
 * and a kept record may have been edited by hand. Either way it reads as
 * none: nothing syncs by itself until the person connects again, which is
 * the safe way to be wrong.
 */
export const browserKindleRecords: KindleSyncRecords = {
  read: () => {
    try {
      return recordOf(window.localStorage.getItem(KEY));
    } catch {
      return NO_KINDLE_SYNC_RECORD;
    }
  },
  write: (record) => {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(record));
    } catch {
      // Safe to ignore: the record reads as before, so at worst a hold is forgotten or a sync repeated.
    }
  },
};
