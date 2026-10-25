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
  TakenNotePaths,
} from '../vault/new-note.ts';
import { createVaultPath, type VaultPath } from '../vault/vault-path.ts';
import {
  isMeetingKind,
  myResponse,
  otherAttendees,
  type EventWhen,
  type GoogleEvent,
} from './google-event.ts';
import {
  matchMeetingNote,
  startlessShared,
  type EventToMatch,
  type MeetingCandidate,
} from './meeting-match.ts';
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
  /** The zone the person keeps time in: a calendar Google gave no zone for is written in it. */
  readonly timeZone: string;
  /**
   * The zone each calendar keeps, as Google gave it. An event's times are
   * written on its calendar's clock, not on the Mac's, so two Macs in two
   * zones write the same bytes (ADR-0046).
   */
  readonly calendarZones?: Readonly<Record<string, string>>;
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

/**
 * The order twins are told apart in — two notes for one event, made by two
 * Macs before git brought one to the other: by path without `.md`, by code
 * unit, so `… standup.md` comes before the `… standup 2.md` that copies it.
 */
export function compareEventNotePaths(one: string, other: string): number {
  const stem = (path: string) => path.replace(/\.md$/i, '');
  const [first, second] = [stem(one), stem(other)];
  return first < second ? -1 : first > second ? 1 : 0;
}

/** The notes each event id is on, in twin order. */
function notesById(existing: readonly ExistingEventNote[]): Map<string, ExistingEventNote[]> {
  const byId = new Map<string, ExistingEventNote[]>();
  const sorted = [...existing].sort((one, other) => compareEventNotePaths(one.path, other.path));
  for (const note of sorted) {
    const id = textOf(note.properties[K.eventId]);
    if (id !== null) byId.set(id, [...(byId.get(id) ?? []), note]);
  }
  return byId;
}

/** Each event's copies, one for each calendar read that has it, in the order the calendars are read. */
function copiesById(input: EventNotesInput): Map<string, GoogleEvent[]> {
  const byId = new Map<string, GoogleEvent[]>();
  for (const event of input.events) {
    if (input.ignoredCalendars.includes(event.calendarId)) continue;
    byId.set(event.id, [...(byId.get(event.id) ?? []), event]);
  }
  return byId;
}

/** The copy a new note is made from: the first calendar's, unless it is cancelled there and not on another. */
const firstLiveCopy = (copies: readonly GoogleEvent[]): GoogleEvent | undefined =>
  copies.find((copy) => copy.status !== 'cancelled') ?? copies[0];

/**
 * The copy a note follows: the one on the calendar it came from, which alone
 * speaks for it. A copy on another calendar never cancels it, moves it or
 * changes its answer. A note that names no calendar follows the first live copy.
 */
function copyFor(note: ExistingEventNote, copies: readonly GoogleEvent[]): GoogleEvent | undefined {
  const calendar = textOf(note.properties[K.calendar]);
  return calendar === null
    ? firstLiveCopy(copies)
    : copies.find((copy) => copy.calendarId === calendar);
}

/** The clock an event's times are written on: its calendar's, else the person's. */
const zoneFor = (event: GoogleEvent, input: EventNotesInput): string =>
  input.calendarZones?.[event.calendarId] ?? input.timeZone;

/** What one plan works from besides its input: the names it has taken, and the notes it may link. */
interface PlanContext {
  readonly input: EventNotesInput;
  readonly taken: TakenNotePaths;
  readonly meetings: readonly MeetingCandidate[];
}

/** The day's meetings each once, as their start-less meeting notes are told apart. */
function meetingsToMatch(input: EventNotesInput): EventToMatch[] {
  const byId = new Map<string, EventToMatch>();
  for (const event of input.events) {
    if (event.status === 'cancelled' || !isMeetingKind(event) || event.start?.kind !== 'timed') {
      continue;
    }
    if (input.ignoredCalendars.includes(event.calendarId) || byId.has(event.id)) continue;
    byId.set(event.id, {
      title: event.title,
      start: wallStart(event.start, zoneFor(event, input)),
    });
  }
  for (const note of input.existing) {
    const id = textOf(note.properties[K.eventId]);
    const title = textOf(note.properties[K.title]);
    const start = textOf(note.properties[K.date]);
    if (id === null || byId.has(id) || isMissing(note) || title === null) continue;
    if (start?.includes('T') === true) byId.set(id, { title, start });
  }
  return [...byId.values()];
}

/** The meeting notes an event may be linked to: not one with no start that fits two of the day's meetings. */
function linkableMeetings(input: EventNotesInput): MeetingCandidate[] {
  const shared = startlessShared(meetingsToMatch(input), input.meetings);
  return input.meetings.filter((note) => !shared.has(note.path));
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
  context: PlanContext,
): unknown {
  if (linkedNotes(current[K.meeting]).length > 0) return current[K.meeting];
  const matched = date.includes('T')
    ? matchMeetingNote({ title, start: date }, context.meetings)
    : null;
  return matched === null ? null : context.input.linkTo(matched);
}

/** Every property the sync owns, as the event says it should be now. */
function ownedProperties(
  event: GoogleEvent & { start: EventWhen },
  current: Readonly<Record<string, unknown>>,
  context: PlanContext,
): Record<string, unknown> {
  const { input } = context;
  const zone = zoneFor(event, input);
  const title = event.title.trim() === '' ? NO_TITLE : event.title.trim();
  const date = wallStart(event.start, zone);
  const emails = otherAttendees(event).map(({ email }) => email);
  return {
    [K.title]: title,
    [K.date]: date,
    [K.ends]: wallEnd(event.start, event.end, zone),
    [K.attendees]: emails.length === 0 ? null : emails,
    ...linksFor(event, current, input),
    [K.meeting]: meetingFor(title, date, current, context),
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

function newNotePath(title: string, date: string, taken: TakenNotePaths): VaultPath {
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
  context: PlanContext,
): EventNoteWrite | null {
  if (event.status === 'cancelled' || !isMeetingKind(event)) {
    return note !== undefined && !isMissing(note) ? { kind: 'missing', path: note.path } : null;
  }
  // A meeting with no time to read is left as its note says, never taken for gone.
  if (event.start === null) return null;
  const dated = { ...event, start: event.start };
  const properties = ownedProperties(dated, note?.properties ?? {}, context);
  if (note === undefined) {
    const date = String(properties[K.date]);
    if (!overlapsWindow(date, properties[K.ends], context.input.window)) return null;
    const written = Object.fromEntries(
      Object.entries({ type: EVENT_NOTE_TYPE, ...properties }).filter(
        ([, value]) => value !== null,
      ),
    );
    return {
      kind: 'create',
      path: newNotePath(String(properties[K.title]), date, context.taken),
      properties: written,
    };
  }
  const update = changed(note.properties, properties);
  return Object.keys(update).length === 0
    ? null
    : { kind: 'update', path: note.path, properties: update };
}

/** One event as one calendar listed it: an id is unique only within a calendar. */
const listedOn = (calendar: string, id: string) => `${calendar}\n${id}`;

/**
 * Notes a full listing no longer has: on a calendar listed in full, in the
 * window, and not among what that calendar answered. Deleted while DFAI was
 * not following the calendar's changes, so marked, never removed.
 */
function goneFromListing(
  input: EventNotesInput,
  byId: ReadonlyMap<string, readonly ExistingEventNote[]>,
): EventNoteWrite[] {
  const seen = new Set(input.events.map((event) => listedOn(event.calendarId, event.id)));
  return [...byId.entries()].flatMap(([id, notes]) =>
    notes
      .filter((note) => {
        const calendar = textOf(note.properties[K.calendar]);
        const day = textOf(note.properties[K.date])?.slice(0, 10) ?? null;
        return (
          calendar !== null &&
          !seen.has(listedOn(calendar, id)) &&
          !isMissing(note) &&
          input.complete.includes(calendar) &&
          day !== null &&
          inWindow(day, input.window)
        );
      })
      .map((note): EventNoteWrite => ({ kind: 'missing', path: note.path })),
  );
}

/** The writes one event asks for: a new note, or one for each note it is on that its calendar speaks for. */
function writesFor(
  copies: readonly GoogleEvent[],
  notes: readonly ExistingEventNote[],
  context: PlanContext,
): (EventNoteWrite | null)[] {
  if (notes.length === 0) {
    const first = firstLiveCopy(copies);
    return first === undefined ? [] : [writeFor(first, undefined, context)];
  }
  return notes.map((note) => {
    const copy = copyFor(note, copies);
    return copy === undefined ? null : writeFor(copy, note, context);
  });
}

/**
 * What a meetings sync writes (ADR-0046): a note for each meeting in the
 * window that has none, what changed on each that has one — only the
 * properties the sync owns, never the body, which is the person's — and a
 * mark on each whose event Google cancelled. Nothing is ever deleted. A
 * cancelled event, or one that is not a meeting, with no note gets none.
 * Two notes for one event are both kept up to date, so neither goes stale.
 */
export function planEventNotes(input: EventNotesInput): EventNoteWrite[] {
  const byId = notesById(input.existing);
  const context: PlanContext = {
    input,
    taken: new TakenNotePaths(input.taken),
    meetings: linkableMeetings(input),
  };
  const writes: EventNoteWrite[] = [];
  for (const [id, copies] of copiesById(input)) {
    for (const write of writesFor(copies, byId.get(id) ?? [], context)) {
      if (write === null) continue;
      if (write.kind === 'create') context.taken.add(write.path);
      writes.push(write);
    }
  }
  return [...writes, ...goneFromListing(input, byId)];
}
