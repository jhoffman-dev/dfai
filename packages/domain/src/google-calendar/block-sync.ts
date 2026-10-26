/**
 * Two-way sync of blocks with the one calendar they go to (ADR-0030, #30).
 *
 * A block is a note; its event on the blocks calendar is found by the id
 * written on the block. Each side is compared with what both last agreed —
 * the `gcal_synced_*` keys on the block itself, so every Mac reads the same
 * base — and never with a version alone, since Google gives an event a new
 * version for a description or a colour as well as a move:
 *
 * - DFAI changed it, Google's times are the agreed ones → push it to Google;
 * - Google changed its times, DFAI did not → pull them into the block;
 * - both changed → Google's time is kept, and Activity says so;
 * - Google deleted it → the block is marked `gcal_missing`, never deleted.
 *
 * Only the times come back from Google. A block's title is its note's name,
 * which a sync never renames, so a title goes one way: DFAI to Google.
 *
 * Two notes carrying one event id (a copied note) keep one event: the
 * original keeps it, and every copy is a new block with its own event.
 */

import { minutesBetween, readEventTime } from '../calendar/calendar-event.ts';
import { BLOCK_KEYS } from '../timeblocks/block-type.ts';
import { addDays } from '../timeline/timeline.ts';
import { isGoogleEventId } from './block-event-id.ts';
import { planZone } from './event-notes.ts';
import type { EventWhen } from './google-event.ts';
import { PRIMARY_CALENDAR } from './meeting-setting.ts';
import { wallStart, zoneOffsetMinutes } from './meeting-window.ts';

/** The properties a block sync writes on a block, and owns. Nothing else on it is touched. */
export const BLOCK_SYNC_KEYS = {
  eventId: BLOCK_KEYS.gcalEventId,
  etag: BLOCK_KEYS.gcalEtag,
  calendar: BLOCK_KEYS.gcalCalendar,
  /** Set once Google says the event was deleted; the block is never removed. */
  missing: BLOCK_KEYS.gcalMissing,
  /** What both sides last agreed the block was: written before a push is sent, and on every pull. */
  syncedTitle: BLOCK_KEYS.gcalSyncedTitle,
  syncedStart: BLOCK_KEYS.gcalSyncedStart,
  syncedEnd: BLOCK_KEYS.gcalSyncedEnd,
  /**
   * Set with the agreed record before a push is sent, cleared when Google
   * answers. `gcal_etag` keeps the last version Google confirmed meanwhile, so
   * a listing of that version says the push never landed.
   */
  pending: BLOCK_KEYS.gcalPending,
} as const;

/** How far back a sync looks for blocks to push: older ones are history, and stay off Google. */
export const BLOCK_SYNC_DAYS_BEFORE = 14;

/** What sync compares on both sides, on the wall clock (`2026-10-12T09:00`, or a day). */
export interface BlockSyncFields {
  readonly title: string;
  readonly start: string;
  readonly end: string;
}

type Times = Pick<BlockSyncFields, 'start' | 'end'>;

/** A block as its file says now. */
export interface BlockOnDisk {
  readonly path: string;
  /** Its note's name: the title its event is given. */
  readonly title: string;
  /** Its start and end as wall-clock text, or null when either is not a date. */
  readonly start: string | null;
  readonly end: string | null;
  /** Its event's id; null when it has none, or one Google could never have given. */
  readonly eventId: string | null;
  readonly etag: string | null;
  readonly calendarId: string | null;
  readonly missing: boolean;
  /** A push was sent and Google has not answered it: `synced` is what was sent, `etag` what Google last confirmed. */
  readonly pending: boolean;
  /** What both sides last agreed (`gcal_synced_*`); null when the block holds no whole record of it. */
  readonly synced: BlockSyncFields | null;
}

/** An event on the blocks calendar, as a listing gave it. */
export interface BlockEvent {
  readonly id: string;
  /** The version Google gave this copy of it. */
  readonly etag: string | null;
  readonly cancelled: boolean;
  readonly title: string;
  readonly start: EventWhen | null;
  readonly end: EventWhen | null;
  /** The note DFAI last wrote it for, kept on the event; absent on one DFAI has not written since. */
  readonly notePath?: string | null;
}

export type BlockAction =
  /**
   * Make its event. With no id, one is written onto the block first, so a
   * retry never makes two; `copyOf` names the event a copied note carried,
   * which it gives up for its own.
   */
  | {
      readonly kind: 'insert';
      readonly path: string;
      readonly eventId: string | null;
      readonly fields: BlockSyncFields;
      readonly copyOf: string | null;
    }
  /** DFAI changed the block, or Google's title strayed: give its event the block's title and times. */
  | {
      readonly kind: 'patch';
      readonly path: string;
      readonly eventId: string;
      readonly fields: BlockSyncFields;
    }
  /**
   * Google changed the event: write its times onto the block, as agreed.
   * `conflict` when DFAI had changed the block too; `returned` when the
   * event came back after being marked missing; `retitle` when the event's
   * title is not the block's, so the same run puts the block's back.
   */
  | {
      readonly kind: 'pull';
      readonly path: string;
      readonly eventId: string;
      readonly etag: string | null;
      readonly fields: BlockSyncFields;
      readonly conflict: boolean;
      readonly returned: boolean;
      readonly retitle: boolean;
    }
  /** Both sides hold the same block: write only the version, or the agreed record, that is new (null: as it is). */
  | {
      readonly kind: 'adopt';
      readonly path: string;
      readonly eventId: string;
      readonly etag: string | null;
      readonly synced: BlockSyncFields | null;
    }
  /** Google deleted the event. */
  | { readonly kind: 'missing'; readonly path: string; readonly eventId: string }
  /** A block with no time at both ends, or ending no later than it starts: nothing to push. */
  | { readonly kind: 'unplaced'; readonly path: string }
  /** A copy of another block with nothing to push now: its sync keys are cleared, so it is a new block. */
  | { readonly kind: 'detach'; readonly path: string; readonly eventId: string };

export interface ReconcileBlocksInput {
  readonly blocks: readonly BlockOnDisk[];
  /** What the blocks calendar listed: everything on it, or what changed since the last sync. */
  readonly events: readonly BlockEvent[];
  /** Whether `events` is everything on the calendar, so an event not in it has gone. */
  readonly listedInFull: boolean;
  /** The calendar blocks go to now. A block another calendar holds is left alone. */
  readonly calendarId: string;
  /** The plan zone (ADR-0046): what a block's wall clock means, and what Google's times are read on. */
  readonly timeZone: string;
  /** The first day a sync pushes: a copy of an older block is cleared, not put on Google. */
  readonly fromDay: string;
}

export interface ReconcileBlocksPlan {
  readonly actions: readonly BlockAction[];
}

/**
 * The zone a block's wall clock means: meetings' plan zone (ADR-0046), from
 * the primary calendar's zone when Google gave it, else the Mac's. The blocks
 * calendar's own zone plays no part, so a block and a meeting at 09:00 on the
 * Today list are at one 09:00.
 */
export function blockPlanZone({
  primaryZone,
  timeZone,
}: {
  primaryZone: string | null;
  timeZone: string;
}): string {
  const calendarZones = primaryZone === null ? {} : { [PRIMARY_CALENDAR]: primaryZone };
  return planZone({ calendarZones, timeZone });
}

/** The plan zone moved since this Mac's last sync: blocks' wall clocks now mean another zone. */
export interface BlockZoneChange {
  readonly from: string;
  readonly to: string;
  /** How far a block's times on this Mac move, in minutes: Google's instants read on the new zone. */
  readonly shiftMinutes: number;
}

/** The change from the zone the last sync used to this one's; null when there was none, or it is the same. */
export function blockZoneChange({
  from,
  to,
  at,
}: {
  from: string | null;
  to: string;
  at: number;
}): BlockZoneChange | null {
  if (from === null || from === to) return null;
  return {
    from,
    to,
    shiftMinutes: zoneOffsetMinutes(to, at) - zoneOffsetMinutes(from, at),
  };
}

/** A date property as wall-clock text, written the one way sync compares it; null when it is not one. */
export function wallClockText(value: unknown): string | null {
  const time = readEventTime(value);
  if (time === null) return null;
  if (time.minutes === null) return time.date;
  const hours = String(Math.floor(time.minutes / 60)).padStart(2, '0');
  const minutes = String(time.minutes % 60).padStart(2, '0');
  return `${time.date}T${hours}:${minutes}`;
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/** The agreed record on a block, when all of it is there. */
function syncedOf(properties: Readonly<Record<string, unknown>>): BlockSyncFields | null {
  const title = properties[BLOCK_SYNC_KEYS.syncedTitle];
  const start = wallClockText(properties[BLOCK_SYNC_KEYS.syncedStart]);
  const end = wallClockText(properties[BLOCK_SYNC_KEYS.syncedEnd]);
  if (typeof title !== 'string' || start === null || end === null) return null;
  return { title, start, end };
}

/** A block's sync state, read from its frontmatter. */
export function blockOnDisk({
  path,
  title,
  properties,
}: {
  path: string;
  title: string;
  properties: Readonly<Record<string, unknown>>;
}): BlockOnDisk {
  const eventId = text(properties[BLOCK_SYNC_KEYS.eventId]);
  return {
    path,
    title,
    start: wallClockText(properties[BLOCK_KEYS.start]),
    end: wallClockText(properties[BLOCK_KEYS.end]),
    eventId: eventId !== null && isGoogleEventId(eventId) ? eventId : null,
    etag: text(properties[BLOCK_SYNC_KEYS.etag]),
    calendarId: text(properties[BLOCK_SYNC_KEYS.calendar]),
    missing: properties[BLOCK_SYNC_KEYS.missing] === true,
    pending: properties[BLOCK_SYNC_KEYS.pending] === true,
    synced: syncedOf(properties),
  };
}

/** A block's title and times, when both ends are times and it ends after it starts. */
export function pushableFields(
  block: Pick<BlockOnDisk, 'title' | 'start' | 'end'>,
): BlockSyncFields | null {
  const start = readEventTime(block.start);
  const end = readEventTime(block.end);
  if (start === null || end === null || start.minutes === null || end.minutes === null) return null;
  if (minutesBetween(start, end) <= 0) return null;
  return { title: block.title, start: block.start ?? '', end: block.end ?? '' };
}

/**
 * An event's times on the plan zone's wall clock. Google ends an all-day
 * event on the day after its last; a block names its last day. Null when
 * either end cannot be read, so the block is left as it is.
 */
export function eventTimes(event: BlockEvent, timeZone: string): Times | null {
  if (event.start === null || event.end === null) return null;
  const start = wallStart(event.start, timeZone);
  if (event.end.kind === 'timed') return { start, end: wallStart(event.end, timeZone) };
  const last = addDays(event.end.date, -1);
  return { start, end: last === null || last < start ? start : last };
}

const sameTimes = (left: Times | null, right: Times | null) =>
  left !== null && right !== null && left.start === right.start && left.end === right.end;

const sameFields = (left: BlockSyncFields | null, right: BlockSyncFields | null) =>
  sameTimes(left, right) && left?.title === right?.title;

/** The block's own values, pushable or not: what both sides are compared with. */
const heldFields = (block: BlockOnDisk): BlockSyncFields | null =>
  block.start === null || block.end === null
    ? null
    : { title: block.title, start: block.start, end: block.end };

type Plan = { readonly actions: BlockAction[] };

type Context = ReconcileBlocksInput & { readonly byId: ReadonlyMap<string, BlockEvent> };

type Identified = BlockOnDisk & { readonly eventId: string };

/** The event says it was last written for another note: the block was moved or renamed since. */
const strayed = (event: BlockEvent, block: BlockOnDisk) =>
  typeof event.notePath === 'string' && event.notePath !== block.path;

/** Pushes the block as it is, or says it has nothing to push. */
function planPatch(block: Identified, plan: Plan): void {
  const fields = pushableFields(block);
  if (fields === null) plan.actions.push({ kind: 'unplaced', path: block.path });
  else plan.actions.push({ kind: 'patch', path: block.path, eventId: block.eventId, fields });
}

/** A block with no event yet, or one whose id was written but whose event may not have been made. */
function planUnmade(block: BlockOnDisk, plan: Plan): void {
  const fields = pushableFields(block);
  if (fields === null) plan.actions.push({ kind: 'unplaced', path: block.path });
  else
    plan.actions.push({
      kind: 'insert',
      path: block.path,
      eventId: block.eventId,
      fields,
      copyOf: null,
    });
}

/** Both sides hold the block's values: write whatever of the version and the agreed record is new. */
function planAdopt(block: Identified, event: BlockEvent, times: Times, plan: Plan): void {
  const agreed = { title: block.title, ...times };
  // A version Google gives as null is never written: it would read as an insert not yet made.
  const etag = event.etag !== null && event.etag !== block.etag ? event.etag : null;
  const synced = sameFields(block.synced, agreed) ? null : agreed;
  // A pending mark is cleared by the adopt itself, so one is written for it alone.
  if (etag === null && synced === null && !block.pending) return;
  plan.actions.push({ kind: 'adopt', path: block.path, eventId: block.eventId, etag, synced });
}

/**
 * Whether the block's record may not be on Google: a push was sent and not
 * answered, or no version was ever confirmed. Then Google's times differing
 * from the record cannot be told from a move in Google.
 */
const unconfirmed = (block: BlockOnDisk) => block.pending || block.etag === null;

/** Google lists the very version the block last had confirmed: nothing changed there since, so the push never landed. */
const unchangedSincePending = (block: BlockOnDisk, event: BlockEvent) =>
  block.pending && event.etag !== null && event.etag === block.etag;

/** Google's times, read off its event: compared with the agreed record, else with the block's own. */
function planListed(block: Identified, event: BlockEvent, times: Times, plan: Plan): void {
  if (unchangedSincePending(block, event)) {
    planPatch(block, plan);
    return;
  }
  const held = heldFields(block);
  const titled = event.title === block.title && !strayed(event, block);
  if (sameTimes(block.synced ?? held, times)) {
    // Google did not move it — whatever else changed there — so DFAI's values go to Google.
    if (sameTimes(held, times) && titled) planAdopt(block, event, times, plan);
    else planPatch(block, plan);
    return;
  }
  if (sameTimes(held, times)) {
    // Both moved it to the same place: agreed, bar a title to put back.
    if (titled) planAdopt(block, event, times, plan);
    else planPatch(block, plan);
    return;
  }
  plan.actions.push({
    kind: 'pull',
    path: block.path,
    eventId: block.eventId,
    etag: event.etag,
    fields: { title: block.title, ...times },
    // With no agreed record, or one Google may never have had, who moved it cannot be told:
    // Google's time is kept, and said.
    conflict: block.synced === null || unconfirmed(block) || !sameTimes(held, block.synced),
    returned: false,
    retitle: !titled,
  });
}

/** Google did not list the event, so it holds what was last agreed: push what DFAI changed since. */
function planUnlisted(block: Identified, plan: Plan): void {
  // A push sent and not answered: Google may not hold it, so it is sent again.
  if (block.pending) {
    planPatch(block, plan);
    return;
  }
  // Nothing agreed to compare with: wait for Google to list the event.
  if (block.synced === null || sameFields(heldFields(block), block.synced)) return;
  planPatch(block, plan);
}

/** A block whose event was made: follow what each side did since they last agreed. */
function planMade(block: Identified, context: Context, plan: Plan): void {
  const event = context.byId.get(block.eventId);
  if (event?.cancelled === true || (event === undefined && context.listedInFull)) {
    plan.actions.push({ kind: 'missing', path: block.path, eventId: block.eventId });
    return;
  }
  if (event === undefined) {
    planUnlisted(block, plan);
    return;
  }
  const times = eventTimes(event, context.timeZone);
  if (times !== null) planListed(block, event, times, plan);
}

/** A block marked missing: left alone, unless its event is back on the calendar. */
function planMissing(block: Identified, context: Context, plan: Plan): void {
  const event = context.byId.get(block.eventId);
  const times = event === undefined || event.cancelled ? null : eventTimes(event, context.timeZone);
  if (event === undefined || times === null) return;
  plan.actions.push({
    kind: 'pull',
    path: block.path,
    eventId: block.eventId,
    etag: event.etag,
    fields: { title: block.title, ...times },
    conflict: false,
    returned: true,
    retitle: event.title !== block.title || strayed(event, block),
  });
}

function planBlock(block: BlockOnDisk, context: Context, plan: Plan): void {
  const { eventId } = block;
  if (eventId === null) {
    if (!block.missing) planUnmade(block, plan);
    return;
  }
  const identified = { ...block, eventId };
  if (block.missing) planMissing(identified, context, plan);
  // An id but no version, and Google lists no such event: the insert may never have landed.
  else if (block.etag === null && !context.byId.has(eventId)) planUnmade(block, plan);
  else planMade(identified, context, plan);
}

/**
 * A name Finder gives a copy (`… copy`, `… copy 2`) or the vault gives the
 * next free name (`… 2`). Only a tie-break: a note so named is never taken
 * for the original over one that is not.
 */
const COPY_NAME = / (?:copy(?: \d+)?|\d+)$/i;

/**
 * Which of the notes carrying one event id is the one the event is for: the
 * note the event says it was written for; else, among the notes not named
 * like a copy (all of them when every one is), one on the event's times;
 * else one unchanged since it was agreed; else the first by path.
 */
function originalOf(copies: readonly BlockOnDisk[], event: BlockEvent | undefined, zone: string) {
  const named = copies.find((copy) => event?.notePath === copy.path);
  if (named !== undefined) return named.path;
  const plain = copies.filter((copy) => !COPY_NAME.test(copy.title));
  const pool = plain.length > 0 ? plain : copies;
  const times = event === undefined || event.cancelled ? null : eventTimes(event, zone);
  const chosen =
    pool.find((copy) => sameTimes(heldFields(copy), times)) ??
    pool.find((copy) => copy.synced !== null && sameTimes(heldFields(copy), copy.synced)) ??
    pool[0];
  return chosen?.path ?? null;
}

/** A copy of another block: a new block, given its own event when it has one to push. */
function planCopy(block: Identified, context: Context, plan: Plan): void {
  const fields = pushableFields(block);
  if (fields !== null && fields.start.slice(0, 10) >= context.fromDay) {
    plan.actions.push({
      kind: 'insert',
      path: block.path,
      eventId: null,
      fields,
      copyOf: block.eventId,
    });
    return;
  }
  plan.actions.push({ kind: 'detach', path: block.path, eventId: block.eventId });
}

/** The original note for each event id two or more blocks carry. */
function originals(blocks: readonly BlockOnDisk[], context: Context): Map<string, string | null> {
  const carriers = new Map<string, BlockOnDisk[]>();
  for (const block of blocks) {
    if (block.eventId === null) continue;
    carriers.set(block.eventId, [...(carriers.get(block.eventId) ?? []), block]);
  }
  const chosen = new Map<string, string | null>();
  for (const [eventId, copies] of carriers) {
    if (copies.length < 2) continue;
    chosen.set(eventId, originalOf(copies, context.byId.get(eventId), context.timeZone));
  }
  return chosen;
}

/**
 * What a block sync does: one action per block that needs one, in the order
 * of the blocks' paths. Pure: the same blocks and events give the same plan
 * on every Mac, because what was agreed is read from the blocks themselves.
 */
export function reconcileBlocks(input: ReconcileBlocksInput): ReconcileBlocksPlan {
  const byId = new Map(input.events.map((event) => [event.id, event]));
  const context: Context = { ...input, byId };
  const plan: Plan = { actions: [] };
  const ours = [...input.blocks]
    .filter((block) => block.calendarId === null || block.calendarId === input.calendarId)
    .sort((left, right) => (left.path < right.path ? -1 : 1));
  const chosen = originals(ours, context);
  for (const block of ours) {
    const original = block.eventId === null ? undefined : chosen.get(block.eventId);
    if (block.eventId !== null && original !== undefined && original !== block.path) {
      planCopy({ ...block, eventId: block.eventId }, context, plan);
    } else {
      planBlock(block, context, plan);
    }
  }
  return plan;
}
