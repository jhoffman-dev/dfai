import type { GoogleCalendar, GoogleEvent, GoogleFailure } from '@dfai/domain';

/** Whether this vault has a Google sign-in on this Mac, and what it is for. Never a token. */
export interface GoogleConnection {
  readonly connected: boolean;
  readonly clientId: string | null;
  readonly scopes: readonly string[];
}

/**
 * Google Calendar, through the host (ADR-0030). The host keeps the tokens and
 * answers with none of them; every call names the vault it is for, so one
 * that lands after a switch is refused rather than sent with the other's.
 */
export interface GoogleCalendarPort {
  status(args: { vault: string }): Promise<GoogleConnection>;
  /**
   * Signs in in the person's browser. Settles once Google sends the browser
   * back, the sign-in is cancelled, or it runs out of time.
   */
  connect(args: {
    vault: string;
    clientId: string;
    /** Only for a client Google issued one to; left out, the one kept with the last sign-in is used. */
    clientSecret?: string;
    scopes: readonly string[];
  }): Promise<GoogleConnection>;
  /** Ends the sign-in waiting in the browser, if there is one. */
  cancelConnect(): Promise<void>;
  /**
   * Forgets the sign-in. `revoked` is false when Google was not told: it
   * could not be reached, or — `shared` — another vault on this Mac signs in
   * with the same client, and revoking might end that one's sign-in too.
   */
  disconnect(args: {
    vault: string;
  }): Promise<{ readonly revoked: boolean; readonly shared: boolean }>;
  listCalendars(args: { vault: string }): Promise<readonly GoogleCalendar[]>;
  createCalendar(args: { vault: string; name: string }): Promise<GoogleCalendar>;
}

/** A Google Calendar call that failed, with what the host or the API said. */
export class GoogleCalendarError extends Error {
  readonly failure: GoogleFailure;

  constructor(failure: GoogleFailure) {
    super(failure.message);
    this.name = 'GoogleCalendarError';
    this.failure = failure;
  }
}

/**
 * What a calendar answered: every event between two instants (a full
 * listing), or what changed since a sync token — or that the token has
 * expired, and the calendar must be listed in full again.
 */
export type CalendarChanges =
  | {
      readonly kind: 'changes';
      readonly events: readonly GoogleEvent[];
      /** The token the next sync of this calendar starts from; null when Google gave none. */
      readonly syncToken: string | null;
    }
  | { readonly kind: 'expired' };

/** The events on the person's calendars, read-only, through the host's sign-in (ADR-0046). */
export interface CalendarSource {
  /**
   * With a sync token, what changed since it; without one, every event
   * between `timeMin` and `timeMax`. Each instance of a recurring event is
   * its own event; a cancelled one is listed, with its id.
   */
  listEvents(args: {
    vault: string;
    calendarId: string;
    timeMin: number;
    timeMax: number;
    syncToken: string | null;
  }): Promise<CalendarChanges>;
}

/** Where this Mac's sync of one calendar left off, and the window it was listed for. */
export interface CalendarFollowing {
  readonly syncToken: string;
  /** The window's first day when the calendar was listed in full; another day lists it again. */
  readonly fromDay: string;
}

/** This Mac's meetings syncs of one vault. */
export interface MeetingSyncRecord {
  readonly calendars: Readonly<Record<string, CalendarFollowing>>;
  readonly lastSyncAt: number | null;
}

/**
 * Where each vault's meetings syncs left off, kept on this Mac: a sync token
 * is this Mac's own, and the vault syncs, so keeping it there would be a
 * write on every sync and a conflict between Macs.
 */
export interface MeetingSyncRecords {
  read(vault: string): MeetingSyncRecord;
  write(vault: string, record: MeetingSyncRecord): void;
}
