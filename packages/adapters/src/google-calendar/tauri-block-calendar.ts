import { isBlockCalendarId, isGoogleEventId, isScopeRefusal, type BlockEvent } from '@dfai/domain';
import {
  GoogleCalendarError,
  type BlockCalendar,
  type BlockEventCall,
  type BlockEventChanges,
  type BlockEventWrite,
} from '@dfai/application';
import { whenOf } from './events-list.ts';
import { answered, calendarAnswer, malformed } from './tauri-google-calendar.ts';

/** Google's largest page for `events.list`, so a year of blocks is a page or two. */
const PAGE_SIZE = 2500;

/** A hundred thousand events; past it, a server looping on pages is cut off. */
const MAX_PAGES = 40;

const GONE = 410;
const NOT_FOUND = 404;
const CONFLICT = 409;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

/** The private property DFAI keeps on an event: the note it was last written for. */
const NOTE_PATH = 'dfai_note';

const invalid = (message: string) => new GoogleCalendarError({ kind: 'invalid', message });

/**
 * An id read from a block or the vault's settings, checked before it is put
 * in a URL: the host resolves `..` before sending, so an unchecked one could
 * call another resource of the API.
 */
function eventsPath(calendarId: string): string {
  if (!isBlockCalendarId(calendarId))
    throw invalid('the blocks calendar’s id is not one Google gives');
  return `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
}

function eventPath(calendarId: string, eventId: string): string {
  if (!isGoogleEventId(eventId)) throw invalid('the block’s event id is not one Google takes');
  return `${eventsPath(calendarId)}/${encodeURIComponent(eventId)}`;
}

/** The note an event says it was written for, from its private properties. */
function notePathOf(entry: Record<string, unknown>): string | null {
  const properties = entry['extendedProperties'];
  const own = isRecord(properties) ? properties['private'] : undefined;
  return isRecord(own) ? text(own[NOTE_PATH]) : null;
}

/** An event on the blocks calendar from the API's wire form; null without an id. */
export function blockEventOf(entry: unknown): BlockEvent | null {
  if (!isRecord(entry)) return null;
  const id = text(entry['id']);
  if (id === null) return null;
  return {
    id,
    etag: text(entry['etag']),
    cancelled: entry['status'] === 'cancelled',
    title: typeof entry['summary'] === 'string' ? entry['summary'] : '',
    start: whenOf(entry['start']),
    end: whenOf(entry['end']),
    notePath: notePathOf(entry),
  };
}

/**
 * A page token as Google gives one: absent on the last page, else a string.
 * Anything else is no proof the listing ended, so it is not read as the end.
 */
function pageTokenOf(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const token = text(value);
  if (token === null)
    throw malformed('a page of the blocks calendar’s events names no readable next page');
  return token;
}

/** One page of the listing, or null when the body is not one. */
function blockEventsPage(body: unknown) {
  if (!isRecord(body) || (body['items'] !== undefined && !Array.isArray(body['items'])))
    return null;
  const items: unknown[] = Array.isArray(body['items']) ? body['items'] : [];
  return {
    events: items.map(blockEventOf).filter((event) => event !== null),
    next: pageTokenOf(body['nextPageToken']),
    syncToken: text(body['nextSyncToken']),
  };
}

/** The query one page is asked with: no time range, so the token covers the whole calendar. */
export function blockEventsQuery(syncToken: string | null, pageToken: string | null): string {
  const query = new URLSearchParams({ showDeleted: 'true', maxResults: String(PAGE_SIZE) });
  if (syncToken !== null) query.set('syncToken', syncToken);
  if (pageToken !== null) query.set('pageToken', pageToken);
  return query.toString();
}

/**
 * The event's body: busy, its title, its times as the block's wall clock on
 * the plan zone, so Google places them and no offset is guessed, and the
 * note it is for, kept private to DFAI.
 */
export function blockEventBody({
  fields,
  timeZone,
  notePath,
}: BlockEventCall): Record<string, unknown> {
  return {
    summary: fields.title,
    start: { dateTime: `${fields.start}:00`, timeZone },
    end: { dateTime: `${fields.end}:00`, timeZone },
    transparency: 'opaque',
    ...(notePath === undefined
      ? {}
      : { extendedProperties: { private: { [NOTE_PATH]: notePath } } }),
  };
}

/** A write's answer: the version it landed as, or the id taken, or the event gone. */
function writeAnswer(answer: { status: number; body: string }): BlockEventWrite {
  if (answer.status === CONFLICT) return { kind: 'exists' };
  if (answer.status === GONE || answer.status === NOT_FOUND) return { kind: 'gone' };
  const event = blockEventOf(answered(answer));
  if (event === null) throw malformed('the written event came back without an id');
  return { kind: 'written', etag: event.etag };
}

/** The primary calendar's zone, from a listing of one of its events and nothing else. */
const PRIMARY_ZONE_PATH = '/calendar/v3/calendars/primary/events?maxResults=1&fields=timeZone';

/**
 * The blocks calendar through the host's sign-in (#30): `events.list`,
 * `events.get`, `events.insert` and `events.patch` on the one calendar named,
 * and nothing else — never a delete. The primary calendar is only read, for
 * its zone. Every page of a listing is read before it is answered, since a
 * listing cut short would read as events deleted.
 */
export const tauriBlockCalendar: BlockCalendar = {
  async listBlockEvents({ vault, calendarId, syncToken }): Promise<BlockEventChanges> {
    const events: BlockEvent[] = [];
    let pageToken: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const path = `${eventsPath(calendarId)}?${blockEventsQuery(syncToken, pageToken)}`;
      const answer = await calendarAnswer(vault, { method: 'GET', path });
      if (answer.status === GONE) return { kind: 'expired' };
      const listed = blockEventsPage(answered(answer));
      if (listed === null)
        throw malformed('the blocks calendar’s events are not a list DFAI can read');
      events.push(...listed.events);
      if (listed.next === null) return { kind: 'changes', events, syncToken: listed.syncToken };
      pageToken = listed.next;
    }
    throw malformed(`the blocks calendar’s events ran past ${MAX_PAGES} pages`);
  },
  async getBlockEvent({ vault, calendarId, eventId }) {
    const answer = await calendarAnswer(vault, {
      method: 'GET',
      path: eventPath(calendarId, eventId),
    });
    if (answer.status === GONE || answer.status === NOT_FOUND) return null;
    const event = blockEventOf(answered(answer));
    if (event === null) throw malformed('the block’s event came back without an id');
    return event;
  },
  async insertBlockEvent(call) {
    if (!isGoogleEventId(call.eventId))
      throw invalid('the block’s event id is not one Google takes');
    const body = JSON.stringify({ id: call.eventId, ...blockEventBody(call) });
    return writeAnswer(
      await calendarAnswer(call.vault, { method: 'POST', path: eventsPath(call.calendarId), body }),
    );
  },
  async patchBlockEvent(call) {
    const path = eventPath(call.calendarId, call.eventId);
    const body = JSON.stringify(blockEventBody(call));
    return writeAnswer(await calendarAnswer(call.vault, { method: 'PATCH', path, body }));
  },
  async primaryTimeZone({ vault }) {
    try {
      const body = answered(
        await calendarAnswer(vault, { method: 'GET', path: PRIMARY_ZONE_PATH }),
      );
      return isRecord(body) ? text(body['timeZone']) : null;
    } catch (cause) {
      // A sign-in that may not read events (blocks without meetings) has no primary zone to give.
      if (cause instanceof GoogleCalendarError && isScopeRefusal(cause.failure)) return null;
      throw cause;
    }
  },
};
