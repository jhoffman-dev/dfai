import { describe, expect, it, vi } from 'vitest';
import type { GoogleCalendar } from '@dfai/domain';
import { createSettingsWriter } from '../settings/index.ts';
import { jsonMarkdown, vaultWith } from '../testing/settings-vault.ts';
import {
  allowGoogleBlocks,
  allowGoogleMeetings,
  blockCalendars,
  connectGoogleCalendar,
  createBlocksCalendar,
  disconnectGoogleCalendar,
  googleProblemOf,
  loadGoogleCalendarSetting,
  saveBlocksEnabled,
  saveGoogleCalendarSetting,
  saveMeetingsEnabled,
} from './google-calendar.ts';
import { GoogleCalendarError, type GoogleCalendarPort } from './ports.ts';

const VAULT = '/Users/mara/Vault';
const CLIENT_ID = '123456789012-abcdef0123456789abcdef0123456789.apps.googleusercontent.com';
const SETTINGS = '.atlas/settings.md';

const calendar = (name: string, overrides: Partial<GoogleCalendar> = {}): GoogleCalendar => ({
  id: `${name.toLowerCase().replace(/ /g, '-')}@group.calendar.example.com`,
  name,
  primary: false,
  owned: true,
  ...overrides,
});

function fakePort(overrides: Partial<GoogleCalendarPort> = {}): GoogleCalendarPort {
  return {
    status: vi.fn(async () => ({ connected: false, clientId: null, scopes: [] })),
    connect: vi.fn(async ({ clientId, scopes }) => ({ connected: true, clientId, scopes })),
    cancelConnect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => ({ revoked: true, shared: false })),
    listCalendars: vi.fn(async () => []),
    createCalendar: vi.fn(async ({ name }) => calendar(name)),
    ...overrides,
  };
}

describe('connectGoogleCalendar', () => {
  it('asks the host for DFAI’s one scope with the client typed, trimmed', async () => {
    const port = fakePort();

    await connectGoogleCalendar({
      port,
      vault: VAULT,
      clientId: ` ${CLIENT_ID} `,
      clientSecret: '',
    });

    expect(port.connect).toHaveBeenCalledWith({
      vault: VAULT,
      clientId: CLIENT_ID,
      scopes: ['https://www.googleapis.com/auth/calendar.app.created'],
    });
  });

  it('sends a client secret only when one was typed', async () => {
    const port = fakePort();

    await connectGoogleCalendar({
      port,
      vault: VAULT,
      clientId: CLIENT_ID,
      clientSecret: ' GOCSPX-fictional \n',
    });

    expect(port.connect).toHaveBeenCalledWith(
      expect.objectContaining({ clientSecret: 'GOCSPX-fictional' }),
    );
  });

  it('refuses what is not a client ID before the browser is opened', async () => {
    const port = fakePort();

    const refused = connectGoogleCalendar({
      port,
      vault: VAULT,
      clientId: 'GOCSPX-pasted-the-secret',
      clientSecret: '',
    });

    await expect(refused).rejects.toBeInstanceOf(GoogleCalendarError);
    await expect(refused).rejects.toMatchObject({ failure: { kind: 'invalid' } });
    expect(port.connect).not.toHaveBeenCalled();
  });
});

describe('blockCalendars', () => {
  it('lists only the calendars blocks may go to, by name', async () => {
    const port = fakePort({
      listCalendars: async () => [
        calendar('Zeta'),
        calendar('Mara Quill', { primary: true }),
        calendar('Team', { owned: false }),
        calendar('DFAI blocks'),
      ],
    });

    const listed = await blockCalendars({ port, vault: VAULT });

    expect(listed.map((each) => each.name)).toEqual(['DFAI blocks', 'Zeta']);
  });
});

describe('createBlocksCalendar', () => {
  it('makes the calendar under DFAI’s name for it, on the person’s zone', async () => {
    const port = fakePort();

    const made = await createBlocksCalendar({ port, vault: VAULT, timeZone: 'America/Chicago' });

    expect(port.createCalendar).toHaveBeenCalledWith({
      vault: VAULT,
      name: 'DFAI blocks',
      timeZone: 'America/Chicago',
    });
    expect(made.name).toBe('DFAI blocks');
  });
});

describe('disconnectGoogleCalendar', () => {
  it('has nothing more to say once Google revoked the sign-in', async () => {
    expect(await disconnectGoogleCalendar({ port: fakePort(), vault: VAULT })).toBeNull();
  });

  it('says what is left to do when Google could not be told', async () => {
    const port = fakePort({ disconnect: async () => ({ revoked: false, shared: false }) });

    const left = await disconnectGoogleCalendar({ port, vault: VAULT });

    expect(left?.problem).toMatch(/could not tell Google/);
    expect(left?.fix).toMatch(/Google Account/);
  });
});

describe('disconnectGoogleCalendar, with a client another vault shares', () => {
  it('says the sign-in was forgotten here and not revoked, and how to end it', async () => {
    const port = fakePort({ disconnect: async () => ({ revoked: false, shared: true }) });

    const left = await disconnectGoogleCalendar({ port, vault: VAULT });

    expect(left?.problem).toMatch(/another vault on this Mac/);
    expect(left?.fix).toMatch(/disconnect the other vault/);
  });
});

describe('googleProblemOf', () => {
  it('explains a Google failure through the domain’s rules', () => {
    const problem = googleProblemOf(
      new GoogleCalendarError({ kind: 'token_refused', code: 'invalid_grant', message: 'no' }),
    );
    expect(problem.problem).toMatch(/expired or was revoked/);
  });

  it('passes anything else on as its message', () => {
    expect(googleProblemOf(new Error('the vault was switched'))).toEqual({
      problem: 'the vault was switched',
      fix: null,
    });
  });
});

describe('the Google Calendar setting', () => {
  it('reads unset from a vault that has said nothing', async () => {
    const { fs } = vaultWith({});
    expect(await loadGoogleCalendarSetting({ fs, markdown: jsonMarkdown() })).toEqual({
      clientId: null,
      calendarId: null,
    });
  });

  it('writes the client and calendar beside the other settings, and reads them back', async () => {
    const { fs, written } = vaultWith({ [SETTINGS]: '---\n{"theme":"dark"}\n---\n' });
    const markdown = jsonMarkdown();
    const setting = { clientId: CLIENT_ID, calendarId: 'atlas-blocks@group.calendar.example.com' };

    await saveGoogleCalendarSetting({ settings: createSettingsWriter({ fs, markdown }), setting });

    expect(written[SETTINGS]).toContain('"theme":"dark"');
    expect(await loadGoogleCalendarSetting({ fs, markdown })).toEqual(setting);
  });
});

describe('allowGoogleMeetings (ADR-0046)', () => {
  const BLOCKS = 'https://www.googleapis.com/auth/calendar.app.created';
  const READ_EVENTS = 'https://www.googleapis.com/auth/calendar.events.readonly';

  it('asks once more for the read-only scope, on top of what was allowed, with the same client', async () => {
    const port = fakePort({
      status: vi.fn(async () => ({ connected: true, clientId: CLIENT_ID, scopes: [BLOCKS] })),
    });
    const connection = await allowGoogleMeetings({ port, vault: VAULT });
    expect(port.connect).toHaveBeenCalledWith({
      vault: VAULT,
      clientId: CLIENT_ID,
      scopes: [BLOCKS, READ_EVENTS],
    });
    expect(connection.scopes).toEqual([BLOCKS, READ_EVENTS]);
  });

  it('asks nothing when reading meetings is allowed already', async () => {
    const allowed = { connected: true, clientId: CLIENT_ID, scopes: [BLOCKS, READ_EVENTS] };
    const port = fakePort({ status: vi.fn(async () => allowed) });
    expect(await allowGoogleMeetings({ port, vault: VAULT })).toEqual(allowed);
    expect(port.connect).not.toHaveBeenCalled();
  });

  it('refuses before any consent screen when the vault is not connected', async () => {
    const port = fakePort();
    const refusal = await allowGoogleMeetings({ port, vault: VAULT }).catch(
      (cause: unknown) => cause,
    );
    expect(refusal).toBeInstanceOf(GoogleCalendarError);
    expect((refusal as GoogleCalendarError).failure.kind).toBe('not_connected');
    expect(port.connect).not.toHaveBeenCalled();
  });
});

describe('saveMeetingsEnabled', () => {
  it('writes the vault’s meetings switch, and takes it off rather than writing false', async () => {
    const { fs, written } = vaultWith({ [SETTINGS]: '---\n{"google_client_id":"kept"}\n---\n' });
    const markdown = jsonMarkdown();
    const settings = createSettingsWriter({ fs, markdown });
    await saveMeetingsEnabled({ settings, enabled: true });
    expect(written[SETTINGS]).toContain('"google_meetings":true');
    expect(written[SETTINGS]).toContain('"google_client_id":"kept"');
    await saveMeetingsEnabled({ settings, enabled: false });
    expect(written[SETTINGS]).not.toContain('"google_meetings":true');
  });
});

describe('allowGoogleBlocks (#30)', () => {
  const BLOCKS = 'https://www.googleapis.com/auth/calendar.app.created';
  const READ_EVENTS = 'https://www.googleapis.com/auth/calendar.events.readonly';

  it('asks nothing when the sign-in already reaches DFAI’s own calendar', async () => {
    const allowed = { connected: true, clientId: CLIENT_ID, scopes: [BLOCKS] };
    const port = fakePort({ status: vi.fn(async () => allowed) });
    expect(await allowGoogleBlocks({ port, vault: VAULT })).toEqual(allowed);
    expect(port.connect).not.toHaveBeenCalled();
  });

  it('asks again for DFAI’s calendar scope on top of what was allowed, and nothing broader', async () => {
    const port = fakePort({
      status: vi.fn(async () => ({ connected: true, clientId: CLIENT_ID, scopes: [READ_EVENTS] })),
    });
    await allowGoogleBlocks({ port, vault: VAULT });
    expect(port.connect).toHaveBeenCalledWith({
      vault: VAULT,
      clientId: CLIENT_ID,
      scopes: [READ_EVENTS, BLOCKS],
    });
  });

  it('refuses before any consent screen when the vault is not connected', async () => {
    const port = fakePort();
    const refusal = await allowGoogleBlocks({ port, vault: VAULT }).catch(
      (cause: unknown) => cause,
    );
    expect((refusal as GoogleCalendarError).failure.kind).toBe('not_connected');
    expect((refusal as GoogleCalendarError).message).toContain('then sync blocks');
  });
});

describe('saveBlocksEnabled', () => {
  it('writes the vault’s block sync switch, and takes it off rather than writing false', async () => {
    const { fs, written } = vaultWith({ [SETTINGS]: '---\n{"google_client_id":"kept"}\n---\n' });
    const settings = createSettingsWriter({ fs, markdown: jsonMarkdown() });
    await saveBlocksEnabled({ settings, enabled: true, rng: { next: () => 0.5 } });
    expect(written[SETTINGS]).toContain('"google_blocks":true');
    expect(written[SETTINGS]).toContain('"google_client_id":"kept"');
    await saveBlocksEnabled({ settings, enabled: false, rng: { next: () => 0.5 } });
    expect(written[SETTINGS]).not.toContain('"google_blocks":true');
  });

  it('turned on, gives the vault its own id when it has none, and never replaces one', async () => {
    const { fs, written } = vaultWith({ [SETTINGS]: '---\n{"google_client_id":"kept"}\n---\n' });
    const settings = createSettingsWriter({ fs, markdown: jsonMarkdown() });
    await saveBlocksEnabled({ settings, enabled: true, rng: { next: () => 0.5 } });
    expect(written[SETTINGS]).toContain('"vault_id":"gggggggggggggggg"');
    await saveBlocksEnabled({ settings, enabled: false, rng: { next: () => 0 } });
    await saveBlocksEnabled({ settings, enabled: true, rng: { next: () => 0 } });
    expect(written[SETTINGS]).toContain('"vault_id":"gggggggggggggggg"');
    expect(written[SETTINGS]).toContain('"google_blocks":true');
  });
});
