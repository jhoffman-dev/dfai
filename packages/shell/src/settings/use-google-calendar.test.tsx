// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  fakeGoogleCalendar,
  fakeVaultFs,
  GoogleCalendarError,
  recordingActivity,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { useGoogleCalendar } from './use-google-calendar.ts';
import { GoogleCalendarSettingsCard } from './google-calendar-settings-card.tsx';
import { queryWrapper } from '../reads/query-wrapper.tsx';

const ACTIVITY = recordingActivity();

const SETTINGS = '.atlas/settings.md';
const VAULT = '/Users/mara/Vault';
const CLIENT_ID = '123456789012-abcdef0123456789abcdef0123456789.apps.googleusercontent.com';

/** A vault whose settings note is held in memory and written back as the host would. */
function vaultWithSettings(text = '---\ntheme: dark\n---\n') {
  const file = { text, modified: 1 };
  const fs = fakeVaultFs({
    readNotes: async () => [{ path: SETTINGS, text: file.text, modified: file.modified, size: 1 }],
    readTextFile: async () => ({ text: file.text, modified: file.modified }),
    writeTextFile: async ({ contents }) => {
      file.text = contents;
      file.modified += 1;
      return file.modified;
    },
  });
  return { fs, file };
}

function renderGoogle({
  google = fakeGoogleCalendar(),
  vault = vaultWithSettings(),
  active = true,
}: {
  google?: ReturnType<typeof fakeGoogleCalendar>;
  vault?: ReturnType<typeof vaultWithSettings>;
  active?: boolean;
} = {}) {
  const hook = renderHook(
    ({ open }: { open: boolean }) =>
      useGoogleCalendar({
        port: google.port,
        fs: vault.fs,
        markdown: remarkMarkdown,
        vault: VAULT,
        active: open,
        activity: ACTIVITY,
        meetingsWrittenHere: true,
      }),
    { wrapper: queryWrapper().wrapper, initialProps: { open: active } },
  );
  return { hook, google, vault };
}

describe('useGoogleCalendar', () => {
  it('asks the host nothing until Settings is open', async () => {
    const { hook } = renderGoogle({ active: false });
    await act(async () => undefined);
    expect(hook.result.current.view.phase).toBe('loading');

    hook.rerender({ open: true });
    await waitFor(() => expect(hook.result.current.view.phase).toBe('disconnected'));
  });

  it('connects, keeps the client in the vault’s settings, and offers to make the calendar', async () => {
    const { hook, vault, google } = renderGoogle();
    await waitFor(() => expect(hook.result.current.view.phase).toBe('disconnected'));

    act(() => hook.result.current.connect({ clientId: ` ${CLIENT_ID} `, clientSecret: '' }));

    await waitFor(() => expect(hook.result.current.view.phase).toBe('connected'));
    expect(google.connected.get(VAULT)?.clientId).toBe(CLIENT_ID);
    await waitFor(() => expect(vault.file.text).toContain(`google_client_id: ${CLIENT_ID}`));
    expect(vault.file.text).toContain('theme: dark');
    expect(hook.result.current.view.canCreate).toBe(true);
  });

  it('makes DFAI’s calendar and sends blocks to it', async () => {
    const google = fakeGoogleCalendar();
    google.connected.set(VAULT, { connected: true, clientId: CLIENT_ID, scopes: [] });
    const { hook, vault } = renderGoogle({ google });
    await waitFor(() => expect(hook.result.current.view.phase).toBe('connected'));

    act(() => hook.result.current.create());

    await waitFor(() =>
      expect(hook.result.current.view.chosen).toBe('dfai-blocks@group.calendar.example.com'),
    );
    expect(vault.file.text).toContain('google_calendar: dfai-blocks@group.calendar.example.com');
    expect(hook.result.current.view.canCreate).toBe(false);
  });

  it('shows a refused consent with its fix, and stays disconnected', async () => {
    const google = fakeGoogleCalendar();
    google.state.next = new GoogleCalendarError({
      kind: 'refused',
      code: 'access_denied',
      message: 'Google did not let DFAI in',
    });
    const { hook } = renderGoogle({ google });
    await waitFor(() => expect(hook.result.current.view.phase).toBe('disconnected'));

    act(() => hook.result.current.connect({ clientId: CLIENT_ID, clientSecret: '' }));

    await waitFor(() => expect(hook.result.current.view.problem?.fix).toMatch(/choose Allow/));
    expect(hook.result.current.view.phase).toBe('disconnected');
  });

  it('refuses a client that is not one, without asking the host', async () => {
    const { hook, google } = renderGoogle();
    await waitFor(() => expect(hook.result.current.view.phase).toBe('disconnected'));

    act(() => hook.result.current.connect({ clientId: 'not-a-client', clientSecret: '' }));

    await waitFor(() =>
      expect(hook.result.current.view.problem?.problem).toMatch(/not a Google OAuth client ID/),
    );
    expect(google.connected.size).toBe(0);
  });

  it('says what is left to do when Google could not be told of a disconnect', async () => {
    const google = fakeGoogleCalendar();
    google.connected.set(VAULT, { connected: true, clientId: CLIENT_ID, scopes: [] });
    google.state.revoked = false;
    const { hook } = renderGoogle({ google });
    await waitFor(() => expect(hook.result.current.view.phase).toBe('connected'));

    act(() => hook.result.current.disconnect());

    await waitFor(() => expect(hook.result.current.view.phase).toBe('disconnected'));
    expect(hook.result.current.view.problem?.problem).toMatch(/could not tell Google/);
  });

  it('passes a cancel on to the host', async () => {
    const { hook, google } = renderGoogle();
    act(() => hook.result.current.cancel());
    await waitFor(() => expect(google.state.cancels).toBe(1));
  });
});

describe('GoogleCalendarSettingsCard', () => {
  it('lists the dedicated calendar once connected, and disconnects from the card', async () => {
    const google = fakeGoogleCalendar([
      {
        id: 'dfai-blocks@group.calendar.example.com',
        name: 'DFAI blocks',
        primary: false,
        owned: true,
      },
      { id: 'mara@example.com', name: 'Mara Quill', primary: true, owned: true },
    ]);
    google.connected.set(VAULT, { connected: true, clientId: CLIENT_ID, scopes: [] });
    const vault = vaultWithSettings(
      '---\ngoogle_calendar: dfai-blocks@group.calendar.example.com\n---\n',
    );
    function Card() {
      const setting = useGoogleCalendar({
        port: google.port,
        fs: vault.fs,
        markdown: remarkMarkdown,
        vault: VAULT,
        active: true,
        activity: ACTIVITY,
        meetingsWrittenHere: true,
      });
      return <GoogleCalendarSettingsCard setting={setting} />;
    }
    render(<Card />, { wrapper: queryWrapper().wrapper });

    expect(await screen.findByText('Connected. Blocks go to DFAI blocks.')).not.toBeNull();
    // Their main calendar is never offered for blocks.
    expect(screen.queryByRole('option', { name: 'Mara Quill' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Disconnect…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

    expect(await screen.findByRole('form', { name: 'Connect Google Calendar' })).not.toBeNull();
    expect(google.connected.size).toBe(0);
  });
});

describe('useGoogleCalendar: meetings (ADR-0046)', () => {
  const BLOCKS = 'https://www.googleapis.com/auth/calendar.app.created';
  const READ_EVENTS = 'https://www.googleapis.com/auth/calendar.events.readonly';

  function renderWithMeetings({ writesHere = true }: { writesHere?: boolean } = {}) {
    const google = fakeGoogleCalendar();
    google.connected.set(VAULT, { connected: true, clientId: CLIENT_ID, scopes: [BLOCKS] });
    const vault = vaultWithSettings(`---\ngoogle_client_id: ${CLIENT_ID}\n---\n`);
    const syncs: string[] = [];
    const meetingSync = {
      enabled: false,
      syncing: false,
      report: null,
      lastSyncAt: null,
      syncNow: () => void syncs.push('sync'),
      stop: () => void syncs.push('stop'),
    };
    const hook = renderHook(
      () =>
        useGoogleCalendar({
          port: google.port,
          fs: vault.fs,
          markdown: remarkMarkdown,
          vault: VAULT,
          active: true,
          activity: ACTIVITY,
          meetingSync,
          meetingsWrittenHere: writesHere,
        }),
      { wrapper: queryWrapper().wrapper },
    );
    return { hook, google, vault, syncs };
  }

  it('is off until allowed; allowing asks this Mac’s consent for reading events, then turns the vault on', async () => {
    const { hook, google, vault } = renderWithMeetings();
    await waitFor(() => expect(hook.result.current.view.meetings?.state).toBe('off'));

    act(() => hook.result.current.meetings.onAllow());

    await waitFor(() => expect(vault.file.text).toContain('google_meetings: true'));
    expect(google.connected.get(VAULT)).toEqual({
      connected: true,
      clientId: CLIENT_ID,
      scopes: [BLOCKS, READ_EVENTS],
    });
    await waitFor(() => expect(hook.result.current.view.meetings?.state).toBe('on'));
  });

  it('stops by turning the vault’s switch off, keeping the sign-in', async () => {
    const { hook, vault, google, syncs } = renderWithMeetings();
    await waitFor(() => expect(hook.result.current.view.meetings).not.toBeNull());
    act(() => hook.result.current.meetings.onAllow());
    await waitFor(() => expect(vault.file.text).toContain('google_meetings: true'));

    act(() => hook.result.current.meetings.onStop());

    await waitFor(() => expect(vault.file.text).not.toContain('google_meetings'));
    expect(google.connected.get(VAULT)?.connected).toBe(true);
    expect(syncs).toContain('stop');
  });

  it('ends a sync under way before the switch is written', async () => {
    const { hook, syncs, vault } = renderWithMeetings();
    await waitFor(() => expect(hook.result.current.view.meetings).not.toBeNull());
    act(() => hook.result.current.meetings.onStop());
    expect(syncs).toEqual(['stop']);
    await waitFor(() => expect(vault.file.text).not.toContain('google_meetings: true'));
  });

  it('says another Mac writes the notes when this one does not run the automations', async () => {
    const { hook } = renderWithMeetings({ writesHere: false });
    act(() => hook.result.current.meetings.onAllow());
    await waitFor(() => expect(hook.result.current.view.meetings?.state).toBe('elsewhere'));
  });
});
