/**
 * The blocks calendar (#30) against a fake Google Calendar on this machine's
 * loopback: the host command is played by a hop to a local HTTP server, so
 * each listing, insert and patch is a real request — a body Google must
 * read, versions it hands out, sync tokens it keeps — and nothing reaches
 * Google. What the host does with the token (renewing it on a 401, a revoked
 * sign-in, its timeout) is tested in Rust (`google/tests/events.rs`); here the
 * hop answers as the host does once those have happened.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isScopeRefusal } from '@dfai/domain';
import { GoogleCalendarError, type BlockEventCall } from '@dfai/application';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const { tauriBlockCalendar } = await import('./tauri-block-calendar.ts');

const VAULT = '/Users/someone/Vault';
const CALENDAR = 'dfai-blocks@group.calendar.example.com';

type WireEvent = Record<string, unknown> & { id: string };

/** Google Calendar's events on one calendar, as much of it as a block sync uses. */
const google = {
  events: new Map<string, WireEvent>(),
  changed: new Set<string>(),
  liveTokens: new Set<string>(),
  issued: 0,
  versions: 0,
  requests: [] as { method: string; path: string; query: URLSearchParams; body: unknown }[],
  scripted: [] as { status: number; body: string }[],
  stalls: false,
  zone: 'America/Los_Angeles' as string | null,
};

const version = () => {
  google.versions += 1;
  return `"v${google.versions}"`;
};

function issue(): string {
  google.issued += 1;
  const token = `sync-${google.issued}`;
  google.liveTokens.add(token);
  return token;
}

const answer = (status: number, body: unknown) => ({ status, body: JSON.stringify(body) });

function list(query: URLSearchParams) {
  if (query.has('timeMin') || query.has('timeMax') || query.has('singleEvents')) {
    return answer(400, { error: { code: 400, message: 'not how blocks are listed' } });
  }
  const token = query.get('syncToken');
  if (token !== null && !google.liveTokens.has(token)) {
    return answer(410, { error: { code: 410, errors: [{ reason: 'fullSyncRequired' }] } });
  }
  const ids = token === null ? [...google.events.keys()] : [...google.changed];
  google.changed.clear();
  const items = ids.flatMap((id) => {
    const event = google.events.get(id);
    return event === undefined ? [] : [event];
  });
  return answer(200, {
    kind: 'calendar#events',
    ...(google.zone === null ? {} : { timeZone: google.zone }),
    items,
    nextSyncToken: issue(),
  });
}

function write(id: string, body: Record<string, unknown>) {
  const event: WireEvent = {
    ...google.events.get(id),
    ...body,
    id,
    etag: version(),
    status: 'confirmed',
  };
  google.events.set(id, event);
  google.changed.add(id);
  return answer(200, event);
}

function serve(method: string, url: URL, body: unknown): { status: number; body: string } | null {
  const scripted = google.scripted.shift();
  if (scripted !== undefined) return scripted;
  if (google.stalls) return null;
  const match = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(url.pathname);
  if (match === null || decodeURIComponent(match[1] ?? '') !== CALENDAR) {
    return answer(404, { error: { code: 404 } });
  }
  const eventId = match[2] === undefined ? null : decodeURIComponent(match[2]);
  const fields = (body ?? {}) as Record<string, unknown>;
  if (method === 'GET' && eventId === null) return list(url.searchParams);
  if (method === 'POST' && eventId === null) {
    const id = String(fields['id']);
    if (google.events.has(id)) return answer(409, { error: { code: 409, message: 'duplicate' } });
    return write(id, fields);
  }
  if (method === 'PATCH' && eventId !== null) {
    const kept = google.events.get(eventId);
    if (kept === undefined) return answer(404, { error: { code: 404, message: 'Not Found' } });
    if (kept['status'] === 'cancelled')
      return answer(410, { error: { code: 410, message: 'deleted' } });
    return write(eventId, fields);
  }
  return answer(405, { error: { code: 405 } });
}

const read = (request: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let text = '';
    request.on('data', (chunk: Buffer) => (text += chunk.toString()));
    request.on('end', () => resolve(text));
  });

let server: Server;
let origin = '';

beforeAll(async () => {
  server = createServer((request, response) => {
    void read(request).then((text) => {
      const url = new URL(request.url ?? '/', 'http://calendar.test');
      const body = text === '' ? null : (JSON.parse(text) as unknown);
      const method = request.method ?? 'GET';
      google.requests.push({ method, path: url.pathname, query: url.searchParams, body });
      const answered = serve(method, url, body);
      // A stalled answer is never sent: the hop's timeout is what ends it.
      if (answered === null) return;
      response.writeHead(answered.status, { 'content-type': 'application/json' });
      response.end(answered.body);
    });
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
  const call = args['call'] as { method: string; path: string; body?: string };
  try {
    const response = await fetch(origin + call.path, {
      method: call.method,
      ...(call.body === undefined ? {} : { body: call.body }),
      signal: AbortSignal.timeout(300),
    });
    return { status: response.status, body: await response.text() };
  } catch {
    throw { kind: 'unreachable', message: 'the Google API did not answer in time' };
  }
}

beforeEach(() => {
  google.events = new Map();
  google.changed = new Set();
  google.liveTokens = new Set();
  google.issued = 0;
  google.versions = 0;
  google.requests = [];
  google.scripted = [];
  google.stalls = false;
  google.zone = 'America/Los_Angeles';
  invoke.mockReset();
  invoke.mockImplementation(hop);
});

const call = (more: Partial<BlockEventCall> = {}): BlockEventCall => ({
  vault: VAULT,
  calendarId: CALENDAR,
  eventId: 'dfaiblock1',
  fields: { title: 'Larkspur close block', start: '2026-10-26T09:00', end: '2026-10-26T10:00' },
  timeZone: 'America/Los_Angeles',
  ...more,
});

const listBlocks = (syncToken: string | null = null) =>
  tauriBlockCalendar.listBlockEvents({ vault: VAULT, calendarId: CALENDAR, syncToken });

const failureOf = async (pending: Promise<unknown>) => {
  const caught = await pending.catch((cause: unknown) => cause);
  expect(caught).toBeInstanceOf(GoogleCalendarError);
  return (caught as GoogleCalendarError).failure;
};

describe('tauriBlockCalendar: the round trip', () => {
  it('inserts a busy event with the id given, on the calendar’s clock, and lists it back with its version', async () => {
    const written = await tauriBlockCalendar.insertBlockEvent(call());
    expect(written).toEqual({ kind: 'written', etag: '"v1"' });
    const [sent] = google.requests;
    expect(sent).toMatchObject({
      method: 'POST',
      path: `/calendar/v3/calendars/${encodeURIComponent(CALENDAR)}/events`,
      body: {
        id: 'dfaiblock1',
        summary: 'Larkspur close block',
        start: { dateTime: '2026-10-26T09:00:00', timeZone: 'America/Los_Angeles' },
        end: { dateTime: '2026-10-26T10:00:00', timeZone: 'America/Los_Angeles' },
        transparency: 'opaque',
      },
    });

    // Google answers a listing with the instant, offset and all.
    google.events.set('dfaiblock1', {
      ...google.events.get('dfaiblock1')!,
      start: { dateTime: '2026-10-26T09:00:00-07:00', timeZone: 'America/Los_Angeles' },
      end: { dateTime: '2026-10-26T10:00:00-07:00', timeZone: 'America/Los_Angeles' },
    });
    const listed = await listBlocks();
    expect(listed).toEqual({
      kind: 'changes',
      events: [
        {
          id: 'dfaiblock1',
          etag: '"v1"',
          cancelled: false,
          title: 'Larkspur close block',
          start: { kind: 'timed', at: Date.parse('2026-10-26T16:00:00Z') },
          end: { kind: 'timed', at: Date.parse('2026-10-26T17:00:00Z') },
        },
      ],
      syncToken: 'sync-1',
      timeZone: 'America/Los_Angeles',
    });
    expect(Object.fromEntries(google.requests.at(-1)!.query)).toEqual({
      showDeleted: 'true',
      maxResults: '2500',
    });
  });

  it('patches the event by its id, and the change is what the next token lists', async () => {
    await tauriBlockCalendar.insertBlockEvent(call());
    const { syncToken } = (await listBlocks()) as { syncToken: string };
    const moved = call({
      fields: { title: 'Larkspur close block', start: '2026-10-26T13:00', end: '2026-10-26T14:30' },
    });
    expect(await tauriBlockCalendar.patchBlockEvent(moved)).toEqual({
      kind: 'written',
      etag: '"v2"',
    });
    expect(google.requests.at(-1)).toMatchObject({
      method: 'PATCH',
      path: `/calendar/v3/calendars/${encodeURIComponent(CALENDAR)}/events/dfaiblock1`,
      body: {
        start: { dateTime: '2026-10-26T13:00:00' },
        end: { dateTime: '2026-10-26T14:30:00' },
      },
    });
    const changes = await listBlocks(syncToken);
    expect(google.requests.at(-1)?.query.get('syncToken')).toBe(syncToken);
    expect(changes).toMatchObject({
      kind: 'changes',
      events: [{ id: 'dfaiblock1', etag: '"v2"' }],
    });
  });

  it('says an insert whose id is taken (409) exists, so the sync patches it', async () => {
    await tauriBlockCalendar.insertBlockEvent(call());
    expect(await tauriBlockCalendar.insertBlockEvent(call())).toEqual({ kind: 'exists' });
  });

  it('says a patch of an event Google no longer has (404, 410) is gone', async () => {
    expect(await tauriBlockCalendar.patchBlockEvent(call({ eventId: 'never-made' }))).toEqual({
      kind: 'gone',
    });
    google.events.set('dfaiblock1', { id: 'dfaiblock1', status: 'cancelled' });
    expect(await tauriBlockCalendar.patchBlockEvent(call())).toEqual({ kind: 'gone' });
  });

  it('hears of a deletion as a cancelled event', async () => {
    google.events.set('dfaiblock1', { id: 'dfaiblock1', status: 'cancelled', etag: '"v9"' });
    const listed = await listBlocks();
    expect(listed).toMatchObject({
      events: [{ id: 'dfaiblock1', cancelled: true, start: null, etag: '"v9"' }],
    });
  });

  it('reads every page of a listing before it answers', async () => {
    google.scripted.push(
      answer(200, { items: [{ id: 'a', etag: '"1"' }], nextPageToken: 'p1' }),
      answer(200, { items: [{ id: 'b', etag: '"2"' }], nextSyncToken: 'sync-9' }),
    );
    const listed = await listBlocks();
    expect(listed).toMatchObject({
      events: [{ id: 'a' }, { id: 'b' }],
      syncToken: 'sync-9',
      timeZone: null,
    });
    expect(google.requests.at(-1)?.query.get('pageToken')).toBe('p1');
  });
});

describe('tauriBlockCalendar: what goes wrong', () => {
  it('says a sync token Google no longer honours (410) has expired', async () => {
    expect(await listBlocks('sync-stale')).toEqual({ kind: 'expired' });
  });

  it('turns a 401 the host could not renew past, and other refusals, into failures with the status', async () => {
    for (const status of [401, 429, 500]) {
      google.scripted.push(answer(status, { error: { code: status } }));
      expect(await failureOf(tauriBlockCalendar.insertBlockEvent(call()))).toMatchObject({
        kind: 'api_refused',
        code: String(status),
      });
    }
  });

  it('carries a 403 for want of the scope, so the sync waits for the grant to change', async () => {
    google.scripted.push(
      answer(403, {
        error: {
          code: 403,
          message: 'Insufficient Permission',
          errors: [{ reason: 'insufficientPermissions' }],
        },
      }),
    );
    const failure = await failureOf(tauriBlockCalendar.patchBlockEvent(call()));
    expect(isScopeRefusal(failure)).toBe(true);
  });

  it('reports a body that is not JSON, or not an events list, or a write with no id, as malformed', async () => {
    google.scripted.push({ status: 200, body: '<html>' });
    expect(await failureOf(listBlocks())).toMatchObject({ kind: 'malformed' });
    google.scripted.push(answer(200, { items: 'none' }));
    expect(await failureOf(listBlocks())).toMatchObject({ kind: 'malformed' });
    google.scripted.push(answer(200, { etag: '"v1"' }));
    expect(await failureOf(tauriBlockCalendar.insertBlockEvent(call()))).toMatchObject({
      kind: 'malformed',
    });
  });

  it('leaves out an item with no id, and reads an unreadable time as none', async () => {
    google.scripted.push(
      answer(200, {
        items: [{ summary: 'no id' }, { id: 'x', start: { dateTime: '2026-10-26T09:00' } }],
        nextSyncToken: 's',
      }),
    );
    expect(await listBlocks()).toMatchObject({ events: [{ id: 'x', start: null, etag: null }] });
  });

  it('cuts off a server that never stops handing out pages', async () => {
    for (let page = 0; page < 40; page += 1) {
      google.scripted.push(answer(200, { items: [], nextPageToken: `p${page + 1}` }));
    }
    expect(await failureOf(listBlocks())).toMatchObject({ kind: 'malformed' });
  });

  it('passes on a Google that does not answer in time as unreachable', async () => {
    google.stalls = true;
    expect(await failureOf(tauriBlockCalendar.patchBlockEvent(call()))).toMatchObject({
      kind: 'unreachable',
    });
  });

  it('passes on a sign-in Google revoked, as the host reports it', async () => {
    const refused = {
      kind: 'token_refused',
      code: 'invalid_grant',
      message: 'Google refused the refresh token',
    };
    invoke.mockRejectedValueOnce(refused);
    expect(await failureOf(listBlocks())).toEqual(refused);
  });

  it('never calls another calendar, and never deletes', async () => {
    await tauriBlockCalendar.insertBlockEvent(call());
    await tauriBlockCalendar.patchBlockEvent(call());
    await listBlocks();
    expect(google.requests.map((request) => request.method)).toEqual(['POST', 'PATCH', 'GET']);
    expect(
      google.requests.every((request) => request.path.includes(encodeURIComponent(CALENDAR))),
    ).toBe(true);
  });
});
