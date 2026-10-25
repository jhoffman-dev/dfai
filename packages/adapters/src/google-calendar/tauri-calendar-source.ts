import type { GoogleEvent } from '@dfai/domain';
import type { CalendarChanges, CalendarSource } from '@dfai/application';
import { eventsPage } from './events-list.ts';
import { answered, calendarAnswer, malformed } from './tauri-google-calendar.ts';

/** Google's largest page, so a week of meetings is one call. */
const PAGE_SIZE = 250;

/** Ten thousand events; past it, a server looping on pages is cut off. */
const MAX_PAGES = 40;

/** Google's answer to a sync token it no longer honours: list in full again. */
const GONE = 410;

/**
 * The query one page is asked with. A sync token cannot be sent with a time
 * range, so a listing is one or the other; every other parameter is the same
 * both ways, as Google requires of a token's listings.
 */
export function eventsQuery({
  timeMin,
  timeMax,
  syncToken,
  pageToken,
}: {
  timeMin: number;
  timeMax: number;
  syncToken: string | null;
  pageToken: string | null;
}): string {
  const query = new URLSearchParams({
    singleEvents: 'true',
    showDeleted: 'true',
    maxResults: String(PAGE_SIZE),
  });
  if (syncToken === null) {
    query.set('timeMin', new Date(timeMin).toISOString());
    query.set('timeMax', new Date(timeMax).toISOString());
  } else {
    query.set('syncToken', syncToken);
  }
  if (pageToken !== null) query.set('pageToken', pageToken);
  return query.toString();
}

/**
 * The person's events through the host's sign-in (ADR-0046), every page of
 * a listing read before it is answered: a listing cut short would read as
 * events deleted. Read-only: the only call made is `events.list`.
 */
export const tauriCalendarSource: CalendarSource = {
  async listEvents({ vault, calendarId, timeMin, timeMax, syncToken }): Promise<CalendarChanges> {
    const path = `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
    const events: GoogleEvent[] = [];
    let pageToken: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const query = eventsQuery({ timeMin, timeMax, syncToken, pageToken });
      const answer = await calendarAnswer(vault, { method: 'GET', path: `${path}?${query}` });
      if (answer.status === GONE) return { kind: 'expired' };
      const listed = eventsPage(answered(answer), calendarId);
      if (listed === null) throw malformed('the events list is not one DFAI can read');
      events.push(...listed.events);
      if (listed.next === null) return { kind: 'changes', events, syncToken: listed.syncToken };
      pageToken = listed.next;
    }
    throw malformed(`the events list ran past ${MAX_PAGES} pages`);
  },
};
