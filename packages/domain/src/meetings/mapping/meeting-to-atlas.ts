import { readAttendees, type Attendee } from './meeting-attendees.ts';
import { meetingPaths } from './meeting-file-name.ts';
import { MeetingMappingError, oneLine, shown } from './meeting-mapping-error.ts';
import { splitSections } from './meeting-sections.ts';
import { nextStepsText, sectionText } from './meeting-text.ts';
import {
  firstSpoken,
  readTranscript,
  readTurns,
  transcriptText,
  type Transcript,
} from './meeting-transcript.ts';
import { readStated } from './meeting-stated.ts';
import {
  meetingWhen,
  startAsk,
  type CalendarStart,
  type MeetingWhen,
  type StartAsk,
  type WhenInput,
} from './meeting-when.ts';

/*
 * The meeting mapper (ADR-0027). The app's `POST /v1/meetings` runs it, and
 * `pnpm n8n:build` compiles this folder into n8n's Code nodes, which take one
 * script with no imports: so a module here imports nothing but the others in
 * this folder, and uses nothing n8n's sandbox may lack without a fallback.
 */

/**
 * What James's n8n workflow hands over, by the mapper's names (the
 * "Meeting fields for DFAI" node renames his fields to these, and
 * `POST /v1/meetings` its request's). Untyped: it comes as JSON.
 */
export interface MeetingFields {
  readonly title?: unknown;
  readonly date?: unknown;
  readonly start?: unknown;
  readonly end?: unknown;
  /** The provider's email subject (or doc title) stating the meeting's day, and time if given. */
  readonly stated?: unknown;
  /** When the notes email arrived: the fallback for a start, less the transcript's length. */
  readonly arrived?: unknown;
  readonly attendees?: unknown;
  readonly summary?: unknown;
  readonly decisions?: unknown;
  readonly nextSteps?: unknown;
  readonly details?: unknown;
  /**
   * The notes as one markdown text with `## Summary`, `## Decisions`,
   * `## Next steps` and `## Details` headings, for a workflow that keeps them
   * together. Each part fills its field when that field is not given.
   */
  readonly sections?: unknown;
  readonly transcript?: unknown;
  /**
   * The transcript as data, for a provider whose API gives it so (Granola):
   * `{ speaker, time, approximate, words }` turns, in order. When given,
   * `transcript` is not read.
   */
  readonly turns?: unknown;
  /** What the `turns`' times count: `wall` (time of day) or `elapsed` (the default). */
  readonly clock?: unknown;
  /** The meeting in the provider's own app, written as `source_url:`. */
  readonly url?: unknown;
  readonly category?: unknown;
  readonly source?: unknown;
  readonly sourceId?: unknown;
}

export interface MappingOptions {
  /**
   * An IANA zone (`America/Los_Angeles`) to read instants (`...Z`, `-07:00`)
   * in. Null (the default) refuses an instant, having no zone to read it in;
   * a date or a time without an offset is taken as written either way.
   */
  readonly timeZone?: string | null;
  /** Addresses to treat as groups that the address rule misses. */
  readonly groupAddresses?: readonly string[];
  /**
   * The meeting's calendar event, as the caller looked it up from
   * {@link meetingStartAsk}: a start when nothing the meeting carries gives
   * one. Left out where there is no calendar to ask (n8n's Code nodes).
   */
  readonly calendar?: CalendarStart | null;
}

/** One contract file, where it goes, and what n8n needs to commit it. */
export interface MeetingFile {
  readonly path: string;
  readonly collisionPath: string;
  readonly content: string;
  readonly title: string;
  readonly provider: string;
  readonly externalId: string;
  readonly commitMessage: string;
}

const PROVIDER = /^[a-z][a-z0-9-]*$/;
/** A web address someone can open: `javascript:` and the like are never written as a link. */
const WEB_ADDRESS = /^https?:\/\/[^\s/]\S*$/i;

function required(value: unknown, field: string): string {
  const text = oneLine(value, field);
  if (text === '') throw new MeetingMappingError(`${field}: missing`);
  return text;
}

function providerOf(source: unknown): string {
  const provider = required(source, 'source').toLowerCase();
  if (!PROVIDER.test(provider)) {
    throw new MeetingMappingError(`source: ${shown(provider)} is not a provider name like gemini`);
  }
  return provider;
}

/** The provider's link to the meeting, or null when none was given. */
function sourceUrlOf(value: unknown): string | null {
  const url = oneLine(value, 'url');
  if (url === '') return null;
  if (!WEB_ADDRESS.test(url)) {
    throw new MeetingMappingError(`url: ${shown(url)} is not a web address (https://…)`);
  }
  return url;
}

/** A YAML scalar that every reader takes as text: single-quoted, `'` doubled. */
const quoted = (text: string) => `'${text.replace(/'/g, "''")}'`;

function attendeeYaml({ name, email, group }: Attendee): string[] {
  return [
    `  - name: ${quoted(name)}`,
    ...(email === undefined ? [] : [`    email: ${quoted(email)}`]),
    ...(group ? ['    group: true'] : []),
  ];
}

interface Header {
  readonly title: string;
  readonly when: MeetingWhen;
  readonly kind: string;
  readonly provider: string;
  readonly externalId: string;
  readonly sourceUrl: string | null;
  readonly clock: Transcript['clock'] | null;
  readonly attendees: readonly Attendee[];
}

function frontmatter(header: Header): string {
  const { title, when, kind, provider, externalId, sourceUrl, clock, attendees } = header;
  const lines = [
    '---',
    'type: meeting',
    'atlas_import: meeting/v1',
    `title: ${quoted(title)}`,
    `date: ${quoted(when.date)}`,
    `start: ${quoted(when.start)}`,
    ...(when.startApproximate ? ['start_approximate: true'] : []),
    ...(when.startSource === null ? [] : [`start_source: ${when.startSource}`]),
    ...(when.end === null ? [] : [`end: ${quoted(when.end)}`]),
    ...(kind === '' ? [] : [`kind: ${quoted(kind)}`]),
    `provider: ${quoted(provider)}`,
    `external_id: ${quoted(externalId)}`,
    ...(sourceUrl === null ? [] : [`source_url: ${quoted(sourceUrl)}`]),
    ...(clock === null ? [] : [`transcript_clock: ${clock}`]),
    ...(attendees.length === 0 ? [] : ['attendees:', ...attendees.flatMap(attendeeYaml)]),
    '---',
  ];
  return lines.join('\n');
}

/**
 * Gemini's Details become Notes. Its Decisions (which the contract has no
 * section for) go under them as `### Decisions`, so they are kept, not lost.
 */
function notesText(fields: MeetingFields): string {
  const details = sectionText(fields.details, 'details');
  const decisions = sectionText(fields.decisions, 'decisions');
  if (decisions === '') return details;
  return [details, `### Decisions\n\n${decisions}`].filter(Boolean).join('\n\n');
}

/** Nothing given: n8n hands an unset row over as '' (a list as []). */
const isEmpty = (value: unknown) =>
  value === null ||
  value === undefined ||
  (typeof value === 'string' && value.trim() === '') ||
  (Array.isArray(value) && value.length === 0);

/** The fields with each of the four prose parts taken from `sections` where it was not given. */
function withSections(fields: MeetingFields): MeetingFields {
  if (isEmpty(fields.sections)) return fields;
  const parts = splitSections(fields.sections);
  const or = (value: unknown, part: string) => (isEmpty(value) ? part : value);
  return {
    ...fields,
    summary: or(fields.summary, parts.summary),
    decisions: or(fields.decisions, parts.decisions),
    nextSteps: or(fields.nextSteps, parts.nextSteps),
    details: or(fields.details, parts.details),
  };
}

function body(fields: MeetingFields, transcript: Transcript): string {
  const sections: [string, string][] = [
    ['Summary', sectionText(fields.summary, 'summary')],
    ['Notes', notesText(fields)],
    ['Provider next steps', nextStepsText(fields.nextSteps)],
    ['Transcript', transcriptText(transcript.turns)],
  ];
  return sections
    .filter(([, text]) => text !== '')
    .map(([heading, text]) => `## ${heading}\n\n${text}`)
    .join('\n\n');
}

/** The fields read and checked, in the order the mapping refuses them. */
interface Prepared {
  readonly fields: MeetingFields;
  readonly title: string;
  readonly provider: string;
  readonly externalId: string;
  readonly attendees: readonly Attendee[];
  readonly transcript: Transcript;
  readonly when: WhenInput;
}

function prepared(given: MeetingFields, options: MappingOptions): Prepared {
  const fields = withSections(given);
  const title = required(fields.title, 'title');
  const provider = providerOf(fields.source);
  const externalId = required(fields.sourceId, 'sourceId');
  const attendees = readAttendees(fields.attendees, options.groupAddresses ?? []);
  const transcript = isEmpty(fields.turns)
    ? readTranscript(
        fields.transcript,
        attendees.map((each) => each.name),
      )
    : readTurns(fields.turns, fields.clock);
  const when: WhenInput = {
    date: fields.date,
    start: fields.start,
    end: fields.end,
    stated: readStated(fields.stated),
    arrived: fields.arrived,
    transcriptLength: transcript.length,
    firstSpoken: firstSpoken(transcript),
    timeZone: options.timeZone ?? null,
    calendar: options.calendar ?? null,
  };
  return { fields, title, provider, externalId, attendees, transcript, when };
}

/**
 * What to look the meeting up on the calendar by — its title, day and
 * arrival — when nothing it carries gives its start; null when something
 * does. Throws as {@link mapMeeting} would for a field it cannot read.
 */
export function meetingStartAsk(
  given: MeetingFields,
  options: MappingOptions = {},
): (StartAsk & { readonly title: string }) | null {
  const { title, when } = prepared(given, options);
  const ask = startAsk(when);
  return ask === null ? null : { title, ...ask };
}

/**
 * One meeting as a meeting/v1 contract file (vault/docs/contracts/meeting-import-v1.md),
 * with the path it goes to and the commit message. Throws a
 * {@link MeetingMappingError} when a required field is missing, rather than
 * writing a file DFAI would refuse.
 */
export function mapMeeting(given: MeetingFields, options: MappingOptions = {}): MeetingFile {
  const {
    fields,
    title,
    provider,
    externalId,
    attendees,
    transcript,
    when: whenInput,
  } = prepared(given, options);
  const when = meetingWhen(whenInput);
  const header: Header = {
    title,
    when,
    kind: oneLine(fields.category, 'category'),
    provider,
    externalId,
    sourceUrl: sourceUrlOf(fields.url),
    clock: transcript.turns.length === 0 ? null : transcript.clock,
    attendees,
  };
  const text = body(fields, transcript);
  return {
    ...meetingPaths({ date: when.date, title, provider, externalId }),
    content: `${frontmatter(header)}\n${text === '' ? '' : `\n${text}\n`}`,
    title,
    provider,
    externalId,
    commitMessage: `Meeting: ${title} (${provider})`,
  };
}
