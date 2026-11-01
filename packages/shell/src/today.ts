import type { Clock } from '@dfai/application';

/**
 * Today, as `2026-09-20`, in the timezone the person is in.
 *
 * `toISOString` would give today in UTC, which is tomorrow for a good part of
 * every evening west of Greenwich. The index answers `@today` with SQLite's
 * `date('now', 'localtime')`, so a today-line drawn from UTC and a `due is
 * @today` filter would disagree by a day. `en-CA` formats as `YYYY-MM-DD`.
 */
export function localToday(): string {
  return new Date().toLocaleDateString('en-CA');
}

/** The clock whatever the app writes on a date reads: today, where the person is. */
export const localClock: Clock = { today: localToday, now: epochNow, localNow };

/**
 * Now, as `2026-09-25T14:30:12`, in the person's own timezone — what a pasted
 * image is named by. `sv-SE` formats a date and a time that way, with a space
 * where ISO puts the `T`.
 */
export function localNow(): string {
  return new Date().toLocaleString('sv-SE', { hour12: false }).replace(' ', 'T');
}

/** The IANA zone the person's Mac keeps time in, as `America/Los_Angeles`. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Now, in milliseconds since the epoch — the clock the host dates files by. */
export function epochNow(): number {
  return Date.now();
}

/** The day, as `2026-09-20`, that a time the host dates a file by falls on where the person is. */
export function localDayOf(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString('en-CA');
}
