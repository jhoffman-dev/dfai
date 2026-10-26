import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleCalendarError } from '@dfai/application';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const { tauriGoogleCalendar, googleErrorOf } = await import('./tauri-google-calendar.ts');

const VAULT = '/Users/mara/Vault';
const SCOPES = ['https://www.googleapis.com/auth/calendar.app.created'];
const CLIENT_ID = '1234-fictional.apps.googleusercontent.com';

const answer = (status: number, body: unknown) => ({
  status,
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

describe('tauriGoogleCalendar', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('connects with the vault, client and scopes, and no secret unless typed', async () => {
    invoke.mockResolvedValue({ connected: true, clientId: CLIENT_ID, scopes: SCOPES });
    await tauriGoogleCalendar.connect({ vault: VAULT, clientId: CLIENT_ID, scopes: SCOPES });
    expect(invoke).toHaveBeenCalledWith('google_connect', {
      vault: VAULT,
      clientId: CLIENT_ID,
      scopes: SCOPES,
    });

    await tauriGoogleCalendar.connect({
      vault: VAULT,
      clientId: CLIENT_ID,
      clientSecret: 'GOCSPX-fictional',
      scopes: SCOPES,
    });
    expect(invoke).toHaveBeenLastCalledWith('google_connect', {
      vault: VAULT,
      clientId: CLIENT_ID,
      clientSecret: 'GOCSPX-fictional',
      scopes: SCOPES,
    });
  });

  it('asks status, cancel and disconnect of the host by name', async () => {
    invoke.mockResolvedValue({ revoked: true, shared: false });
    await tauriGoogleCalendar.status({ vault: VAULT });
    await tauriGoogleCalendar.cancelConnect();
    await expect(tauriGoogleCalendar.disconnect({ vault: VAULT })).resolves.toEqual({
      revoked: true,
      shared: false,
    });
    expect(invoke.mock.calls).toEqual([
      ['google_status', { vault: VAULT }],
      ['google_connect_cancel'],
      ['google_disconnect', { vault: VAULT }],
    ]);
  });

  it('lists calendars across every page', async () => {
    invoke
      .mockResolvedValueOnce(
        answer(200, {
          items: [{ id: 'a', summary: 'A', accessRole: 'owner' }],
          nextPageToken: 'p 2',
        }),
      )
      .mockResolvedValueOnce(
        answer(200, { items: [{ id: 'b', summary: 'B', accessRole: 'owner' }] }),
      );

    const listed = await tauriGoogleCalendar.listCalendars({ vault: VAULT });

    expect(listed.map((calendar) => calendar.id)).toEqual(['a', 'b']);
    expect(invoke).toHaveBeenLastCalledWith('google_calendar_request', {
      vault: VAULT,
      call: { method: 'GET', path: '/calendar/v3/users/me/calendarList?pageToken=p%202' },
    });
  });

  it('stops a calendar list that never ends', async () => {
    invoke.mockResolvedValue(answer(200, { items: [], nextPageToken: 'again' }));
    await expect(tauriGoogleCalendar.listCalendars({ vault: VAULT })).rejects.toMatchObject({
      failure: { kind: 'malformed' },
    });
    expect(invoke).toHaveBeenCalledTimes(20);
  });

  it('makes a calendar by name on the zone given, and reads back the one Google made', async () => {
    invoke.mockResolvedValue(answer(200, { id: 'made@example.com', summary: 'DFAI blocks' }));

    const made = await tauriGoogleCalendar.createCalendar({
      vault: VAULT,
      name: 'DFAI blocks',
      timeZone: 'America/Los_Angeles',
    });

    expect(made).toEqual({
      id: 'made@example.com',
      name: 'DFAI blocks',
      primary: false,
      owned: true,
    });
    expect(invoke).toHaveBeenCalledWith('google_calendar_request', {
      vault: VAULT,
      call: {
        method: 'POST',
        path: '/calendar/v3/calendars',
        body: '{"summary":"DFAI blocks","timeZone":"America/Los_Angeles"}',
      },
    });
  });

  it('reports an API error status as refused, with the status as its code', async () => {
    invoke.mockResolvedValue(answer(403, { error: { code: 403 } }));
    await expect(tauriGoogleCalendar.listCalendars({ vault: VAULT })).rejects.toMatchObject({
      failure: { kind: 'api_refused', code: '403' },
    });
  });

  it('reports an answer that is not JSON, or not a calendar, as malformed', async () => {
    invoke.mockResolvedValueOnce(answer(200, '<html>'));
    await expect(tauriGoogleCalendar.listCalendars({ vault: VAULT })).rejects.toMatchObject({
      failure: { kind: 'malformed' },
    });
    invoke.mockResolvedValueOnce(answer(200, { summary: 'no id' }));
    await expect(
      tauriGoogleCalendar.createCalendar({ vault: VAULT, name: 'DFAI blocks', timeZone: 'UTC' }),
    ).rejects.toMatchObject({ failure: { kind: 'malformed' } });
  });

  it('turns the host’s failure into the app’s error, keeping its kind and code', async () => {
    invoke.mockRejectedValue({ kind: 'refused', code: 'access_denied', message: 'no' });
    const refused = tauriGoogleCalendar.connect({
      vault: VAULT,
      clientId: CLIENT_ID,
      scopes: SCOPES,
    });
    await expect(refused).rejects.toBeInstanceOf(GoogleCalendarError);
    await expect(refused).rejects.toMatchObject({
      failure: { kind: 'refused', code: 'access_denied', message: 'no' },
    });
  });
});

describe('googleErrorOf', () => {
  it('makes anything the host did not build a request that could not be made', () => {
    expect(googleErrorOf('invalid args `vault`').failure).toEqual({
      kind: 'invalid',
      message: 'invalid args `vault`',
    });
    expect(googleErrorOf({ kind: 'not_a_kind', message: 'x' }).failure.kind).toBe('invalid');
  });
});
