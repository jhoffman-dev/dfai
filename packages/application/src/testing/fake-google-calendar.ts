import type { BlockEvent, BlockSyncFields, GoogleCalendar, GoogleEvent } from '@dfai/domain';
import type {
  BlockCalendar,
  BlockEventCall,
  BlockSyncRecord,
  BlockSyncRecords,
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

/**
 * The blocks calendar in memory, as Google keeps one: each write gives the
 * event a new version (etag), a listing with no token gives everything and a
 * token, a token gives what changed since, `expire` makes every token stale
 * (410). An insert whose id is taken answers `exists`, a patch of a deleted
 * event `gone`. Times are read on the fixed `offset` (Los Angeles in late
 * October), which is all the tests need of a zone.
 */
export function fakeBlockCalendar(events: BlockEvent[] = [], offset = '-07:00') {
  const state = {
    events: new Map(events.map((event) => [event.id, event])),
    changed: new Set<string>(),
    live: new Set<string>(),
    issued: 0,
    versions: 0,
    asked: [] as { calendarId: string; syncToken: string | null }[],
    writes: [] as { kind: 'insert' | 'patch'; call: BlockEventCall }[],
    /** The next call of each kind fails with this, once. */
    failNext: {} as Partial<Record<'list' | 'insert' | 'patch', Error>>,
    zone: 'America/Los_Angeles' as string | null,
  };
  const issue = () => {
    state.issued += 1;
    const token = `blocks-sync-${state.issued}`;
    state.live.add(token);
    return token;
  };
  const version = () => {
    state.versions += 1;
    return `"g${state.versions}"`;
  };
  const failing = (kind: 'list' | 'insert' | 'patch') => {
    const failure = state.failNext[kind];
    delete state.failNext[kind];
    if (failure !== undefined) throw failure;
  };
  const at = (wall: string) => Date.parse(`${wall}:00${offset}`);
  const put = (id: string, fields: BlockSyncFields) => {
    const event: BlockEvent = {
      id,
      etag: version(),
      cancelled: false,
      title: fields.title,
      start: { kind: 'timed', at: at(fields.start) },
      end: { kind: 'timed', at: at(fields.end) },
    };
    state.events.set(id, event);
    state.changed.add(id);
    return { kind: 'written' as const, etag: event.etag };
  };
  const calendar: BlockCalendar = {
    listBlockEvents: async ({ calendarId, syncToken }) => {
      state.asked.push({ calendarId, syncToken });
      failing('list');
      if (syncToken !== null && !state.live.has(syncToken)) return { kind: 'expired' };
      const listed =
        syncToken === null
          ? [...state.events.values()]
          : [...state.changed].flatMap((id) => {
              const event = state.events.get(id);
              return event === undefined ? [] : [event];
            });
      state.changed.clear();
      return { kind: 'changes', events: listed, syncToken: issue(), timeZone: state.zone };
    },
    insertBlockEvent: async (call) => {
      state.writes.push({ kind: 'insert', call });
      failing('insert');
      if (state.events.has(call.eventId)) return { kind: 'exists' };
      return put(call.eventId, call.fields);
    },
    patchBlockEvent: async (call) => {
      state.writes.push({ kind: 'patch', call });
      failing('patch');
      const kept = state.events.get(call.eventId);
      if (kept === undefined || kept.cancelled) return { kind: 'gone' };
      return put(call.eventId, call.fields);
    },
  };
  return {
    calendar,
    state,
    /** Someone moves the event in Google Calendar. */
    move: (id: string, start: string, end: string) => {
      const kept = state.events.get(id);
      if (kept === undefined) throw new Error(`no event ${id}`);
      put(id, { title: kept.title, start, end });
    },
    /** Someone deletes the event in Google Calendar. */
    remove: (id: string) => {
      state.events.set(id, {
        id,
        etag: version(),
        cancelled: true,
        title: '',
        start: null,
        end: null,
      });
      state.changed.add(id);
    },
    expire: () => state.live.clear(),
  };
}

/** This Mac's block sync records, in memory. */
export function memoryBlockSyncRecords() {
  const kept = new Map<string, BlockSyncRecord>();
  const records: BlockSyncRecords = {
    read: (vault) =>
      kept.get(vault) ?? { calendarId: null, syncToken: null, agreed: {}, lastSyncAt: null },
    write: (vault, record) => {
      kept.set(vault, record);
    },
  };
  return { records, kept };
}
