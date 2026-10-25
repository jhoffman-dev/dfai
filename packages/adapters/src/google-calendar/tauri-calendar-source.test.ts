/**
 * The events reader against a fake Google Calendar on this machine's
 * loopback (ADR-0046): the host command is played by a hop to a local HTTP
 * server, so each listing is a real request — a query Google must read,
 * pages it must hand out, sync tokens it keeps — and nothing reaches Google.
 * What the host itself does with the token (refresh on 401, a revoked
 * sign-in, its timeout) is tested in Rust (`google/tests/events.rs`); here
 * the hop answers as the host does when those happen.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GoogleCalendarError } from '@dfai/application';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const { tauriCalendarSource } = await import('./tauri-calendar-source.ts');

const VAULT = '/Users/someone/Vault';
const TIME_MIN = Date.parse('2026-10-23T07:00:00Z');
const TIME_MAX = Date.parse('2026-10-31T07:00:00Z');

type WireEvent = Record<string, unknown> & { id: string };

/** Google Calendar's `events.list`, as much of it as a meetings sync uses. */
const google = {
  events: new Map<string, WireEvent[]>(),
  changes: new Map<string, WireEvent[]>(),
  liveTokens: new Set<string>(),
  issued: 0,
  queries: [] as { calendar: string; query: URLSearchParams }[],
  scripted: [] as { status: number; body: string }[],
  endlessPages: false,
  stalls: false,
};

/** One page of `items`; only the last carries what `last` gives, so a token is issued once a listing ends. */
function page(items: WireEvent[], query: URLSearchParams, last: () => Record<string, string>) {
  const size = Number(query.get('maxResults') ?? 250);
  const start = Number((query.get('pageToken') ?? 'p0').slice(1));
  const slice = items.slice(start, start + size);
  const more = google.endlessPages || start + size < items.length;
  return JSON.stringify({
    kind: 'calendar#events',
    items: slice,
    ...(more ? { nextPageToken: `p${start + size}` } : last()),
  });
}

function issue(): string {
  google.issued += 1;
  const token = `sync-${google.issued}`;
  google.liveTokens.add(token);
  return token;
}

function serve(request: IncomingMessage): { status: number; body: string } | null {
  const scripted = google.scripted.shift();
  if (scripted !== undefined) return scripted;
  if (google.stalls) return null;
  const url = new URL(request.url ?? '/', 'http://calendar.test');
  const match = /^\/calendar\/v3\/calendars\/([^/]+)\/events$/.exec(url.pathname);
  if (request.method !== 'GET' || match === null)
    return { status: 404, body: '{"error":{"code":404}}' };
  const calendar = decodeURIComponent(match[1] ?? '');
  const query = url.searchParams;
  google.queries.push({ calendar, query });
  const token = query.get('syncToken');
  if (token !== null && (query.has('timeMin') || query.has('timeMax'))) {
    return {
      status: 400,
      body: '{"error":{"code":400,"message":"Sync token cannot be used with timeMin"}}',
    };
  }
  if (token !== null) {
    if (!google.liveTokens.has(token)) {
      return {
        status: 410,
        body: '{"error":{"code":410,"errors":[{"reason":"fullSyncRequired"}]}}',
      };
    }
    return {
      status: 200,
      body: page(google.changes.get(calendar) ?? [], query, () => ({ nextSyncToken: issue() })),
    };
  }
  return {
    status: 200,
    body: page(google.events.get(calendar) ?? [], query, () => ({ nextSyncToken: issue() })),
  };
}

let server: Server;
let origin = '';

beforeAll(async () => {
  server = createServer((request, response) => {
    const answer = serve(request);
    // A stalled answer is never sent: the hop's timeout is what ends it.
    if (answer === null) return;
    response.writeHead(answer.status, { 'content-type': 'application/json' });
    response.end(answer.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(
  () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
);

/** The host's part: the call sent as built, its answer handed back, a stall reported as the host reports it. */
async function hop(command: string, args: Record<string, unknown>) {
  expect(command).toBe('google_calendar_request');
  expect(args['vault']).toBe(VAULT);
  const call = args['call'] as { method: string; path: string };
  try {
    const response = await fetch(origin + call.path, {
      method: call.method,
      signal: AbortSignal.timeout(300),
    });
    return { status: response.status, body: await response.text() };
  } catch {
    throw { kind: 'unreachable', message: 'the Google API did not answer in time' };
  }
}

beforeEach(() => {
  google.events = new Map();
  google.changes = new Map();
  google.liveTokens = new Set();
  google.issued = 0;
  google.queries = [];
  google.scripted = [];
  google.endlessPages = false;
  google.stalls = false;
  invoke.mockReset();
  invoke.mockImplementation(hop);
});

const list = (syncToken: string | null = null, calendarId = 'primary') =>
  tauriCalendarSource.listEvents({
    vault: VAULT,
    calendarId,
    timeMin: TIME_MIN,
    timeMax: TIME_MAX,
    syncToken,
  });

const wire = (id: string, more: Record<string, unknown> = {}): WireEvent => ({
  id,
  status: 'confirmed',
  summary: `Meeting ${id}`,
  start: { dateTime: '2026-10-24T09:00:00-07:00', timeZone: 'America/Los_Angeles' },
  end: { dateTime: '2026-10-24T09:30:00-07:00' },
  eventType: 'default',
  ...more,
});

const failureOf = async (listing: Promise<unknown>) => {
  const caught = await listing.catch((cause: unknown) => cause);
  expect(caught).toBeInstanceOf(GoogleCalendarError);
  return (caught as GoogleCalendarError).failure;
};

describe('tauriCalendarSource: a full listing', () => {
  it('reads every page of the window and keeps the sync token the last one gives', async () => {
    google.events.set(
      'primary',
      Array.from({ length: 260 }, (_, at) => wire(`ev-${at}`)),
    );
    const answer = await list();
    expect(answer.kind === 'changes' && answer.events.length).toBe(260);
    expect(answer).toMatchObject({ kind: 'changes', syncToken: 'sync-1' });
    expect(google.queries.map(({ query }) => query.get('pageToken'))).toEqual([null, 'p250']);
    const [first] = google.queries;
    expect(Object.fromEntries(first?.query ?? [])).toEqual({
      singleEvents: 'true',
      showDeleted: 'true',
      maxResults: '250',
      timeMin: '2026-10-23T07:00:00.000Z',
      timeMax: '2026-10-31T07:00:00.000Z',
    });
  });

  it('reads an event as DFAI needs it: the instant, the day, who answered what', async () => {
    google.events.set('primary', [
      wire('ev-standup', {
        recurringEventId: 'ev-weekly',
        attendees: [
          { email: 'james@larkspur.example', self: true, responseStatus: 'declined' },
          { email: 'mara@larkspur.example', displayName: 'Mara Quill', responseStatus: 'accepted' },
          { email: 'room@resource.example.com', resource: true, responseStatus: 'maybe-later' },
          { displayName: 'No address' },
        ],
      }),
      wire('ev-offsite', { start: { date: '2026-10-26' }, end: { date: '2026-10-28' } }),
    ]);
    const answer = await list();
    expect(answer.kind === 'changes' && answer.events).toEqual([
      {
        id: 'ev-standup',
        calendarId: 'primary',
        status: 'confirmed',
        title: 'Meeting ev-standup',
        start: { kind: 'timed', at: Date.parse('2026-10-24T16:00:00Z') },
        end: { kind: 'timed', at: Date.parse('2026-10-24T16:30:00Z') },
        attendees: [
          {
            email: 'james@larkspur.example',
            name: null,
            self: true,
            response: 'declined',
            resource: false,
          },
          {
            email: 'mara@larkspur.example',
            name: 'Mara Quill',
            self: false,
            response: 'accepted',
            resource: false,
          },
          {
            email: 'room@resource.example.com',
            name: null,
            self: false,
            response: null,
            resource: true,
          },
        ],
        recurringEventId: 'ev-weekly',
        eventType: 'default',
      },
      {
        id: 'ev-offsite',
        calendarId: 'primary',
        status: 'confirmed',
        title: 'Meeting ev-offsite',
        start: { kind: 'day', date: '2026-10-26' },
        end: { kind: 'day', date: '2026-10-28' },
        attendees: [],
        recurringEventId: null,
        eventType: 'default',
      },
    ]);
  });

  it('leaves out an event it cannot place rather than guessing its day', async () => {
    google.events.set('primary', [
      wire('ev-no-offset', { start: { dateTime: '2026-10-24T09:00:00' } }),
      wire('ev-no-start', { start: undefined }),
      { id: '', summary: 'no id' },
      wire('ev-kept'),
    ]);
    const answer = await list();
    expect(answer.kind === 'changes' && answer.events.map(({ id }) => id)).toEqual(['ev-kept']);
  });

  it('asks for a calendar by its id, written so it stays one part of the path', async () => {
    await list(null, 'team/ops@group.calendar.example.com');
    expect(google.queries.map(({ calendar }) => calendar)).toEqual([
      'team/ops@group.calendar.example.com',
    ]);
  });
});

describe('tauriCalendarSource: following changes', () => {
  it('asks what changed since the token, with no time range, and hears of a cancellation', async () => {
    await list();
    google.changes.set('primary', [{ id: 'ev-gone', status: 'cancelled' }, wire('ev-new')]);
    const answer = await list('sync-1');
    expect(answer).toMatchObject({ kind: 'changes', syncToken: 'sync-2' });
    expect(
      answer.kind === 'changes' &&
        answer.events.map(({ id, status, start }) => ({ id, status, start })),
    ).toEqual([
      { id: 'ev-gone', status: 'cancelled', start: null },
      {
        id: 'ev-new',
        status: 'confirmed',
        start: { kind: 'timed', at: Date.parse('2026-10-24T16:00:00Z') },
      },
    ]);
    expect(google.queries.at(-1)?.query.has('timeMin')).toBe(false);
  });

  it('says a token Google no longer honours (410) has expired, so the window is listed again', async () => {
    expect(await list('sync-from-last-month')).toEqual({ kind: 'expired' });
  });
});

describe('tauriCalendarSource: what goes wrong', () => {
  it('turns Google’s refusals into a failure with the status, for each of them', async () => {
    for (const status of [401, 403, 429, 500, 503]) {
      google.scripted.push({ status, body: `{"error":{"code":${status}}}` });
      expect(await failureOf(list())).toMatchObject({ kind: 'api_refused', code: String(status) });
    }
  });

  it('reports a body that is not JSON, or not an events list, as malformed', async () => {
    google.scripted.push({ status: 200, body: '{not json' });
    expect(await failureOf(list())).toMatchObject({ kind: 'malformed' });
    google.scripted.push({ status: 200, body: '{"items":"not a list"}' });
    expect(await failureOf(list())).toMatchObject({
      kind: 'malformed',
      message: 'the events list is not one DFAI can read',
    });
  });

  it('fails a page that goes bad part way, rather than answering with half a listing', async () => {
    google.events.set(
      'primary',
      Array.from({ length: 300 }, (_, at) => wire(`ev-${at}`)),
    );
    invoke
      .mockImplementationOnce(hop)
      .mockImplementationOnce(async () => ({ status: 503, body: '{}' }));
    expect(await failureOf(list())).toMatchObject({ kind: 'api_refused', code: '503' });
  });

  it('cuts off a server that never stops handing out pages', async () => {
    google.endlessPages = true;
    google.events.set('primary', [wire('ev-1')]);
    expect(await failureOf(list())).toMatchObject({
      kind: 'malformed',
      message: 'the events list ran past 40 pages',
    });
  });

  it('passes on a Google that does not answer in time as unreachable', async () => {
    google.stalls = true;
    expect(await failureOf(list())).toMatchObject({ kind: 'unreachable' });
  });

  it('passes on a sign-in Google revoked, as the host reports it', async () => {
    invoke.mockRejectedValueOnce({
      kind: 'token_refused',
      code: 'invalid_grant',
      message: 'Google refused the refresh token',
    });
    expect(await failureOf(list())).toEqual({
      kind: 'token_refused',
      code: 'invalid_grant',
      message: 'Google refused the refresh token',
    });
  });
});
