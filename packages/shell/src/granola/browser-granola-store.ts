import type { GranolaPullRecord, GranolaPullRecords } from '@dfai/application';

const PREFIX = 'atlas.granola-pull:';

const NONE: GranolaPullRecord = { watermark: null, lastPullAt: null };

/** The first instant past the year 9999, which a date can be written out as. */
const PAST_THE_LAST_YEAR = Date.UTC(10_000, 0, 1);

/** A time a pull could have ended at: from 1970 to the year 9999, else none. */
const pullTimeOf = (value: unknown): number | null =>
  typeof value === 'number' && value >= 0 && value < PAST_THE_LAST_YEAR ? value : null;

/** A record as kept, or none when what is kept is not one. */
function recordOf(kept: string | null): GranolaPullRecord {
  if (kept === null) return NONE;
  const parsed: unknown = JSON.parse(kept);
  if (typeof parsed !== 'object' || parsed === null) return NONE;
  const { watermark, lastPullAt } = parsed as Record<string, unknown>;
  return {
    watermark: typeof watermark === 'string' ? watermark : null,
    lastPullAt: pullTimeOf(lastPullAt),
  };
}

/**
 * Where this Mac's Granola pulls of each vault left off, kept in the app's
 * own storage (ADR-0034): it is this Mac's, and the vault syncs, so a write on
 * every pull there would be noise in its history and a conflict between Macs.
 *
 * Every access is guarded: the accessor throws where site data is blocked,
 * and a kept record may have been edited by hand. Either way the record reads
 * as none, which costs one full listing that the dedupe makes harmless.
 */
export const browserGranolaPullRecords: GranolaPullRecords = {
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
      // Safe to ignore: the next pull lists from the record kept before, which only repeats work.
    }
  },
};
