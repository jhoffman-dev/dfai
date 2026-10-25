import type { CalendarFollowing, MeetingSyncRecord, MeetingSyncRecords } from '@dfai/application';

const PREFIX = 'atlas.meeting-sync:';

const NONE: MeetingSyncRecord = { calendars: {}, lastSyncAt: null };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function followingOf(value: unknown): CalendarFollowing | null {
  if (!isRecord(value)) return null;
  const { syncToken, fromDay } = value;
  if (typeof syncToken !== 'string' || syncToken === '') return null;
  if (typeof fromDay !== 'string' || !DAY.test(fromDay)) return null;
  return { syncToken, fromDay };
}

/** A record as kept, each calendar's part read on its own; none when what is kept is not one. */
function recordOf(kept: string | null): MeetingSyncRecord {
  if (kept === null) return NONE;
  const parsed: unknown = JSON.parse(kept);
  if (!isRecord(parsed)) return NONE;
  const calendars = isRecord(parsed['calendars']) ? parsed['calendars'] : {};
  const following = Object.entries(calendars).flatMap(([calendar, value]) => {
    const read = followingOf(value);
    return read === null ? [] : [[calendar, read] as const];
  });
  const lastSyncAt = parsed['lastSyncAt'];
  return {
    calendars: Object.fromEntries(following),
    lastSyncAt: typeof lastSyncAt === 'number' && Number.isFinite(lastSyncAt) ? lastSyncAt : null,
  };
}

/**
 * Where this Mac's meetings syncs of each vault left off (ADR-0046), in the
 * app's own storage: a sync token is this Mac's, and the vault syncs, so
 * keeping it there would be a write on every sync and a conflict between Macs.
 *
 * Every access is guarded: the accessor throws where site data is blocked,
 * and a kept record may have been edited by hand. Either way the record
 * reads as none, which costs one full listing of the window — and a full
 * listing writes nothing that is already right.
 */
export const browserMeetingSyncRecords: MeetingSyncRecords = {
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
      // Safe to ignore: the next sync lists the window in full, which only repeats work.
    }
  },
};
