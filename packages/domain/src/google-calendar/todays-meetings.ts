import { readEventTime } from '../calendar/calendar-event.ts';
import { createVaultPath, type VaultPath } from '../vault/vault-path.ts';
import { EVENT_NOTE_KEYS } from './event-notes.ts';

const K = EVENT_NOTE_KEYS;

/** A row of `compileDayEventsQuery`. */
export interface DayEventRow {
  readonly path: string;
  readonly title: string;
  readonly key: string;
  readonly value: string | null;
}

/** A meeting on the day, as the Today page and the morning brief (#39) read it. */
export interface DayMeeting {
  readonly path: VaultPath;
  readonly title: string;
  /** `HH:MM` on the person's wall clock. */
  readonly start: string;
  /** `HH:MM`, or null when it ends another day or says no end. */
  readonly end: string | null;
  readonly people: readonly VaultPath[];
  readonly companies: readonly VaultPath[];
  /** The meeting note it was written up in, once there is one. */
  readonly meeting: VaultPath | null;
  /** The person has not answered yet, or said maybe. */
  readonly unanswered: boolean;
}

interface Gathered {
  title: string;
  values: Map<string, string[]>;
}

function gather(rows: readonly DayEventRow[]): Map<string, Gathered> {
  const notes = new Map<string, Gathered>();
  for (const row of rows) {
    const note = notes.get(row.path) ?? { title: row.title, values: new Map<string, string[]>() };
    if (row.value !== null)
      note.values.set(row.key, [...(note.values.get(row.key) ?? []), row.value]);
    notes.set(row.path, note);
  }
  return notes;
}

const clockOf = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

function meetingOf(path: string, note: Gathered, day: string): DayMeeting | null {
  const first = (key: string) => note.values.get(key)?.[0] ?? null;
  const paths = (key: string) => (note.values.get(key) ?? []).map(createVaultPath);
  const start = readEventTime(first(K.date));
  const response = first(K.response);
  if (start === null || start.minutes === null || start.date !== day) return null;
  if (first(K.missing) === 'true' || response === 'declined') return null;
  const end = readEventTime(first(K.ends));
  return {
    path: createVaultPath(path),
    title: note.title,
    start: clockOf(start.minutes),
    end: end !== null && end.date === day && end.minutes !== null ? clockOf(end.minutes) : null,
    people: paths(K.people),
    companies: paths(K.companies),
    meeting: paths(K.meeting)[0] ?? null,
    unanswered: response === 'needsAction' || response === 'tentative',
  };
}

/**
 * The meetings on `day`, earliest first: event notes with a time that day,
 * not cancelled, and not declined. An all-day event is on the calendar but
 * is not a meeting to prepare for, so it is left out.
 */
export function dayMeetings(rows: readonly DayEventRow[], day: string): DayMeeting[] {
  return [...gather(rows)]
    .map(([path, note]) => meetingOf(path, note, day))
    .filter((meeting) => meeting !== null)
    .sort((one, other) =>
      one.start === other.start
        ? one.title.localeCompare(other.title)
        : one.start < other.start
          ? -1
          : 1,
    );
}
