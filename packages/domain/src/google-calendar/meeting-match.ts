import type { CalendarStart, StartAsk } from '../meetings/index.ts';
import { vocabularyKey } from '../terms/spelling.ts';
import type { VaultPath } from '../vault/vault-path.ts';

/** A meeting note, as an event is matched to it: its day, its start and its title. */
export interface MeetingCandidate {
  readonly path: VaultPath;
  readonly title: string;
  /** `YYYY-MM-DD`. */
  readonly date: string;
  /** `HH:MM`, or null when the note gives none. */
  readonly start: string | null;
}

/** An event, as it is matched: its wall-clock start and its title. */
export interface EventToMatch {
  readonly title: string;
  /** `2026-10-24T09:30`; an all-day event is never matched. */
  readonly start: string;
}

/**
 * How far a meeting note's start may be from its event's. A notetaker that
 * works its start out from when its email arrived (meeting/v1's
 * `start_approximate`) can be some minutes off; a half hour apart is
 * another meeting.
 */
export const MEETING_START_TOLERANCE_MINUTES = 20;

const minutesOf = (time: string): number | null => {
  const match = /^(\d{2}):(\d{2})/.exec(time);
  return match === null ? null : Number(match[1]) * 60 + Number(match[2]);
};

function startsTogether(eventTime: string, noteStart: string | null): boolean {
  if (noteStart === null) return true;
  const event = minutesOf(eventTime);
  const note = minutesOf(noteStart);
  if (event === null || note === null) return false;
  return Math.abs(event - note) <= MEETING_START_TOLERANCE_MINUTES;
}

/**
 * Whether an event and a meeting note are one meeting: on the same day,
 * under the same title as the Terms page compares spellings (a blank one
 * is no title), and starting near each other when the note gives a start.
 */
function isWrittenUpIn(event: EventToMatch, note: Omit<MeetingCandidate, 'path'>): boolean {
  const [day, time] = event.start.split('T');
  if (day === undefined || time === undefined) return false;
  const title = vocabularyKey(event.title);
  if (title === '') return false;
  return (
    note.date === day && vocabularyKey(note.title) === title && startsTogether(time, note.start)
  );
}

/**
 * The meeting note an event was written up in: on its day, under its title
 * as the Terms page compares spellings, and starting near its start. Exactly
 * one, or none: two that fit are a choice for the person, never a guess.
 */
export function matchMeetingNote(
  event: EventToMatch,
  candidates: readonly MeetingCandidate[],
): VaultPath | null {
  const fits = candidates.filter((note) => isWrittenUpIn(event, note));
  return fits.length === 1 ? (fits[0]?.path ?? null) : null;
}

/** An event with its wall-clock start and end, `2026-10-24T09:30`; the end null when it gives none. */
export interface DayEventTimes extends EventToMatch {
  readonly end: string | null;
}

/**
 * How long after its event's end a meeting's notes may arrive and still be
 * taken as that event's. Notetakers send within minutes, or an hour on a
 * slow day; three hours on, the same title is likelier another meeting's.
 */
export const MEETING_NOTES_ARRIVAL_WINDOW_MINUTES = 180;

const instantOf = (wallTime: string): number => Date.parse(`${wallTime}:00Z`);

/** Whether the event ended at or before the notes arrived, and within the window before. */
function endedBefore(event: DayEventTimes, arrived: string): boolean {
  if (event.end === null) return false;
  const since = (instantOf(arrived) - instantOf(event.end)) / 60_000;
  return since >= 0 && since <= MEETING_NOTES_ARRIVAL_WINDOW_MINUTES;
}

/**
 * The start and end of the calendar event a meeting with no start of its
 * own was, from that day's `events`: the one written up under the
 * meeting's title (as {@link matchMeetingNote} matches a note with no
 * start), on its day, that ended at or before its notes arrived and within
 * {@link MEETING_NOTES_ARRIVAL_WINDOW_MINUTES} of it. Two that fit are a
 * choice for the person, never a guess, so neither is taken; nor is one
 * still running when the notes came, or one that gives no end.
 */
export function calendarStartFor(
  meeting: StartAsk & { readonly title: string },
  events: readonly DayEventTimes[],
): CalendarStart {
  const note = { title: meeting.title, date: meeting.day, start: null };
  const fits = events.filter(
    (event) => isWrittenUpIn(event, note) && endedBefore(event, meeting.arrived),
  );
  const [only] = fits;
  if (fits.length === 1 && only !== undefined) {
    return {
      found: true,
      start: clockOf(only.start),
      end: only.end === null ? null : clockOf(only.end),
    };
  }
  if (events.length === 0) {
    return { found: false, why: `DFAI has no calendar events on ${meeting.day}`, connect: true };
  }
  const called = `called “${meeting.title}” ended in the ${MEETING_NOTES_ARRIVAL_WINDOW_MINUTES / 60} hours before the notes arrived`;
  const why =
    fits.length === 0
      ? `no event on ${meeting.day} ${called}`
      : `${fits.length} events on ${meeting.day} ${called}, so which it was is unclear`;
  return { found: false, why, connect: false };
}

/** `HH:MM` of a wall-clock `2026-10-24T09:30`. */
const clockOf = (wallTime: string): string => wallTime.slice(11, 16);

/**
 * The meeting notes that give no start and fit more than one of `events` —
 * the day's meetings, each once — under their title. Which of them a note
 * was written up in is the person's to say, so it is linked to none: a
 * notetaker's note of the morning standup is never also the afternoon's.
 */
export function startlessShared(
  events: readonly EventToMatch[],
  candidates: readonly MeetingCandidate[],
): ReadonlySet<VaultPath> {
  const fitting = (note: MeetingCandidate) =>
    events.filter(
      ({ title, start }) =>
        start.startsWith(`${note.date}T`) && vocabularyKey(title) === vocabularyKey(note.title),
    ).length;
  return new Set(
    candidates.filter((note) => note.start === null && fitting(note) > 1).map(({ path }) => path),
  );
}
