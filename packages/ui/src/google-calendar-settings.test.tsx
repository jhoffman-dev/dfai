// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  GoogleCalendarSettings,
  type GoogleCalendarView,
  type GoogleMeetingsView,
} from './google-calendar-settings.tsx';

const CLIENT_ID = '1234-fictional.apps.googleusercontent.com';

const BLOCKS = { id: 'atlas-blocks@group.calendar.example.com', name: 'DFAI blocks' };

function renderWith(overrides: Partial<GoogleCalendarView> = {}) {
  const view: GoogleCalendarView = {
    phase: 'disconnected',
    clientId: '',
    calendars: [],
    chosen: null,
    canCreate: true,
    calendarName: 'DFAI blocks',
    problem: null,
    pending: false,
    meetings: null,
    ...overrides,
  };
  const handlers = {
    onConnect: vi.fn(),
    onCancel: vi.fn(),
    onDisconnect: vi.fn(),
    onChoose: vi.fn(),
    onCreate: vi.fn(),
  };
  render(<GoogleCalendarSettings view={view} {...handlers} />);
  return handlers;
}

const card = () => screen.getByRole('region', { name: 'Google Calendar' });
const button = (name: string | RegExp) => within(card()).getByRole('button', { name });
const queryButton = (name: string | RegExp) => within(card()).queryByRole('button', { name });

describe('GoogleCalendarSettings', () => {
  it('asks for a client while disconnected, starting from the one the vault keeps', async () => {
    const { onConnect } = renderWith({ clientId: CLIENT_ID });

    const client = within(card()).getByRole<HTMLInputElement>('textbox', {
      name: 'OAuth client ID',
    });
    expect(client.value).toBe(CLIENT_ID);
    await userEvent.type(within(card()).getByLabelText('Client secret, if Google issued one'), 'S');
    await userEvent.click(button('Connect'));

    expect(onConnect).toHaveBeenCalledWith({ clientId: CLIENT_ID, clientSecret: 'S' });
    expect(queryButton(/Disconnect/)).toBeNull();
  });

  it('cannot connect without a client ID', () => {
    renderWith();
    expect(button('Connect')).toHaveProperty('disabled', true);
  });

  it('keeps the client secret masked, and empties it once handed on', async () => {
    renderWith({ clientId: CLIENT_ID });
    const secret = within(card()).getByLabelText<HTMLInputElement>(
      'Client secret, if Google issued one',
    );
    expect(secret.type).toBe('password');
    await userEvent.type(secret, 'GOCSPX-fictional');
    await userEvent.click(button('Connect'));
    expect(secret.value).toBe('');
  });

  it('waits on the browser with a way to cancel', async () => {
    const { onCancel } = renderWith({ phase: 'connecting' });

    expect(within(card()).getByText('Finish signing in in your browser…')).not.toBeNull();
    expect(queryButton('Connect')).toBeNull();
    await userEvent.click(button('Cancel'));

    expect(onCancel).toHaveBeenCalled();
  });

  it('once connected, says where blocks go and lets another calendar be chosen', async () => {
    const other = { id: 'other@example.com', name: 'Deep work' };
    const { onChoose } = renderWith({
      phase: 'connected',
      calendars: [BLOCKS, other],
      chosen: BLOCKS.id,
      canCreate: false,
    });

    expect(within(card()).getByText('Connected. Blocks go to DFAI blocks.')).not.toBeNull();
    expect(queryButton(/Create/)).toBeNull();
    await userEvent.selectOptions(
      within(card()).getByRole('combobox', { name: 'Calendar for blocks' }),
      other.id,
    );

    expect(onChoose).toHaveBeenCalledWith(other.id);
  });

  it('offers to make DFAI’s calendar when there is none to choose', async () => {
    const { onCreate } = renderWith({ phase: 'connected', calendars: [], canCreate: true });

    expect(within(card()).getByText('Connected. Choose the calendar blocks go to.')).not.toBeNull();
    expect(within(card()).queryByRole('combobox')).toBeNull();
    await userEvent.click(button('Create “DFAI blocks”'));

    expect(onCreate).toHaveBeenCalled();
  });

  it('disconnects only once it is confirmed, saying what is kept', async () => {
    const { onDisconnect } = renderWith({ phase: 'connected', calendars: [BLOCKS] });

    await userEvent.click(button('Disconnect…'));
    const confirm = within(card()).getByRole('group', { name: 'Disconnect Google Calendar?' });
    expect(within(confirm).getByText(/calendar and its events stay/)).not.toBeNull();
    expect(onDisconnect).not.toHaveBeenCalled();
    await userEvent.click(within(confirm).getByRole('button', { name: 'Disconnect' }));

    expect(onDisconnect).toHaveBeenCalled();
  });

  it('shows a problem with its fix', () => {
    renderWith({
      problem: {
        problem: 'Google no longer accepts DFAI’s sign-in: it expired or was revoked.',
        fix: 'Connect again in Settings → Google Calendar.',
      },
    });

    const alert = within(card()).getByRole('alert');
    expect(within(alert).getByText(/expired or was revoked/)).not.toBeNull();
    expect(within(alert).getByText('Connect again in Settings → Google Calendar.')).not.toBeNull();
  });

  it('shows no alert when nothing is wrong, and holds its buttons while busy', () => {
    renderWith({ phase: 'connected', calendars: [BLOCKS], pending: true });
    expect(within(card()).queryByRole('alert')).toBeNull();
    expect(button('Disconnect…')).toHaveProperty('disabled', true);
    expect(button('Create “DFAI blocks”')).toHaveProperty('disabled', true);
  });

  it('says it is checking before the host has answered', () => {
    renderWith({ phase: 'loading' });
    expect(within(card()).getByText('Checking…')).not.toBeNull();
    expect(queryButton('Connect')).toBeNull();
  });
});

describe('GoogleCalendarSettings: meetings (ADR-0046)', () => {
  const meetings = (overrides: Partial<GoogleMeetingsView> = {}): GoogleMeetingsView => ({
    state: 'off',
    syncing: false,
    lastSynced: null,
    problem: null,
    ...overrides,
  });

  function renderMeetings(view: GoogleMeetingsView, more: Partial<GoogleCalendarView> = {}) {
    const actions = { onAllow: vi.fn(), onSync: vi.fn(), onStop: vi.fn() };
    render(
      <GoogleCalendarSettings
        view={{
          phase: 'connected',
          clientId: CLIENT_ID,
          calendars: [BLOCKS],
          chosen: BLOCKS.id,
          canCreate: false,
          calendarName: 'DFAI blocks',
          problem: null,
          pending: false,
          meetings: view,
          ...more,
        }}
        onConnect={vi.fn()}
        onCancel={vi.fn()}
        onDisconnect={vi.fn()}
        onChoose={vi.fn()}
        onCreate={vi.fn()}
        meetings={actions}
      />,
    );
    return actions;
  }

  const part = () => within(card()).getByRole('group', { name: 'Meetings' });

  it('offers to allow reading meetings while they are off, and nothing else', async () => {
    const { onAllow } = renderMeetings(meetings());
    expect(part().textContent).toContain('Today’s meetings are not read.');
    expect(within(part()).queryByRole('button', { name: 'Stop reading meetings' })).toBeNull();
    await userEvent.click(within(part()).getByRole('button', { name: 'Allow reading meetings' }));
    expect(onAllow).toHaveBeenCalledTimes(1);
  });

  it('asks this Mac to allow it when the vault reads meetings and this sign-in may not', () => {
    renderMeetings(meetings({ state: 'consent' }));
    expect(part().textContent).toContain('this Mac has not been allowed to read your calendar yet');
    expect(
      (within(part()).getByRole('button', { name: 'Allow reading meetings' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      (within(part()).getByRole('button', { name: 'Stop reading meetings' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it('says when meetings were last read, and reads them now or stops on asking', async () => {
    const { onSync, onStop } = renderMeetings(meetings({ state: 'on', lastSynced: '9:41 AM' }));
    expect(part().textContent).toContain('last read at 9:41 AM');
    expect(within(part()).queryByRole('button', { name: 'Allow reading meetings' })).toBeNull();
    await userEvent.click(within(part()).getByRole('button', { name: 'Read meetings now' }));
    await userEvent.click(within(part()).getByRole('button', { name: 'Stop reading meetings' }));
    expect(onSync).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('does not read twice at once, and says what stopped the last read', () => {
    renderMeetings(
      meetings({
        state: 'on',
        syncing: true,
        problem: {
          problem: 'Google could not be reached: offline.',
          fix: 'Check the connection and try again.',
        },
      }),
    );
    expect(part().textContent).toContain('Reading your meetings…');
    expect(
      (within(part()).getByRole('button', { name: 'Read meetings now' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(within(part()).getByRole('alert').textContent).toContain(
      'Google could not be reached: offline.',
    );
  });

  it('says another Mac writes the notes, offering only to stop, when this one does not', () => {
    renderMeetings(meetings({ state: 'elsewhere' }));
    expect(part().textContent).toContain('written on the Mac that runs its automations');
    expect(part().textContent).toContain('never asks Google for them');
    expect(within(part()).queryByRole('button', { name: 'Allow reading meetings' })).toBeNull();
    expect(within(part()).queryByRole('button', { name: 'Read meetings now' })).toBeNull();
    expect(within(part()).getByRole('button', { name: 'Stop reading meetings' })).toBeTruthy();
  });

  it('says stopping is at once on this Mac, later on the other, and that Google keeps the permission until Disconnect', () => {
    renderMeetings(meetings({ state: 'on' }));
    expect(part().textContent).toContain('Stopping takes effect at once on this Mac');
    expect(part().textContent).toContain('once sync brings the change there');
    expect(part().textContent).not.toContain('on both Macs');
    expect(part().textContent).toContain('until you disconnect');
  });

  it('says nothing of stopping while meetings are off', () => {
    renderMeetings(meetings());
    expect(part().textContent).not.toContain('Stopping takes effect at once');
  });

  it('is not drawn where meetings are not offered', () => {
    renderMeetings(meetings(), { meetings: null });
    expect(within(card()).getByRole('button', { name: 'Disconnect…' })).toBeTruthy();
    expect(within(card()).queryByRole('group', { name: 'Meetings' })).toBeNull();
  });

  it('is not drawn before connecting', () => {
    renderMeetings(meetings(), { phase: 'disconnected' });
    expect(within(card()).getByRole('form', { name: 'Connect Google Calendar' })).toBeTruthy();
    expect(within(card()).queryByRole('group', { name: 'Meetings' })).toBeNull();
  });
});
