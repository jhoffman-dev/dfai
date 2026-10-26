import type { BlockEvent } from '@dfai/domain';
import type {
  BlockCalendar,
  BlockEventCall,
  BlockEventChanges,
  BlockEventWrite,
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

const eventsPath = (calendarId: string) =>
  `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;

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
  };
}

/** One page of the listing, or null when the body is not one. */
function blockEventsPage(body: unknown) {
  if (!isRecord(body) || (body['items'] !== undefined && !Array.isArray(body['items'])))
    return null;
  const items: unknown[] = Array.isArray(body['items']) ? body['items'] : [];
  return {
    events: items.map(blockEventOf).filter((event) => event !== null),
    next: text(body['nextPageToken']),
    syncToken: text(body['nextSyncToken']),
    timeZone: text(body['timeZone']),
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
 * The event's body: busy, its title, and its times as the block's wall clock
 * on the calendar's zone, so Google places them and no offset is guessed.
 */
export function blockEventBody({ fields, timeZone }: BlockEventCall): Record<string, unknown> {
  return {
    summary: fields.title,
    start: { dateTime: `${fields.start}:00`, timeZone },
    end: { dateTime: `${fields.end}:00`, timeZone },
    transparency: 'opaque',
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

/**
 * The blocks calendar through the host's sign-in (#30): `events.list`,
 * `events.insert` and `events.patch` on the one calendar named, and nothing
 * else — never a delete. Every page of a listing is read before it is
 * answered, since a listing cut short would read as events deleted.
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
      if (listed.next === null) {
        return { kind: 'changes', events, syncToken: listed.syncToken, timeZone: listed.timeZone };
      }
      pageToken = listed.next;
    }
    throw malformed(`the blocks calendar’s events ran past ${MAX_PAGES} pages`);
  },
  async insertBlockEvent(call) {
    const body = JSON.stringify({ id: call.eventId, ...blockEventBody(call) });
    return writeAnswer(
      await calendarAnswer(call.vault, { method: 'POST', path: eventsPath(call.calendarId), body }),
    );
  },
  async patchBlockEvent(call) {
    const path = `${eventsPath(call.calendarId)}/${encodeURIComponent(call.eventId)}`;
    const body = JSON.stringify(blockEventBody(call));
    return writeAnswer(await calendarAnswer(call.vault, { method: 'PATCH', path, body }));
  },
};
