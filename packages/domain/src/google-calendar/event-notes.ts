import {
  matchAttendees,
  type DirectoryCompany,
  type DirectoryPerson,
} from '../meeting-links/attendee-matching.ts';
import { holdsOnlyText, linkedNotes, withLink } from '../types/relation-links.ts';
import { fitFileNameStem } from '../vault/file-name-bytes.ts';
import {
  linkableEntryName,
  nextAvailableNotePath,
  NUMBERED_NOTE_ENDING,
} from '../vault/new-note.ts';
import { createVaultPath, type VaultPath } from '../vault/vault-path.ts';
import {
  isMeetingKind,
  myResponse,
  otherAttendees,
  type EventWhen,
  type GoogleEvent,
} from './google-event.ts';
import { matchMeetingNote, type MeetingCandidate } from './meeting-match.ts';
import { inWindow, wallEnd, wallStart, type MeetingWindow } from './meeting-window.ts';

/** The type an event note declares, as an ICS source's do (ADR-0012). */
export const EVENT_NOTE_TYPE = 'event';

/** Where event notes are made. Each stays where it is once made, wherever it is moved to. */
export const EVENT_NOTES_FOLDER = 'Calendar';

/** The properties a meetings sync writes on an event note, and owns. */
export const EVENT_NOTE_KEYS = {
  title: 'title',
  date: 'date',
  ends: 'ends',
  attendees: 'attendees',
  people: 'people',
  companies: 'companies',
  meeting: 'meeting',
  eventId: 'gcal_event_id',
  calendar: 'gcal_calendar',
  series: 'gcal_recurring_event_id',
  response: 'gcal_response',
  /** Set once Google says the event was cancelled or deleted; the note is never removed. */
  missing: 'gcal_missing',
} as const;

/** What an untitled event is called, as Google's own calendar calls it. */
const NO_TITLE = '(No title)';

/** An event note already in the vault, with its frontmatter as it is now. */
export interface ExistingEventNote {
  readonly path: VaultPath;
  readonly properties: Readonly<Record<string, unknown>>;
}

export interface EventNotesInput {
  /** Every event the calendars answered with, in the order the calendars are read. */
  readonly events: readonly GoogleEvent[];
  readonly existing: readonly ExistingEventNote[];
  /** The calendars listed in full this time, rather than by what changed. */
  readonly complete: readonly string[];
  readonly window: MeetingWindow;
  readonly timeZone: string;
  /** Calendars whose events are never meetings: the one blocks go to (#30). */
  readonly ignoredCalendars: readonly string[];
  readonly people: readonly DirectoryPerson[];
  readonly companies: readonly DirectoryCompany[];
  readonly meetings: readonly MeetingCandidate[];
  /** How a link to a note is written, so it opens the note it means. */
  readonly linkTo: (path: VaultPath) => string;
  /** Every path in the vault, so a new note takes a free name. */
  readonly taken: ReadonlySet<string>;
}

/**
 * One write to an event note. An update carries only what changed; a
 * property set to null is one to take off.
 */
export type EventNoteWrite =
  | {
      readonly kind: 'create';
      readonly path: VaultPath;
      readonly properties: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: 'update';
      readonly path: VaultPath;
      readonly properties: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: 'missing'; readonly path: VaultPath };

const K = EVENT_NOTE_KEYS;

const textOf = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/** The note an event id is on: the first by path, when a race made two. */
function notesById(existing: readonly ExistingEventNote[]): Map<string, ExistingEventNote> {
  const byId = new Map<string, ExistingEventNote>();
  const sorted = [...existing].sort((one, other) => (one.path < other.path ? -1 : 1));
  for (const note of sorted) {
    const id = textOf(note.properties[K.eventId]);
    if (id !== null && !byId.has(id)) byId.set(id, note);
  }
  return byId;
}

/**
 * Each event once. An invitation on two calendars read is one meeting: the
 * first calendar's copy wins, unless it is cancelled there and not here.
 */
function distinctEvents(input: EventNotesInput): GoogleEvent[] {
  const byId = new Map<string, GoogleEvent>();
  for (const event of input.events) {
    if (input.ignoredCalendars.includes(event.calendarId)) continue;
    const kept = byId.get(event.id);
    if (kept === undefined || (kept.status === 'cancelled' && event.status !== 'cancelled')) {
      byId.set(event.id, event);
    }
  }
  return [...byId.values()];
}

/** The relation's links with `links` added; what it holds is kept, and nothing more is guessed. */
function withLinks(current: unknown, links: readonly string[]): unknown {
  if (!holdsOnlyText(current)) return current;
  const merged = links.reduce<unknown>(
    (value, link) => withLink({ value, link, many: true }),
    linkedNotes(current),
  );
  return linkedNotes(merged).length === 0 ? null : merged;
}

function linksFor(
  event: GoogleEvent,
  current: Readonly<Record<string, unknown>>,
  input: EventNotesInput,
) {
  const attendees = otherAttendees(event).map(({ email, name }) => ({
    name: name ?? email,
    email,
    group: false,
  }));
  const matching = matchAttendees(attendees, input.people, input.companies);
  return {
    [K.people]: withLinks(
      current[K.people],
      matching.linked.map(({ person }) => input.linkTo(person.path)),
    ),
    [K.companies]: withLinks(
      current[K.companies],
      matching.companies.map(({ company }) => input.linkTo(company.path)),
    ),
  };
}

/** The meeting note it was written up in: the one linked already, else the one that surely is. */
function meetingFor(
  title: string,
  date: string,
  current: Readonly<Record<string, unknown>>,
  input: EventNotesInput,
): unknown {
  if (linkedNotes(current[K.meeting]).length > 0) return current[K.meeting];
  const matched = date.includes('T')
    ? matchMeetingNote({ title, start: date }, input.meetings)
    : null;
  return matched === null ? null : input.linkTo(matched);
}

/** Every property the sync owns, as the event says it should be now. */
function ownedProperties(
  event: GoogleEvent & { start: EventWhen },
  current: Readonly<Record<string, unknown>>,
  input: EventNotesInput,
): Record<string, unknown> {
  const title = event.title.trim() === '' ? NO_TITLE : event.title.trim();
  const date = wallStart(event.start, input.timeZone);
  const emails = otherAttendees(event).map(({ email }) => email);
  return {
    [K.title]: title,
    [K.date]: date,
    [K.ends]: wallEnd(event.start, event.end, input.timeZone),
    [K.attendees]: emails.length === 0 ? null : emails,
    ...linksFor(event, current, input),
    [K.meeting]: meetingFor(title, date, current, input),
    [K.eventId]: event.id,
    [K.calendar]: event.calendarId,
    [K.series]: event.recurringEventId,
    [K.response]: myResponse(event),
    [K.missing]: null,
  };
}

const same = (one: unknown, other: unknown) =>
  JSON.stringify(one ?? null) === JSON.stringify(other ?? null);

/** Only the properties whose value would change. */
function changed(
  current: Readonly<Record<string, unknown>>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(next).filter(([key, value]) => !same(current[key], value)),
  );
}

/** Whether an event is on any day the window reads. */
function overlapsWindow(start: string, ends: unknown, window: MeetingWindow): boolean {
  const first = start.slice(0, 10);
  const last = (textOf(ends) ?? start).slice(0, 10);
  return first <= window.toDay && last >= window.fromDay;
}

function newNotePath(title: string, date: string, taken: ReadonlySet<string>): VaultPath {
  const stem = linkableEntryName(`${date.slice(0, 10)} ${title}`);
  return nextAvailableNotePath({
    folder: createVaultPath(EVENT_NOTES_FOLDER),
    name: fitFileNameStem(stem === '' ? date.slice(0, 10) : stem, NUMBERED_NOTE_ENDING),
    taken,
  });
}

const isMissing = (note: ExistingEventNote) => note.properties[K.missing] === true;

/** The write an event asks for, or null when its note is as it should be. */
function writeFor(
  event: GoogleEvent,
  note: ExistingEventNote | undefined,
  input: EventNotesInput,
  taken: ReadonlySet<string>,
): EventNoteWrite | null {
  if (event.status === 'cancelled' || !isMeetingKind(event)) {
    return note !== undefined && !isMissing(note) ? { kind: 'missing', path: note.path } : null;
  }
  // A meeting with no time to read is left as its note says, never taken for gone.
  if (event.start === null) return null;
  const dated = { ...event, start: event.start };
  const properties = ownedProperties(dated, note?.properties ?? {}, input);
  if (note === undefined) {
    const date = String(properties[K.date]);
    if (!overlapsWindow(date, properties[K.ends], input.window)) return null;
    const written = Object.fromEntries(
      Object.entries({ type: EVENT_NOTE_TYPE, ...properties }).filter(
        ([, value]) => value !== null,
      ),
    );
    return {
      kind: 'create',
      path: newNotePath(String(properties[K.title]), date, taken),
      properties: written,
    };
  }
  const update = changed(note.properties, properties);
  return Object.keys(update).length === 0
    ? null
    : { kind: 'update', path: note.path, properties: update };
}

/**
 * Notes a full listing no longer has: on a calendar listed in full, in the
 * window, and not among what it answered. Deleted while DFAI was not
 * following the calendar's changes, so marked, never removed.
 */
function goneFromListing(
  input: EventNotesInput,
  byId: ReadonlyMap<string, ExistingEventNote>,
  seen: ReadonlySet<string>,
): EventNoteWrite[] {
  return [...byId.entries()]
    .filter(([id, note]) => {
      const calendar = textOf(note.properties[K.calendar]);
      const day = textOf(note.properties[K.date])?.slice(0, 10) ?? null;
      return (
        !seen.has(id) &&
        !isMissing(note) &&
        calendar !== null &&
        input.complete.includes(calendar) &&
        day !== null &&
        inWindow(day, input.window)
      );
    })
    .map(([, note]) => ({ kind: 'missing', path: note.path }));
}

/**
 * What a meetings sync writes (ADR-0046): a note for each meeting in the
 * window that has none, what changed on each that has one — only the
 * properties the sync owns, never the body, which is the person's — and a
 * mark on each whose event Google cancelled. Nothing is ever deleted. A
 * cancelled event, or one that is not a meeting, with no note gets none.
 */
export function planEventNotes(input: EventNotesInput): EventNoteWrite[] {
  const byId = notesById(input.existing);
  const taken = new Set(input.taken);
  const seen = new Set<string>();
  const writes: EventNoteWrite[] = [];
  for (const event of distinctEvents(input)) {
    seen.add(event.id);
    const write = writeFor(event, byId.get(event.id), input, taken);
    if (write === null) continue;
    if (write.kind === 'create') taken.add(write.path);
    writes.push(write);
  }
  return [...writes, ...goneFromListing(input, byId, seen)];
}
