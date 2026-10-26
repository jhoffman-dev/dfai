import {
  canHoldBlocks,
  explainGoogleFailure,
  parseGoogleCalendarSetting,
  parseGoogleClientId,
  scopesWith,
  DEDICATED_CALENDAR_NAME,
  GOOGLE_BLOCKS_KEY,
  GOOGLE_MEETINGS_KEY,
  GOOGLE_CALENDAR_KEY,
  GOOGLE_CALENDAR_SCOPES,
  GOOGLE_CLIENT_ID_KEY,
  type GoogleCalendar,
  type GoogleCalendarSetting,
  type GoogleProblem,
  type GoogleUse,
} from '@dfai/domain';
import type { MarkdownPort } from '../notes/ports.ts';
import type { Rng } from '../ports.ts';
import { readVaultSettings, type SettingsWriter } from '../settings/index.ts';
import { vaultIdChange } from '../settings/vault-id.ts';
import type { VaultFsPort } from '../vault/ports.ts';
import { GoogleCalendarError, type GoogleCalendarPort, type GoogleConnection } from './ports.ts';

/** What the person should read for anything a Google Calendar step threw. */
export function googleProblemOf(cause: unknown): GoogleProblem {
  if (cause instanceof GoogleCalendarError) return explainGoogleFailure(cause.failure);
  return { problem: cause instanceof Error ? cause.message : String(cause), fix: null };
}

const NOT_A_CLIENT_ID =
  'That is not a Google OAuth client ID: it ends in .apps.googleusercontent.com.';

/**
 * Signs in to Google Calendar with the client typed, asking for DFAI's one
 * scope. A client secret is sent only when one was typed: a client Google
 * issued none to needs none (ADR-0030).
 */
export async function connectGoogleCalendar({
  port,
  vault,
  clientId,
  clientSecret,
}: {
  port: GoogleCalendarPort;
  vault: string;
  clientId: string;
  clientSecret: string;
}): Promise<GoogleConnection> {
  const client = parseGoogleClientId(clientId);
  if (client === null) {
    throw new GoogleCalendarError({ kind: 'invalid', message: NOT_A_CLIENT_ID });
  }
  const secret = clientSecret.trim();
  return port.connect({
    vault,
    clientId: client,
    scopes: GOOGLE_CALENDAR_SCOPES,
    ...(secret === '' ? {} : { clientSecret: secret }),
  });
}

/** The calendars blocks may go to, by name. */
export async function blockCalendars({
  port,
  vault,
}: {
  port: GoogleCalendarPort;
  vault: string;
}): Promise<readonly GoogleCalendar[]> {
  const calendars = await port.listCalendars({ vault });
  return calendars.filter(canHoldBlocks).sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Makes the calendar blocks go to, under DFAI's name for it, keeping the
 * person's zone: one made with none is on UTC, and shows every block hours off.
 */
export function createBlocksCalendar({
  port,
  vault,
  timeZone,
}: {
  port: GoogleCalendarPort;
  vault: string;
  timeZone: string;
}): Promise<GoogleCalendar> {
  return port.createCalendar({ vault, name: DEDICATED_CALENDAR_NAME, timeZone });
}

const NOT_REVOKED: GoogleProblem = {
  problem: 'DFAI forgot the sign-in, but could not tell Google to revoke it.',
  fix: 'Remove DFAI from the third-party access in your Google Account’s security settings.',
};

const SHARED: GoogleProblem = {
  problem:
    'DFAI forgot the sign-in for this vault, but did not ask Google to revoke it: another vault on this Mac connects with the same client, and revoking could disconnect that one too.',
  fix: 'To end DFAI’s access altogether, disconnect the other vault as well.',
};

/** Forgets the sign-in. Returns what the person still has to do, or null when nothing. */
export async function disconnectGoogleCalendar({
  port,
  vault,
}: {
  port: GoogleCalendarPort;
  vault: string;
}): Promise<GoogleProblem | null> {
  const { revoked, shared } = await port.disconnect({ vault });
  if (shared) return SHARED;
  return revoked ? null : NOT_REVOKED;
}

/** The client and calendar the vault's settings name. */
export async function loadGoogleCalendarSetting(args: {
  fs: VaultFsPort;
  markdown: Pick<MarkdownPort, 'frontmatterProperties' | 'frontmatterProblem'>;
}): Promise<GoogleCalendarSetting> {
  return parseGoogleCalendarSetting(await readVaultSettings(args));
}

/** Writes the client and calendar into the vault's settings. */
export async function saveGoogleCalendarSetting({
  settings,
  setting,
}: {
  settings: SettingsWriter;
  setting: GoogleCalendarSetting;
}): Promise<void> {
  await settings.save({
    [GOOGLE_CLIENT_ID_KEY]: setting.clientId,
    [GOOGLE_CALENDAR_KEY]: setting.calendarId,
  });
}

const NOT_CONNECTED =
  'Google Calendar is not connected for this vault. Connect it first, then allow reading meetings.';

/**
 * Lets DFAI read the person's calendar for today's meetings (ADR-0046): one
 * more consent screen, asking for the read-only scope on top of what was
 * allowed before, with the client the sign-in already uses. Nothing is asked
 * when it was allowed already.
 */
export function allowGoogleMeetings(args: {
  port: GoogleCalendarPort;
  vault: string;
}): Promise<GoogleConnection> {
  return allowGoogleUse({ ...args, use: 'meetings', notConnected: NOT_CONNECTED });
}

/** Signs in again for `use` on top of what was granted, with the same client; nothing asked when it is granted. */
async function allowGoogleUse({
  port,
  vault,
  use,
  notConnected,
}: {
  port: GoogleCalendarPort;
  vault: string;
  use: GoogleUse;
  notConnected: string;
}): Promise<GoogleConnection> {
  const connection = await port.status({ vault });
  if (!connection.connected || connection.clientId === null) {
    throw new GoogleCalendarError({ kind: 'not_connected', message: notConnected });
  }
  const scopes = scopesWith(connection.scopes, use);
  if (scopes === null) return connection;
  return port.connect({ vault, clientId: connection.clientId, scopes });
}

const BLOCKS_NOT_CONNECTED =
  'Google Calendar is not connected for this vault. Connect it first, then sync blocks.';

/**
 * Lets DFAI write blocks to the calendar it made (#30). The connection
 * already asks for `calendar.app.created`, which reaches only calendars DFAI
 * made; a sign-in that lacks it (one made before, or with it unticked) is
 * asked for it again. Nothing is asked when it is granted.
 */
export function allowGoogleBlocks(args: {
  port: GoogleCalendarPort;
  vault: string;
}): Promise<GoogleConnection> {
  return allowGoogleUse({ ...args, use: 'blocks', notConnected: BLOCKS_NOT_CONNECTED });
}

/**
 * Writes whether the vault's blocks sync two ways with its Google calendar.
 * Turned on, the vault is given its own id too when it has none (a seed of
 * every new block's event id), in the same write, so it reaches the Mac that
 * syncs blocks with the switch itself.
 */
export async function saveBlocksEnabled({
  settings,
  enabled,
  rng,
}: {
  settings: SettingsWriter;
  enabled: boolean;
  rng: Pick<Rng, 'next'>;
}): Promise<void> {
  if (!enabled) {
    await settings.save({ [GOOGLE_BLOCKS_KEY]: null });
    return;
  }
  await settings.update((current) => ({
    [GOOGLE_BLOCKS_KEY]: true,
    ...vaultIdChange(current, rng),
  }));
}

/** Writes whether the vault reads its meetings from Google Calendar. */
export async function saveMeetingsEnabled({
  settings,
  enabled,
}: {
  settings: SettingsWriter;
  enabled: boolean;
}): Promise<void> {
  await settings.save({ [GOOGLE_MEETINGS_KEY]: enabled ? true : null });
}
