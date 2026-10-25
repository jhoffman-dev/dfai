/**
 * Whether a vault reads its meetings from Google Calendar, and from which
 * calendars (ADR-0046). Kept in the vault's settings, so both Macs read the
 * same calendars; each Mac signs in for itself.
 */

/** `true` once the person has allowed DFAI to read their calendar for this vault. */
export const GOOGLE_MEETINGS_KEY = 'google_meetings';

/** The calendars meetings are read from, by id; the person's main one when unset. */
export const GOOGLE_MEETING_CALENDARS_KEY = 'google_meeting_calendars';

/** Google's name for the signed-in person's main calendar. */
export const PRIMARY_CALENDAR = 'primary';

export interface MeetingSetting {
  readonly enabled: boolean;
  /** At least one, each once, in the order written: the first wins an invitation on two. */
  readonly calendars: readonly string[];
}

function calendarsOf(value: unknown): string[] {
  const listed = (Array.isArray(value) ? value : [value])
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  const distinct = [...new Set(listed)];
  return distinct.length === 0 ? [PRIMARY_CALENDAR] : distinct;
}

/** The meetings setting as the vault's settings hold it; anything unusable is its default. */
export function parseMeetingSetting(settings: Readonly<Record<string, unknown>>): MeetingSetting {
  return {
    enabled: settings[GOOGLE_MEETINGS_KEY] === true,
    calendars: calendarsOf(settings[GOOGLE_MEETING_CALENDARS_KEY]),
  };
}
