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
 * The meeting note an event was written up in: on its day, under its title
 * as the Terms page compares spellings, and starting near its start. Exactly
 * one, or none: two that fit are a choice for the person, never a guess.
 */
export function matchMeetingNote(
  event: EventToMatch,
  candidates: readonly MeetingCandidate[],
): VaultPath | null {
  const [day, time] = event.start.split('T');
  if (day === undefined || time === undefined) return null;
  const title = vocabularyKey(event.title);
  if (title === '') return null;
  const fits = candidates.filter(
    (note) =>
      note.date === day && vocabularyKey(note.title) === title && startsTogether(time, note.start),
  );
  return fits.length === 1 ? (fits[0]?.path ?? null) : null;
}
