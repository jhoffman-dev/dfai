import { splitFrontmatter } from '../markdown/markdown-document.ts';
import { IMPORT_ERROR_KEY, importOutcomeOf } from './meeting-arrival.ts';
import { MEETING_TYPE } from './meeting-header.ts';
import { validateMeetingImport, type FrontmatterReading } from './meeting-import.ts';

/** What makes two meeting files one meeting (ADR-0027): the provider and its id. */
export interface MeetingIdentity {
  readonly provider: string;
  readonly externalId: string;
}

/** Whether two identities are one meeting; ids are compared without the spaces around them. */
export const sameMeetingIdentity = (a: MeetingIdentity, b: MeetingIdentity): boolean =>
  a.provider === b.provider && a.externalId.trim() === b.externalId.trim();

/**
 * The meeting a note's own keys say it is — its provider and id — or null
 * when it names no provider or no id (a meeting written by hand, say).
 */
export function meetingIdentityOf(
  properties: Readonly<Record<string, unknown>>,
): MeetingIdentity | null {
  const provider = properties['provider'];
  const externalId = properties['external_id'];
  if (typeof provider !== 'string' || provider.trim() === '') return null;
  if (typeof externalId !== 'string' || externalId.trim() === '') return null;
  return { provider: provider.trim(), externalId: externalId.trim() };
}

/** Whether a note's own keys name the meeting: what a holder let in is kept by, whatever else it says. */
function holdsSameId(properties: Readonly<Record<string, unknown>>, meeting: MeetingIdentity) {
  const text = (key: string) => {
    const value = properties[key];
    return typeof value === 'string' ? value : '';
  };
  return (
    properties['type'] === MEETING_TYPE &&
    sameMeetingIdentity({ provider: text('provider'), externalId: text('external_id') }, meeting)
  );
}

/** One note's text, and the meeting asked about. */
export interface MeetingHoldingQuestion {
  readonly text: string;
  /** The YAML reader the app reads every note with; the domain has none. */
  readonly readFrontmatter: (frontmatter: string) => FrontmatterReading;
  readonly meeting: MeetingIdentity;
}

/**
 * Whether a note holds a meeting now (ADR-0027, P28-04's rule), and whether
 * the import has let it in: `imported` when it is stamped so and its own keys
 * name the meeting, whatever else the person has added; `unsettled` when it
 * is not stamped and follows the contract as that meeting. A note stamped
 * `duplicate` or `error`, or carrying an import error, holds nothing; nor does
 * one whose YAML does not read. Whether the note is a sync conflict's copy
 * (which holds nothing either) is told by its path, which the caller has.
 */
export function meetingHolding({
  text,
  readFrontmatter,
  meeting,
}: MeetingHoldingQuestion): 'imported' | 'unsettled' | null {
  const frontmatter = splitFrontmatter(text).frontmatter;
  const reading = frontmatter === null ? null : readFrontmatter(frontmatter);
  const properties = reading?.problem === null ? reading.properties : {};
  const outcome = importOutcomeOf(properties);
  if (outcome === 'imported') return holdsSameId(properties, meeting) ? 'imported' : null;
  if (outcome !== null || Object.hasOwn(properties, IMPORT_ERROR_KEY)) return null;
  const read = validateMeetingImport({ text, readFrontmatter, selfName: null });
  return read.ok && sameMeetingIdentity(read.meeting, meeting) ? 'unsettled' : null;
}
