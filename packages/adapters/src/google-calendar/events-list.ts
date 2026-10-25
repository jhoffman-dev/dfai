import {
  EVENT_RESPONSES,
  type EventAttendee,
  type EventResponse,
  type EventStatus,
  type EventWhen,
  type GoogleEvent,
} from '@dfai/domain';

/** One page of the Calendar API's `events.list`, as DFAI reads it. */
export interface EventsPage {
  readonly events: readonly GoogleEvent[];
  /** The `pageToken` for the next page; null on the last. */
  readonly next: string | null;
  /** Given on the last page only: where the next sync starts from. */
  readonly syncToken: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `{ dateTime }` as an instant, `{ date }` as a day; null for anything else. */
export function whenOf(value: unknown): EventWhen | null {
  if (!isRecord(value)) return null;
  const dateTime = text(value['dateTime']);
  if (dateTime !== null) {
    // RFC 3339 always carries an offset, so the instant is never a guess.
    const at = /(Z|[+-]\d{2}:\d{2})$/i.test(dateTime) ? Date.parse(dateTime) : Number.NaN;
    return Number.isFinite(at) ? { kind: 'timed', at } : null;
  }
  const date = text(value['date']);
  return date !== null && DAY.test(date) ? { kind: 'day', date } : null;
}

function responseOf(value: unknown): EventResponse | null {
  return (EVENT_RESPONSES as readonly unknown[]).includes(value) ? (value as EventResponse) : null;
}

function attendeeOf(entry: unknown): EventAttendee | null {
  if (!isRecord(entry)) return null;
  const email = text(entry['email']);
  if (email === null) return null;
  return {
    email,
    name: text(entry['displayName']),
    self: entry['self'] === true,
    response: responseOf(entry['responseStatus']),
    resource: entry['resource'] === true,
  };
}

const STATUSES: readonly string[] = ['confirmed', 'tentative', 'cancelled'];

/**
 * An event from the API's wire form. One without an id is left out; so is
 * one that is not cancelled but whose start cannot be read, rather than
 * placed on a day it may not be on. A cancelled one may carry its id alone.
 */
export function eventOf(entry: unknown, calendarId: string): GoogleEvent | null {
  if (!isRecord(entry)) return null;
  const id = text(entry['id']);
  if (id === null) return null;
  const status = (
    STATUSES.includes(String(entry['status'])) ? entry['status'] : 'confirmed'
  ) as EventStatus;
  const start = whenOf(entry['start']);
  if (start === null && status !== 'cancelled') return null;
  const attendees = Array.isArray(entry['attendees']) ? entry['attendees'] : [];
  return {
    id,
    calendarId,
    status,
    title: typeof entry['summary'] === 'string' ? entry['summary'] : '',
    start,
    end: whenOf(entry['end']),
    attendees: attendees.map(attendeeOf).filter((attendee) => attendee !== null),
    recurringEventId: text(entry['recurringEventId']),
    eventType: text(entry['eventType']) ?? 'default',
  };
}

/** An `events.list` page, or null when the body is not one. */
export function eventsPage(body: unknown, calendarId: string): EventsPage | null {
  if (!isRecord(body) || (body['items'] !== undefined && !Array.isArray(body['items'])))
    return null;
  const items: unknown[] = Array.isArray(body['items']) ? body['items'] : [];
  return {
    events: items.map((item) => eventOf(item, calendarId)).filter((event) => event !== null),
    next: text(body['nextPageToken']),
    syncToken: text(body['nextSyncToken']),
  };
}
