/**
 * Two-way sync of blocks with the one calendar they go to (ADR-0030, #30).
 *
 * A block is a note; its event on the blocks calendar is found by the id
 * written on the block. What each side holds is compared with what both held
 * when they last agreed (`lastSync`), and with the version Google last gave
 * the block (`gcal_etag`):
 *
 * - DFAI changed it, Google did not → push it to Google;
 * - Google changed it, DFAI did not → pull its times into the block;
 * - both changed → Google's time is kept, and Activity says so;
 * - Google deleted it → the block is marked `gcal_missing`, never deleted.
 *
 * Only the times come back from Google. A block's title is its note's name,
 * which a sync never renames, so a title goes one way: DFAI to Google.
 */

import { minutesBetween, readEventTime } from '../calendar/calendar-event.ts';
import { BLOCK_KEYS } from '../timeblocks/block-type.ts';
import { addDays } from '../timeline/timeline.ts';
import type { EventWhen } from './google-event.ts';
import { wallStart } from './meeting-window.ts';

/** The properties a block sync writes on a block, and owns. Nothing else on it is touched. */
export const BLOCK_SYNC_KEYS = {
  eventId: BLOCK_KEYS.gcalEventId,
  etag: BLOCK_KEYS.gcalEtag,
  calendar: BLOCK_KEYS.gcalCalendar,
  /** Set once Google says the event was deleted; the block is never removed. */
  missing: BLOCK_KEYS.gcalMissing,
} as const;

/** How far back a sync looks for blocks to push: older ones are history, and stay off Google. */
export const BLOCK_SYNC_DAYS_BEFORE = 14;

/** What sync compares on both sides, on the wall clock (`2026-10-12T09:00`, or a day). */
export interface BlockSyncFields {
  readonly title: string;
  readonly start: string;
  readonly end: string;
}

/** A block as its file says now. */
export interface BlockOnDisk {
  readonly path: string;
  /** Its note's name: the title its event is given. */
  readonly title: string;
  /** Its start and end as wall-clock text, or null when either is not a date. */
  readonly start: string | null;
  readonly end: string | null;
  readonly eventId: string | null;
  readonly etag: string | null;
  readonly calendarId: string | null;
  readonly missing: boolean;
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
}

export type BlockAction =
  /** Make its event. With no id, one is written onto the block first, so a retry never makes two. */
  | {
      readonly kind: 'insert';
      readonly path: string;
      readonly eventId: string | null;
      readonly fields: BlockSyncFields;
    }
  /** DFAI changed the block: give its event the block's title and times. */
  | {
      readonly kind: 'patch';
      readonly path: string;
      readonly eventId: string;
      readonly fields: BlockSyncFields;
    }
  /**
   * Google changed the event: write its times and version onto the block.
   * `conflict` when DFAI had changed the block too; `returned` when the
   * event came back after being marked missing.
   */
  | {
      readonly kind: 'pull';
      readonly path: string;
      readonly eventId: string;
      readonly etag: string | null;
      readonly fields: BlockSyncFields;
      readonly conflict: boolean;
      readonly returned: boolean;
    }
  /** The event has a new version with the block's own times: only its version is written. */
  | {
      readonly kind: 'adopt';
      readonly path: string;
      readonly eventId: string;
      readonly etag: string | null;
      readonly fields: BlockSyncFields;
    }
  /** Google deleted the event. */
  | { readonly kind: 'missing'; readonly path: string; readonly eventId: string }
  /** A block with no time at both ends, or ending no later than it starts: nothing to push. */
  | { readonly kind: 'unplaced'; readonly path: string }
  /** A second block carrying an event id an earlier one has: left alone, so one event has one block. */
  | { readonly kind: 'duplicate'; readonly path: string; readonly eventId: string };

export interface ReconcileBlocksInput {
  readonly blocks: readonly BlockOnDisk[];
  /** What the blocks calendar listed: everything on it, or what changed since the last sync. */
  readonly events: readonly BlockEvent[];
  /** Whether `events` is everything on the calendar, so an event not in it has gone. */
  readonly listedInFull: boolean;
  /** What both sides held, by event id, when they last agreed. Empty on a Mac that has not synced. */
  readonly lastSync: Readonly<Record<string, BlockSyncFields>>;
  /** The calendar blocks go to now. A block another calendar holds is left alone. */
  readonly calendarId: string;
  /** The calendar's own zone, which Google's times are read on. */
  readonly timeZone: string;
}

export interface ReconcileBlocksPlan {
  readonly actions: readonly BlockAction[];
  /** Blocks needing no write whose agreed values this sync learnt, by event id. */
  readonly agreed: Readonly<Record<string, BlockSyncFields>>;
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
  return {
    path,
    title,
    start: wallClockText(properties[BLOCK_KEYS.start]),
    end: wallClockText(properties[BLOCK_KEYS.end]),
    eventId: text(properties[BLOCK_SYNC_KEYS.eventId]),
    etag: text(properties[BLOCK_SYNC_KEYS.etag]),
    calendarId: text(properties[BLOCK_SYNC_KEYS.calendar]),
    missing: properties[BLOCK_SYNC_KEYS.missing] === true,
  };
}

/** A block's title and times, when both ends are times and it ends after it starts. */
export function pushableFields(block: BlockOnDisk): BlockSyncFields | null {
  const start = readEventTime(block.start);
  const end = readEventTime(block.end);
  if (start === null || end === null || start.minutes === null || end.minutes === null) return null;
  if (minutesBetween(start, end) <= 0) return null;
  return { title: block.title, start: block.start ?? '', end: block.end ?? '' };
}

/**
 * An event's times on the calendar's wall clock. Google ends an all-day
 * event on the day after its last; a block names its last day. Null when
 * either end cannot be read, so the block is left as it is.
 */
export function eventTimes(
  event: BlockEvent,
  timeZone: string,
): { start: string; end: string } | null {
  if (event.start === null || event.end === null) return null;
  const start = wallStart(event.start, timeZone);
  if (event.end.kind === 'timed') return { start, end: wallStart(event.end, timeZone) };
  const last = addDays(event.end.date, -1);
  return { start, end: last === null || last < start ? start : last };
}

const sameTimes = (left: BlockSyncFields | null, right: { start: string; end: string } | null) =>
  left !== null && right !== null && left.start === right.start && left.end === right.end;

const sameFields = (left: BlockSyncFields | null, right: BlockSyncFields | null) =>
  sameTimes(left, right) && left?.title === right?.title;

/** The block's own values, pushable or not: what a pull compares against. */
const heldFields = (block: BlockOnDisk): BlockSyncFields | null =>
  block.start === null || block.end === null
    ? null
    : { title: block.title, start: block.start, end: block.end };

interface Plan {
  readonly actions: BlockAction[];
  readonly agreed: Record<string, BlockSyncFields>;
}

type Context = ReconcileBlocksInput & { readonly byId: ReadonlyMap<string, BlockEvent> };

/** A block with no event yet, or one whose id was written but whose event may not have been made. */
function planUnmade(block: BlockOnDisk, plan: Plan): void {
  const fields = pushableFields(block);
  if (fields === null) {
    plan.actions.push({ kind: 'unplaced', path: block.path });
    return;
  }
  plan.actions.push({ kind: 'insert', path: block.path, eventId: block.eventId, fields });
}

/** Google's copy changed since the block's version: pull it, or take only its version when the times agree. */
function planChanged(
  block: BlockOnDisk & { eventId: string },
  event: BlockEvent,
  context: Context,
  plan: Plan,
): void {
  const times = eventTimes(event, context.timeZone);
  const held = heldFields(block);
  if (times === null) return;
  if (sameTimes(held, times)) {
    // Titles go one way: a rename in Google is put back to the block's name.
    const fields = pushableFields(block);
    if (event.title !== block.title && fields !== null) {
      plan.actions.push({ kind: 'patch', path: block.path, eventId: block.eventId, fields });
      return;
    }
    plan.actions.push({
      kind: 'adopt',
      path: block.path,
      eventId: block.eventId,
      etag: event.etag,
      fields: { title: block.title, ...times },
    });
    return;
  }
  const last = context.lastSync[block.eventId] ?? null;
  plan.actions.push({
    kind: 'pull',
    path: block.path,
    eventId: block.eventId,
    etag: event.etag,
    fields: { title: block.title, ...times },
    conflict: last !== null && !sameTimes(held, last),
    returned: false,
  });
}

/** Google's copy is the version the block holds, or was not listed: push what DFAI changed since. */
function planUnchanged(
  block: BlockOnDisk & { eventId: string },
  compareWith: BlockSyncFields | null,
  plan: Plan,
): void {
  const fields = pushableFields(block);
  if (compareWith === null) return;
  if (sameFields(heldFields(block), compareWith)) {
    plan.agreed[block.eventId] = compareWith;
    return;
  }
  if (fields === null) plan.actions.push({ kind: 'unplaced', path: block.path });
  else plan.actions.push({ kind: 'patch', path: block.path, eventId: block.eventId, fields });
}

const eventFields = (event: BlockEvent, timeZone: string): BlockSyncFields | null => {
  const times = eventTimes(event, timeZone);
  return times === null ? null : { title: event.title, ...times };
};

/** A block whose event was made: follow what each side did since they last agreed. */
function planMade(block: BlockOnDisk & { eventId: string }, context: Context, plan: Plan): void {
  const event = context.byId.get(block.eventId);
  if (event?.cancelled === true || (event === undefined && context.listedInFull)) {
    plan.actions.push({ kind: 'missing', path: block.path, eventId: block.eventId });
    return;
  }
  if (event === undefined) {
    planUnchanged(block, context.lastSync[block.eventId] ?? null, plan);
    return;
  }
  if (event.etag !== null && event.etag === block.etag) {
    planUnchanged(block, eventFields(event, context.timeZone), plan);
    return;
  }
  planChanged(block, event, context, plan);
}

/** A block marked missing: left alone, unless its event is back on the calendar. */
function planMissing(block: BlockOnDisk & { eventId: string }, context: Context, plan: Plan): void {
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
  });
}

function planBlock(block: BlockOnDisk, context: Context, plan: Plan): void {
  if (block.calendarId !== null && block.calendarId !== context.calendarId) return;
  const { eventId } = block;
  if (eventId === null) {
    if (!block.missing) planUnmade(block, plan);
    return;
  }
  const identified = { ...block, eventId };
  if (block.missing) planMissing(identified, context, plan);
  else if (block.etag === null && !context.byId.has(eventId)) planUnmade(block, plan);
  else planMade(identified, context, plan);
}

/**
 * What a block sync does: one action per block that needs one, in the order
 * of the blocks' paths. Pure: the same blocks, events and last sync give the
 * same plan on every Mac.
 */
export function reconcileBlocks(input: ReconcileBlocksInput): ReconcileBlocksPlan {
  const byId = new Map(input.events.map((event) => [event.id, event]));
  const context: Context = { ...input, byId };
  const plan: Plan = { actions: [], agreed: {} };
  const seen = new Set<string>();
  const blocks = [...input.blocks].sort((left, right) => (left.path < right.path ? -1 : 1));
  for (const block of blocks) {
    if (block.eventId !== null && seen.has(block.eventId)) {
      plan.actions.push({ kind: 'duplicate', path: block.path, eventId: block.eventId });
      continue;
    }
    if (block.eventId !== null) seen.add(block.eventId);
    planBlock(block, context, plan);
  }
  return plan;
}

/** Google's alphabet for an event id a client picks: base32hex, lower case. */
const EVENT_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuv';

/** Long enough that two blocks never draw the same one. */
const EVENT_ID_RANDOM_LENGTH = 26;

/**
 * A new event id for a block, written on the block before its event is
 * made, so an insert tried again after a failure is the same event, not a
 * second one. `random` gives numbers in [0, 1).
 */
export function newBlockEventId(random: () => number): string {
  let id = 'dfai';
  for (let at = 0; at < EVENT_ID_RANDOM_LENGTH; at += 1) {
    id += EVENT_ID_ALPHABET[Math.floor(random() * EVENT_ID_ALPHABET.length)] ?? '0';
  }
  return id;
}
