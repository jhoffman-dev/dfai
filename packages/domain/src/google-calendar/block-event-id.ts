/**
 * The ids a block sync puts in a URL (#30, ADR-0030): the event id it picks
 * for a block, and the checks every id read from a block or the vault's
 * settings passes before it reaches one.
 */

import { passageDigest } from '../embeddings/passage-digest.ts';

/** Google's alphabet for an event id a client picks: base32hex, lower case, 5 to 1024 long. */
const EVENT_ID = /^[a-v0-9]{5,1024}$/;

/**
 * A calendar a block may go to: one Google made for an account, which is
 * always `name@domain`. Nothing with a `/`, a `?` or a lone dot gets through,
 * so no id can move a call off that calendar's events.
 */
const CALENDAR_ID = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

/** Whether `id` is one Google accepts for an event a client names. */
export function isGoogleEventId(id: string): boolean {
  return EVENT_ID.test(id);
}

/** Whether `id` names a calendar blocks may be written to. */
export function isBlockCalendarId(id: string): boolean {
  return CALENDAR_ID.test(id);
}

/** How many ids one block may be offered before the sync gives up on it. */
export const BLOCK_EVENT_ID_ATTEMPTS = 4;

/**
 * The event id a block is given at its first push: drawn from the calendar
 * it goes to, which the vault's settings name on every Mac, and the note's
 * path then. Two Macs that both push a new block in one tick (git has not
 * carried the first one's id yet) send the same id, so Google answers the
 * second with 409 and it patches the one event. `attempt` moves on past an
 * id another note already carries, or one Google deleted. Not a secret and
 * not a security hash: it only has to be the same everywhere and unlikely
 * to meet another block's.
 */
export function blockEventId({
  calendarId,
  path,
  attempt,
}: {
  calendarId: string;
  path: string;
  attempt: number;
}): string {
  const seed = `${calendarId}\n${path}\n${attempt}`;
  // Two 64-bit digests of differently salted text: 128 bits, all in hex, which is inside base32hex.
  return `dfai${passageDigest(`a${seed}`)}${passageDigest(`b${seed}`)}`;
}
