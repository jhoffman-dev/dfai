import { rfc3339Instant } from './meeting-instant.ts';
import { MeetingMappingError, oneLine } from './meeting-mapping-error.ts';
import { mapMeeting, type MeetingFields, type MeetingFile } from './meeting-to-atlas.ts';
import type { Turn } from './meeting-transcript.ts';
import { wallClockIn, type WallTime } from './meeting-when.ts';

/*
 * A Granola note — `GET /v1/notes/{id}?include=transcript` of Granola's
 * public API — as the mapper's fields (P28-09). Pure, and in the mapper's
 * folder so n8n's Code nodes run the same rules as the app. The zone the
 * times are written in is passed in (the vault's `granola_time_zone`), never
 * read from the Mac, so every writer of the same note writes the same bytes.
 */

export interface GranolaMappingOptions {
  /** The IANA zone whose clock the meeting's times are written on. */
  readonly timeZone: string;
  /**
   * The vault's person's addresses. Granola's `me` is the note's owner, who
   * is `You` only when the owner is this person: a note shared by someone
   * else names them instead.
   */
  readonly selfEmails: readonly string[];
}

/** Everything a Granola note needs to become a file: the caller's settings, with no default. */
export interface GranolaFileOptions extends GranolaMappingOptions {
  /** Addresses the vault treats as groups (its setting; n8n's OPTIONS). */
  readonly groupAddresses: readonly string[];
}

type JsonRecord = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A record Granola may send as null; anything else is not the note it documents. */
function optionalRecord(value: unknown, field: string): JsonRecord | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw new MeetingMappingError(`${field}: expected an object or null`);
  return value;
}

function listOf(value: unknown, field: string): readonly unknown[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new MeetingMappingError(`${field}: expected a list`);
  return value;
}

function recordAt(value: unknown, field: string): JsonRecord {
  if (!isRecord(value)) throw new MeetingMappingError(`${field}: expected an object`);
  return value;
}

/**
 * Milliseconds since the epoch, or null when absent or not an RFC 3339
 * instant, which Granola sends every time as. One without an offset is not
 * read: it would be taken on the Mac's own clock.
 */
function instantOf(value: unknown): number | null {
  return typeof value === 'string' ? rfc3339Instant(value) : null;
}

/** The first of the fields with text in it (Granola's markdown, else its plain text); null for none. */
function firstWithText(...fields: readonly (readonly [field: string, value: unknown])[]): unknown {
  return fields.find(([field, value]) => oneLine(value, field) !== '')?.[1] ?? null;
}

/** A list-of-addresses option, refused by name when it is not one: n8n hands over whatever OPTIONS holds. */
function addressesOption(value: unknown, option: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((each) => typeof each === 'string')) {
    throw new MeetingMappingError(`options.${option}: expected a list of addresses`);
  }
  return value;
}

function timeZoneOption(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MeetingMappingError(
      'options.timeZone: missing (the zone the meeting’s times are written in, like "America/Los_Angeles")',
    );
  }
  return value;
}

function optionsRecord(value: unknown): JsonRecord {
  if (!isRecord(value)) throw new MeetingMappingError('options: expected an object');
  return value;
}

/**
 * Who Granola's `me` is: the note's owner — `You` when the owner is the
 * vault's person, else the owner's name, else `Unknown`.
 */
function noteTakerOf(note: JsonRecord, selfEmails: readonly string[]): string {
  const owner = optionalRecord(note['owner'], 'owner');
  const email = oneLine(owner?.['email'], 'owner.email').toLowerCase();
  const self = selfEmails.some((each) => each.trim().toLowerCase() === email);
  if (email !== '' && self) return 'You';
  return oneLine(owner?.['name'], 'owner.name') || 'Unknown';
}

/** How the turns are read: on the zone's clock, with `me` named as the note's owner. */
interface TurnReading {
  readonly clock: (instant: number) => WallTime;
  readonly noteTaker: string;
}

/** Who spoke: the name Granola resolved, else the note's owner for `me`, else Unknown. */
function speakerOf(value: unknown, field: string, noteTaker: string): string {
  const speaker = optionalRecord(value, field);
  const name = oneLine(speaker?.['name'], `${field}.name`);
  if (name !== '') return name;
  return speaker?.['attribution'] === 'me' ? noteTaker : 'Unknown';
}

/** One transcript item read, with the span it covers for the meeting's own start and end. */
interface ReadItem {
  readonly turn: Turn;
  readonly began: number | null;
  readonly ended: number | null;
}

function readItem(value: unknown, at: number, { clock, noteTaker }: TurnReading): ReadItem {
  const item = recordAt(value, `transcript[${at}]`);
  const began = instantOf(item['start_time']);
  const ended = instantOf(item['end_time']);
  return {
    turn: {
      speaker: speakerOf(item['speaker'], `transcript[${at}].speaker`, noteTaker),
      time: began === null ? null : clock(began).time,
      approximate: false,
      words: oneLine(item['text'], `transcript[${at}].text`),
    },
    began,
    // A turn that ends before it starts ends, for the meeting, when it starts.
    ended: extreme(Math.max, [began, ended]),
  };
}

/**
 * The earliest (`Math.min`) or latest (`Math.max`) of the times known; null
 * when none is. Taken pairwise: spread into `Math.min`, a long meeting's
 * turns overflow the engine's argument limit.
 */
function extreme(
  pick: (a: number, b: number) => number,
  times: readonly (number | null)[],
): number | null {
  let found: number | null = null;
  for (const time of times) {
    if (time !== null) found = found === null ? time : pick(found, time);
  }
  return found;
}

/**
 * When the meeting began and ended: the calendar event's scheduled times,
 * else its first turn's start and last turn's end. With no start at all it
 * is refused, rather than given a made-up time. An end before the start (a
 * calendar event that ends before it begins, or a last word spoken before
 * the scheduled start) is not an end: the meeting is written with none.
 */
function spanOf(
  event: JsonRecord | null,
  items: readonly ReadItem[],
): { start: number; end: number | null } {
  const firstSpoken = extreme(
    Math.min,
    items.map((item) => item.began),
  );
  const lastSpoken = extreme(
    Math.max,
    items.map((item) => item.ended),
  );
  const start = instantOf(event?.['scheduled_start_time']) ?? firstSpoken;
  if (start === null) {
    throw new MeetingMappingError(
      'start: the Granola note has no start: no calendar event time, and no transcript turn with a time',
    );
  }
  const end = instantOf(event?.['scheduled_end_time']) ?? lastSpoken;
  return { start, end: end !== null && end < start ? null : end };
}

/** Who was there: the attendees, then the calendar's invitees (address only), one per address. */
function attendeesOf(note: JsonRecord, event: JsonRecord | null): unknown[] {
  const attendees = listOf(note['attendees'], 'attendees').map((each, at) => {
    const person = recordAt(each, `attendees[${at}]`);
    return { name: person['name'], email: person['email'] };
  });
  const invitees = listOf(event?.['invitees'], 'calendar_event.invitees').map((each, at) => ({
    email: recordAt(each, `calendar_event.invitees[${at}]`)['email'],
  }));
  return [...attendees, ...invitees];
}

/**
 * The end as the mapper reads it: `HH:MM` on the start's day, with its date
 * when it is a later day's (`2026-10-25T00:15`), and none when the clock
 * shows it before the start — a fall-back hour, the instant later but the
 * time earlier — since an end before the start is not an end.
 */
function endOnClock(began: WallTime, ended: WallTime): string | null {
  const time = ended.time.slice(0, 5);
  if (ended.day !== began.day) return `${ended.day}T${time}`;
  return time < began.time.slice(0, 5) ? null : time;
}

/**
 * The meeting's title: the note's, else its calendar event's. With neither,
 * the mapper refuses it as `title: missing`.
 */
function titleOf(note: JsonRecord, event: JsonRecord | null): unknown {
  return firstWithText(
    ['title', note['title']],
    ['calendar_event.event_title', event?.['event_title']],
  );
}

/**
 * The note as the mapper's fields, its times on the clock of `timeZone`
 * (see {@link spanOf} for the meeting's start and end). Each turn is
 * named by the speaker's resolved name, else — for `me` — the note's owner
 * (`You` when that is the vault's person), else `Unknown`, and stamped with
 * its time of day on the zone's clock. The attendees and the invitees are
 * merged by address; the summary is the markdown one, else the plain text;
 * the owner's private notes are Notes. A turn with no words is dropped. The
 * title is the note's, else the calendar event's. A field the mapper
 * requires (`title`, the id) is left for it to refuse, by name. Options
 * that are missing or of the wrong kind are refused by name too: n8n's Code
 * node is untyped, and a missing zone would otherwise be the host's.
 */
export function granolaNoteToFields(value: unknown, options: GranolaMappingOptions): MeetingFields {
  const given = optionsRecord(options);
  const timeZone = timeZoneOption(given['timeZone']);
  const selfEmails = addressesOption(given['selfEmails'], 'selfEmails');
  if (!isRecord(value)) throw new MeetingMappingError('the Granola note: expected an object');
  const note = value;
  const clock = wallClockIn(timeZone);
  const event = optionalRecord(note['calendar_event'], 'calendar_event');
  const reading = { clock, noteTaker: noteTakerOf(note, selfEmails) };
  const items = listOf(note['transcript'], 'transcript')
    .map((each, at) => readItem(each, at, reading))
    .filter((item) => item.turn.words !== '');
  const { start, end } = spanOf(event, items);
  const began = clock(start);
  return {
    title: titleOf(note, event),
    date: began.day,
    start: began.time.slice(0, 5),
    end: end === null ? null : endOnClock(began, clock(end)),
    attendees: attendeesOf(note, event),
    summary: firstWithText(
      ['summary_markdown', note['summary_markdown']],
      ['summary_text', note['summary_text']],
    ),
    details: firstWithText(
      ['private_notes_markdown', note['private_notes_markdown']],
      ['private_notes_text', note['private_notes_text']],
    ),
    turns: items.map((item) => item.turn),
    clock: 'wall',
    source: 'granola',
    sourceId: note['id'],
    url: note['web_url'],
  };
}

/**
 * A Granola note as its contract file, with every setting the caller's: the
 * one call the app's pull and n8n's Code node make, so neither can leave a
 * setting to a default the other does not share.
 */
export function mapGranolaNote(note: unknown, options: GranolaFileOptions): MeetingFile {
  const given = optionsRecord(options);
  const groupAddresses = addressesOption(given['groupAddresses'], 'groupAddresses');
  return mapMeeting(granolaNoteToFields(note, options), { groupAddresses });
}
