/**
 * Adversarial: ids that come from a block's frontmatter or the vault's
 * settings, not from Google, must not move a call off the blocks calendar's
 * events. The host resolves dot segments before sending (WHATWG / `url`
 * crate), so `..` in an id changes which resource is called, while still
 * passing its `/calendar/v3/` check. Nothing here reaches Google.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlockEventCall } from '@dfai/application';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const { tauriBlockCalendar } = await import('./tauri-block-calendar.ts');

const VAULT = '/Users/someone/Vault';
const CALENDAR = 'dfai-blocks@group.calendar.example.com';
const API = 'https://www.googleapis.com/';

/** The path the host would send, once its URL parser has resolved it against the API. */
const resolvedPaths = () =>
  invoke.mock.calls.map(([, args]) => {
    const { call } = args as { call: { path: string } };
    return new URL(call.path, API).pathname;
  });

const call = (eventId: string, calendarId = CALENDAR): BlockEventCall => ({
  vault: VAULT,
  calendarId,
  eventId,
  fields: { title: 'Ledger review block', start: '2026-10-26T09:00', end: '2026-10-26T10:00' },
  timeZone: 'America/Los_Angeles',
});

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue({ status: 200, body: JSON.stringify({ id: 'x', etag: '"e1"' }) });
});

describe('tauriBlockCalendar, adversarial: hostile ids', () => {
  it('a gcal_event_id of ".." in a block’s frontmatter never patches anything but one of the calendar’s events', async () => {
    await tauriBlockCalendar.patchBlockEvent(call('..')).catch(() => undefined);
    const events = `/calendar/v3/calendars/${encodeURIComponent(CALENDAR)}/events/`;
    for (const path of resolvedPaths()) expect(path.startsWith(events)).toBe(true);
  });

  it('a calendar id of ".." in the vault’s settings never lists or writes outside a calendar', async () => {
    await tauriBlockCalendar
      .listBlockEvents({ vault: VAULT, calendarId: '..', syncToken: null })
      .catch(() => undefined);
    await tauriBlockCalendar.insertBlockEvent(call('dfai0123456789', '..')).catch(() => undefined);
    for (const path of resolvedPaths())
      expect(path.startsWith('/calendar/v3/calendars/')).toBe(true);
  });
});

describe('tauriBlockCalendar, adversarial: a listing cut short', () => {
  it('a page whose nextPageToken is not a string, with no nextSyncToken, is not taken as the whole calendar', async () => {
    const page = {
      kind: 'calendar#events',
      timeZone: 'America/Los_Angeles',
      items: [{ id: 'dfaiaaaa', etag: '"e1"', status: 'confirmed', summary: 'A block' }],
      // Malformed: a number where Google sends a string; the rest of the calendar is on later pages.
      nextPageToken: 2,
    };
    invoke.mockResolvedValue({ status: 200, body: JSON.stringify(page) });
    // Read as complete, every block on a later page would be marked gcal_missing.
    await expect(
      tauriBlockCalendar.listBlockEvents({ vault: VAULT, calendarId: CALENDAR, syncToken: null }),
    ).rejects.toThrow();
  });
});
