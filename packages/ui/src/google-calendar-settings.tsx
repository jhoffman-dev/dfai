import { useState, type FormEvent } from 'react';
import { SettingsSection } from './settings-section.tsx';
import { SETTINGS_SECTIONS } from './settings-section-links.ts';

/** Where the connection is: being checked, absent, waiting on the browser, or made. */
export type GoogleCalendarPhase = 'loading' | 'disconnected' | 'connecting' | 'connected';

/** A calendar blocks may go to, as the card lists it. */
export interface GoogleCalendarChoice {
  readonly id: string;
  readonly name: string;
}

/** What went wrong, and what to do about it; the application words both. */
export interface GoogleCalendarProblem {
  readonly problem: string;
  readonly fix: string | null;
}

/**
 * Whether today's meetings are read from the calendar (ADR-0046): `off` for
 * the vault, `consent` when the vault reads them but this Mac's sign-in has
 * not been allowed to yet, `on` when they are being read.
 */
export type GoogleMeetingsState = 'off' | 'consent' | 'on';

/** The meetings part of the card. */
export interface GoogleMeetingsView {
  readonly state: GoogleMeetingsState;
  readonly syncing: boolean;
  /** When this Mac last finished a sync, as the card shows it (`9:41 AM`); null before one. */
  readonly lastSynced: string | null;
  readonly problem: GoogleCalendarProblem | null;
}

/** Settings → Google Calendar as the card draws it. */
export interface GoogleCalendarView {
  readonly phase: GoogleCalendarPhase;
  /** The client ID the vault's settings keep; empty when none. */
  readonly clientId: string;
  readonly calendars: readonly GoogleCalendarChoice[];
  /** The calendar blocks go to, while it is listed. */
  readonly chosen: string | null;
  /** Whether to offer to make DFAI's calendar. */
  readonly canCreate: boolean;
  /** The name DFAI gives the calendar it makes. */
  readonly calendarName: string;
  readonly problem: GoogleCalendarProblem | null;
  readonly pending: boolean;
  /** Today's meetings, once connected; null where they are not offered. */
  readonly meetings: GoogleMeetingsView | null;
}

/** What the meetings part can ask for. */
export interface GoogleMeetingsActions {
  readonly onAllow: () => void;
  readonly onSync: () => void;
  readonly onStop: () => void;
}

/** What a sign-in is asked for with: a client, and its secret when Google issued one. */
export interface GoogleConnectRequest {
  readonly clientId: string;
  readonly clientSecret: string;
}

/**
 * Settings → Google Calendar: connect and disconnect, and the one calendar
 * blocks go to. A client secret is typed into a masked field and handed on;
 * no token ever reaches this card, so there is none to show.
 */
export function GoogleCalendarSettings({
  view,
  onConnect,
  onCancel,
  onDisconnect,
  onChoose,
  onCreate,
  meetings = NO_MEETINGS_ACTIONS,
}: {
  view: GoogleCalendarView;
  onConnect: (request: GoogleConnectRequest) => void;
  onCancel: () => void;
  onDisconnect: () => void;
  onChoose: (calendarId: string) => void;
  onCreate: () => void;
  meetings?: GoogleMeetingsActions;
}) {
  return (
    <SettingsSection section={SETTINGS_SECTIONS.googleCalendar}>
      <p className="settings__lede">
        Blocks show as busy on a calendar of their own on your Google account. You sign in in your
        browser; the sign-in stays in this Mac’s Keychain, and DFAI can only see and change
        calendars it made — and, if you allow it, read your meetings, never change them.
      </p>
      {view.phase === 'loading' && <p className="settings__lede">Checking…</p>}
      {view.phase === 'disconnected' && (
        <ConnectForm
          // Started again when the vault's settings are read, so the kept client shows.
          key={view.clientId}
          clientId={view.clientId}
          pending={view.pending}
          onConnect={onConnect}
        />
      )}
      {view.phase === 'connecting' && <Waiting onCancel={onCancel} />}
      {view.phase === 'connected' && (
        <Connected
          view={view}
          onDisconnect={onDisconnect}
          onChoose={onChoose}
          onCreate={onCreate}
        />
      )}
      {view.phase === 'connected' && view.meetings !== null && (
        <Meetings view={view.meetings} pending={view.pending} actions={meetings} />
      )}
      {view.problem !== null && (
        <div className="settings__confirm" role="alert">
          <p className="settings__problem">{view.problem.problem}</p>
          {view.problem.fix !== null && <p className="settings__lede">{view.problem.fix}</p>}
        </div>
      )}
    </SettingsSection>
  );
}

const NO_MEETINGS_ACTIONS: GoogleMeetingsActions = {
  onAllow: () => {},
  onSync: () => {},
  onStop: () => {},
};

function meetingsLine(view: GoogleMeetingsView): string {
  if (view.state === 'off') {
    return 'Today’s meetings are not read. Allow it to see them on Today and in the morning brief, each as a note linked to the people in it.';
  }
  if (view.state === 'consent') {
    return 'This vault reads today’s meetings, but this Mac has not been allowed to read your calendar yet.';
  }
  if (view.syncing) return 'Reading your meetings…';
  return view.lastSynced === null
    ? 'Meetings are read every 15 minutes.'
    : `Meetings are read every 15 minutes; last read at ${view.lastSynced}.`;
}

/** Today's meetings: allow reading them, read them now, or stop. */
function Meetings({
  view,
  pending,
  actions,
}: {
  view: GoogleMeetingsView;
  pending: boolean;
  actions: GoogleMeetingsActions;
}) {
  return (
    <div className="settings__confirm" role="group" aria-label="Meetings">
      <p className="settings__lede">{meetingsLine(view)}</p>
      <div className="settings__actions">
        {view.state !== 'on' && (
          <button
            className="btn btn--secondary"
            type="button"
            disabled={pending}
            onClick={actions.onAllow}
          >
            Allow reading meetings
          </button>
        )}
        {view.state === 'on' && (
          <button
            className="btn btn--secondary"
            type="button"
            disabled={pending || view.syncing}
            onClick={actions.onSync}
          >
            Read meetings now
          </button>
        )}
        {view.state !== 'off' && (
          <button
            className="btn btn--ghost"
            type="button"
            disabled={pending}
            onClick={actions.onStop}
          >
            Stop reading meetings
          </button>
        )}
      </div>
      {view.problem !== null && (
        <div role="alert">
          <p className="settings__problem">{view.problem.problem}</p>
          {view.problem.fix !== null && <p className="settings__lede">{view.problem.fix}</p>}
        </div>
      )}
    </div>
  );
}

function ConnectForm({
  clientId,
  pending,
  onConnect,
}: {
  clientId: string;
  pending: boolean;
  onConnect: (request: GoogleConnectRequest) => void;
}) {
  const [client, setClient] = useState(clientId);
  const [secret, setSecret] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onConnect({ clientId: client, clientSecret: secret });
    setSecret('');
  };

  return (
    <form className="secrets__form" aria-label="Connect Google Calendar" onSubmit={submit}>
      <input
        className="field secrets__field"
        aria-label="OAuth client ID"
        placeholder="Client ID, ending .apps.googleusercontent.com"
        autoComplete="off"
        spellCheck={false}
        value={client}
        onChange={(event) => setClient(event.target.value)}
      />
      <input
        className="field secrets__field"
        type="password"
        aria-label="Client secret, if Google issued one"
        placeholder="Client secret, if Google issued one"
        autoComplete="new-password"
        spellCheck={false}
        value={secret}
        onChange={(event) => setSecret(event.target.value)}
      />
      <button className="btn btn--primary" type="submit" disabled={pending || client.trim() === ''}>
        Connect
      </button>
    </form>
  );
}

function Waiting({ onCancel }: { onCancel: () => void }) {
  return (
    <div className="settings__row">
      <p className="settings__lede">Finish signing in in your browser…</p>
      <button className="btn btn--ghost" type="button" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

function destination(view: GoogleCalendarView): string {
  const chosen = view.calendars.find((calendar) => calendar.id === view.chosen);
  return chosen === undefined
    ? 'Choose the calendar blocks go to.'
    : `Blocks go to ${chosen.name}.`;
}

function Connected({
  view,
  onDisconnect,
  onChoose,
  onCreate,
}: {
  view: GoogleCalendarView;
  onDisconnect: () => void;
  onChoose: (calendarId: string) => void;
  onCreate: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <>
      <p className="settings__lede">Connected. {destination(view)}</p>
      <div className="settings__actions">
        {view.calendars.length > 0 && (
          <select
            className="field"
            aria-label="Calendar for blocks"
            value={view.chosen ?? ''}
            disabled={view.pending}
            onChange={(event) => onChoose(event.target.value)}
          >
            <option value="" disabled>
              Choose a calendar
            </option>
            {view.calendars.map((calendar) => (
              <option key={calendar.id} value={calendar.id}>
                {calendar.name}
              </option>
            ))}
          </select>
        )}
        {view.canCreate && (
          <button
            className="btn btn--secondary"
            type="button"
            disabled={view.pending}
            onClick={onCreate}
          >
            Create “{view.calendarName}”
          </button>
        )}
        {!confirming && (
          <button
            className="btn btn--ghost"
            type="button"
            disabled={view.pending}
            onClick={() => setConfirming(true)}
          >
            Disconnect…
          </button>
        )}
      </div>
      {confirming && (
        <div className="settings__confirm" role="group" aria-label="Disconnect Google Calendar?">
          <p className="settings__lede">
            DFAI forgets the sign-in on this Mac and asks Google to revoke it. The calendar and its
            events stay on your Google account.
          </p>
          <div className="settings__actions">
            <button
              className="btn btn--primary"
              type="button"
              onClick={() => {
                setConfirming(false);
                onDisconnect();
              }}
            >
              Disconnect
            </button>
            <button className="btn btn--ghost" type="button" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}
