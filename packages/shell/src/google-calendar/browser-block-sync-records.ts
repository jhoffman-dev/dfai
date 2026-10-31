import type { BlockSyncRecord, BlockSyncRecords } from '@dfai/application';

const PREFIX = 'atlas.block-sync:';

const NONE: BlockSyncRecord = {
  calendarId: null,
  syncToken: null,
  lastSyncAt: null,
  timeZone: null,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

/** A record as kept; none when what is kept is not one. Anything else it holds is left unread. */
function recordOf(kept: string | null): BlockSyncRecord {
  if (kept === null) return NONE;
  const parsed: unknown = JSON.parse(kept);
  if (!isRecord(parsed)) return NONE;
  const lastSyncAt = parsed['lastSyncAt'];
  return {
    calendarId: text(parsed['calendarId']),
    syncToken: text(parsed['syncToken']),
    lastSyncAt: typeof lastSyncAt === 'number' && Number.isFinite(lastSyncAt) ? lastSyncAt : null,
    timeZone: text(parsed['timeZone']),
  };
}

/**
 * Where this Mac's block syncs of each vault left off (#30), in the app's own
 * storage, as meetings' are (ADR-0046): only a cache of the sync token, which
 * is this Mac's own, and of the zone its last sync read blocks on. What both sides last agreed on is on the blocks
 * (`gcal_synced_*`), so a Mac with no record here still knows it.
 *
 * Every access is guarded. A record that cannot be read reads as none, which
 * costs one full listing of the calendar and nothing else.
 */
export const browserBlockSyncRecords: BlockSyncRecords = {
  read: (vault) => {
    try {
      return recordOf(window.localStorage.getItem(`${PREFIX}${vault}`));
    } catch {
      return NONE;
    }
  },
  write: (vault, record) => {
    try {
      window.localStorage.setItem(`${PREFIX}${vault}`, JSON.stringify(record));
    } catch {
      // Safe to ignore: the next sync lists the calendar in full, which only repeats work.
    }
  },
};
