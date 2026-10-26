import type { BlockSyncFields } from '@dfai/domain';
import type { BlockSyncRecord, BlockSyncRecords } from '@dfai/application';

const PREFIX = 'atlas.block-sync:';

const NONE: BlockSyncRecord = { calendarId: null, syncToken: null, agreed: {}, lastSyncAt: null };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

function fieldsOf(value: unknown): BlockSyncFields | null {
  if (!isRecord(value)) return null;
  const { title, start, end } = value;
  if (typeof title !== 'string' || text(start) === null || text(end) === null) return null;
  return { title, start: String(start), end: String(end) };
}

/** A record as kept, each agreed block read on its own; none when what is kept is not one. */
function recordOf(kept: string | null): BlockSyncRecord {
  if (kept === null) return NONE;
  const parsed: unknown = JSON.parse(kept);
  if (!isRecord(parsed)) return NONE;
  const agreed = Object.entries(isRecord(parsed['agreed']) ? parsed['agreed'] : {}).flatMap(
    ([id, value]) => {
      const fields = fieldsOf(value);
      return fields === null ? [] : [[id, fields] as const];
    },
  );
  const lastSyncAt = parsed['lastSyncAt'];
  return {
    calendarId: text(parsed['calendarId']),
    syncToken: text(parsed['syncToken']),
    agreed: Object.fromEntries(agreed),
    lastSyncAt: typeof lastSyncAt === 'number' && Number.isFinite(lastSyncAt) ? lastSyncAt : null,
  };
}

/**
 * Where this Mac's block syncs of each vault left off (#30), in the app's own
 * storage, as meetings' are (ADR-0046): the token and what both sides last
 * agreed on are this Mac's, and keeping them in the vault would be a write on
 * every sync and a conflict between Macs.
 *
 * Every access is guarded. A record that cannot be read reads as none, which
 * costs one full listing of the calendar; with no agreed values, a change
 * made in DFAI waits for that listing rather than being guessed at.
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
