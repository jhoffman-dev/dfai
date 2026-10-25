/**
 * Google Calendar, as DFAI uses it (ADR-0030): one calendar of the person's
 * own, made by DFAI, that blocks are written to — reached through a sign-in
 * the host keeps.
 *
 * The rules live here: which scope a sign-in asks for, what a client ID looks
 * like, and which calendar may hold blocks. The host keeps the tokens and
 * runs the protocol; it decides none of this (ADR-0005).
 */

import { GOOGLE_SCOPES_BY_USE } from './google-scopes.ts';

/**
 * Only calendars DFAI made itself: it may make one, and see and change the
 * events on it, and nothing on any other calendar. Google lists it as a
 * non-sensitive scope, so a client needs no verification to ask for it.
 */
export const GOOGLE_CALENDAR_SCOPES: readonly string[] = GOOGLE_SCOPES_BY_USE.blocks;

/** The name DFAI gives the calendar it makes for blocks. */
export const DEDICATED_CALENDAR_NAME = 'DFAI blocks';

/** The name Atlas, the app before DFAI, gave it (ADR-0042): still its calendar. */
const LEGACY_CALENDAR_NAME = 'Atlas blocks';

/** The vault setting holding the Google OAuth client ID a sign-in uses. */
export const GOOGLE_CLIENT_ID_KEY = 'google_client_id';

/** The vault setting holding the id of the calendar blocks go to. */
export const GOOGLE_CALENDAR_KEY = 'google_calendar';

/** `<project number>-<letters and digits>.apps.googleusercontent.com`, as Google issues them. */
const CLIENT_ID = /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/;

/** A Google OAuth client ID as typed or kept, trimmed; null when it is not one. */
export function parseGoogleClientId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return CLIENT_ID.test(trimmed) ? trimmed : null;
}

/** A calendar on the person's Google account, as DFAI needs to know it. */
export interface GoogleCalendar {
  readonly id: string;
  readonly name: string;
  /** Their main calendar. */
  readonly primary: boolean;
  /** Theirs to write to, rather than shared with them. */
  readonly owned: boolean;
}

/**
 * Whether blocks may go to a calendar: one the person owns that is not their
 * main calendar. DFAI writes to one calendar of its own and never to the one
 * colleagues book meetings into.
 */
export function canHoldBlocks(calendar: GoogleCalendar): boolean {
  return calendar.owned && !calendar.primary;
}

/** The calendar blocks go to: the one chosen, while it is listed and may hold them. */
export function dedicatedCalendar(
  calendars: readonly GoogleCalendar[],
  chosenId: string | null,
): GoogleCalendar | null {
  if (chosenId === null) return null;
  return calendars.find((calendar) => calendar.id === chosenId && canHoldBlocks(calendar)) ?? null;
}

/**
 * Whether DFAI should offer to make its calendar: not while one of the
 * calendars blocks may go to already has its name, so connecting again after
 * a disconnect finds the old one rather than making a second.
 */
export function needsBlocksCalendar(calendars: readonly GoogleCalendar[]): boolean {
  return !calendars.some(
    (calendar) =>
      canHoldBlocks(calendar) &&
      (calendar.name === DEDICATED_CALENDAR_NAME || calendar.name === LEGACY_CALENDAR_NAME),
  );
}

/** What the vault's settings say about Google Calendar. */
export interface GoogleCalendarSetting {
  readonly clientId: string | null;
  readonly calendarId: string | null;
}

/** Reads the two settings from the vault's settings; anything unusable is unset. */
export function parseGoogleCalendarSetting(
  settings: Readonly<Record<string, unknown>>,
): GoogleCalendarSetting {
  const calendar = settings[GOOGLE_CALENDAR_KEY];
  return {
    clientId: parseGoogleClientId(settings[GOOGLE_CLIENT_ID_KEY]),
    calendarId: typeof calendar === 'string' && calendar.trim() !== '' ? calendar.trim() : null,
  };
}
