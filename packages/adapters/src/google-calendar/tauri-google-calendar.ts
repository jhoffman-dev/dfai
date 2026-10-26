import { invoke } from '@tauri-apps/api/core';
import { isGoogleFailureKind, type GoogleCalendar, type GoogleFailure } from '@dfai/domain';
import {
  GoogleCalendarError,
  type GoogleCalendarPort,
  type GoogleConnection,
} from '@dfai/application';
import { calendarListPage, createdCalendarOf } from './calendar-list.ts';

/** A Calendar API answer as the host hands it back, with every token struck from it. */
export interface GoogleAnswer {
  readonly status: number;
  readonly body: string;
}

/** Far more calendars than anyone keeps; past it, a server looping on pages is cut off. */
const MAX_PAGES = 20;

const CALENDAR_LIST = '/calendar/v3/users/me/calendarList';

/**
 * A Google command's rejection as the app's error. The host rejects with a
 * `{ kind, code, message }` it built; anything else — Tauri refusing the
 * arguments, say — is a request that could not be made.
 */
export function googleErrorOf(rejection: unknown): GoogleCalendarError {
  if (typeof rejection === 'object' && rejection !== null && 'kind' in rejection) {
    const { kind, code, message } = rejection as Record<string, unknown>;
    if (isGoogleFailureKind(kind)) {
      const failure: GoogleFailure = {
        kind,
        message: typeof message === 'string' ? message : '',
        ...(typeof code === 'string' ? { code } : {}),
      };
      return new GoogleCalendarError(failure);
    }
  }
  const message = rejection instanceof Error ? rejection.message : String(rejection);
  return new GoogleCalendarError({ kind: 'invalid', message });
}

async function throughGoogle<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (rejection) {
    throw googleErrorOf(rejection);
  }
}

export const malformed = (message: string) =>
  new GoogleCalendarError({ kind: 'malformed', message });

/** The JSON an API call answered with, or why it is not one to read. */
/**
 * What Google said of an error, as its body says it: the message and every
 * reason it names (`insufficientPermissions`, `ACCESS_TOKEN_SCOPE_INSUFFICIENT`),
 * so what it means is decided in the domain. Empty for a body that says none.
 */
export function googleErrorWords(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Safe to ignore: an error body that is not JSON says nothing more than its status.
    return '';
  }
  const error = (parsed as { error?: unknown } | null)?.error;
  if (typeof error !== 'object' || error === null) return '';
  const { message, errors, details } = error as Record<string, unknown>;
  const reasons = [errors, details]
    .flatMap((list) => (Array.isArray(list) ? list : []))
    .map((entry) => (entry as { reason?: unknown } | null)?.reason)
    .filter((reason): reason is string => typeof reason === 'string');
  return [typeof message === 'string' ? message : '', ...reasons]
    .filter((word) => word !== '')
    .join('; ');
}

export function answered({ status, body }: GoogleAnswer): unknown {
  if (status < 200 || status > 299) {
    const words = googleErrorWords(body);
    throw new GoogleCalendarError({
      kind: 'api_refused',
      code: String(status),
      message: `the Calendar API answered ${status}${words === '' ? '' : `: ${words}`}`,
    });
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw malformed('the Calendar API did not answer with JSON');
  }
}

/** One Calendar API call through the host, answered as it came back, whatever its status. */
export function calendarAnswer(
  vault: string,
  call: { method: string; path: string; body?: string },
): Promise<GoogleAnswer> {
  return throughGoogle(invoke<GoogleAnswer>('google_calendar_request', { vault, call }));
}

async function callApi(vault: string, call: { method: string; path: string; body?: string }) {
  return answered(await calendarAnswer(vault, call));
}

async function listCalendars({ vault }: { vault: string }): Promise<GoogleCalendar[]> {
  const calendars: GoogleCalendar[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query: string = pageToken === null ? '' : `?pageToken=${encodeURIComponent(pageToken)}`;
    const listed = calendarListPage(
      await callApi(vault, { method: 'GET', path: CALENDAR_LIST + query }),
    );
    if (listed === null) throw malformed('the calendar list is not one DFAI can read');
    calendars.push(...listed.calendars);
    if (listed.next === null) return calendars;
    pageToken = listed.next;
  }
  throw malformed(`the calendar list ran past ${MAX_PAGES} pages`);
}

/**
 * Google Calendar through the host (ADR-0030). The host keeps every token;
 * what crosses here is whether a sign-in is kept and the API's answers, which
 * are read into calendars on this side.
 */
export const tauriGoogleCalendar: GoogleCalendarPort = {
  status({ vault }) {
    return throughGoogle(invoke<GoogleConnection>('google_status', { vault }));
  },
  connect({ vault, clientId, clientSecret, scopes }) {
    const secret = clientSecret === undefined ? {} : { clientSecret };
    return throughGoogle(
      invoke<GoogleConnection>('google_connect', { vault, clientId, scopes, ...secret }),
    );
  },
  cancelConnect() {
    return throughGoogle(invoke<void>('google_connect_cancel'));
  },
  disconnect({ vault }) {
    return throughGoogle(
      invoke<{ revoked: boolean; shared: boolean }>('google_disconnect', { vault }),
    );
  },
  listCalendars,
  async createCalendar({ vault, name, timeZone }) {
    const body = JSON.stringify({ summary: name, timeZone });
    const made = createdCalendarOf(
      await callApi(vault, { method: 'POST', path: '/calendar/v3/calendars', body }),
    );
    if (made === null) throw malformed('the new calendar came back without an id');
    return made;
  },
};
