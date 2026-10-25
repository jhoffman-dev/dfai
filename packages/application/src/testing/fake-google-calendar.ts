import type { GoogleCalendar, GoogleEvent } from '@dfai/domain';
import type {
  CalendarSource,
  GoogleCalendarPort,
  GoogleConnection,
  MeetingSyncRecord,
  MeetingSyncRecords,
} from '../google-calendar/ports.ts';

/**
 * Google Calendar in memory: a sign-in is kept per vault, and `next` makes the
 * next connect fail with that error instead — a refusal, a timeout.
 */
export function fakeGoogleCalendar(calendars: GoogleCalendar[] = []) {
  const connected = new Map<string, GoogleConnection>();
  const state = {
    next: null as Error | null,
    revoked: true,
    shared: false,
    cancels: 0,
    calendars,
  };
  const port: GoogleCalendarPort = {
    status: async ({ vault }) =>
      connected.get(vault) ?? { connected: false, clientId: null, scopes: [] },
    connect: async ({ vault, clientId, scopes }) => {
      if (state.next !== null) {
        const failure = state.next;
        state.next = null;
        throw failure;
      }
      const connection = { connected: true, clientId, scopes };
      connected.set(vault, connection);
      return connection;
    },
    cancelConnect: async () => {
      state.cancels += 1;
    },
    disconnect: async ({ vault }) => {
      connected.delete(vault);
      return { revoked: state.revoked, shared: state.shared };
    },
    listCalendars: async () => state.calendars,
    createCalendar: async ({ name }) => {
      const made = {
        id: `${name.toLowerCase().replace(/ /g, '-')}@group.calendar.example.com`,
        name,
        primary: false,
        owned: true,
      };
      state.calendars = [...state.calendars, made];
      return made;
    },
  };
  return { port, connected, state };
}

/** Whether an event starts between two instants; an all-day one by its day's UTC midnight. */
function startsBetween(event: GoogleEvent, timeMin: number, timeMax: number): boolean {
  if (event.start === null) return true;
  const at =
    event.start.kind === 'timed' ? event.start.at : Date.parse(`${event.start.date}T00:00:00Z`);
  return at >= timeMin && at < timeMax;
}

/** The zone a fake calendar keeps unless it is given another: Google always names one. */
export const FAKE_CALENDAR_ZONE = 'America/Los_Angeles';

/**
 * Google Calendar's events in memory, with sync tokens as Google keeps them:
 * a full listing of a window gives a token, a token gives what was `change`d
 * since, and `expire` makes every token given so far stale (410). Each
 * calendar keeps {@link FAKE_CALENDAR_ZONE} unless `zones` names another, or null.
 */
export function fakeCalendarSource(
  calendars: Record<string, GoogleEvent[]> = {},
  zones: Record<string, string | null> = {},
) {
  const state = {
    calendars,
    changes: {} as Record<string, GoogleEvent[]>,
    live: new Set<string>(),
    issued: 0,
    asked: [] as { calendarId: string; syncToken: string | null }[],
    next: null as Error | null,
  };
  const issue = () => {
    state.issued += 1;
    const token = `sync-${state.issued}`;
    state.live.add(token);
    return token;
  };
  const zoneOf = (calendarId: string) =>
    calendarId in zones ? (zones[calendarId] ?? null) : FAKE_CALENDAR_ZONE;
  const source: CalendarSource = {
    listEvents: async ({ calendarId, timeMin, timeMax, syncToken }) => {
      const timeZone = zoneOf(calendarId);
      state.asked.push({ calendarId, syncToken });
      if (state.next !== null) {
        const failure = state.next;
        state.next = null;
        throw failure;
      }
      if (syncToken !== null) {
        if (!state.live.has(syncToken)) return { kind: 'expired' };
        const events = state.changes[calendarId] ?? [];
        state.changes[calendarId] = [];
        return { kind: 'changes', events, syncToken: issue(), timeZone };
      }
      const events = (state.calendars[calendarId] ?? []).filter((event) =>
        startsBetween(event, timeMin, timeMax),
      );
      return { kind: 'changes', events, syncToken: issue(), timeZone };
    },
  };
  return {
    source,
    state,
    /** What changed on a calendar since the last listing: the next token's answer. */
    change: (calendarId: string, event: GoogleEvent) => {
      state.changes[calendarId] = [...(state.changes[calendarId] ?? []), event];
      const kept = (state.calendars[calendarId] ?? []).filter((each) => each.id !== event.id);
      state.calendars[calendarId] = event.status === 'cancelled' ? kept : [...kept, event];
    },
    expire: () => state.live.clear(),
  };
}

/** This Mac's meetings sync records, in memory. */
export function memoryMeetingSyncRecords() {
  const kept = new Map<string, MeetingSyncRecord>();
  const records: MeetingSyncRecords = {
    read: (vault) => kept.get(vault) ?? { calendars: {}, lastSyncAt: null },
    write: (vault, record) => {
      kept.set(vault, record);
    },
  };
  return { records, kept };
}
