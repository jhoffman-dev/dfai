import {
  attendeesOf,
  isMeetingType,
  linkingFailed,
  linkedEntities,
  linkedNotes,
  matchAttendees,
  matchSpeakers,
  messageWithoutPaths,
  MEETING_LINKS_KEY,
  MEETING_PROJECT_KEY,
  namedSpeakers,
  ownerAddressesInUse,
  ownerNotAGroup,
  participantOwnerOf,
  planMeetingLinks,
  rankProjects,
  splitFrontmatter,
  type AttendeeMatching,
  type DirectoryPerson,
  type DoneAction,
  type MeetingLinkPlan,
  type PassedOver,
  type PassedOverAttendee,
  type PriorValue,
  type ProjectSuggestion,
  type TranscriptTurn,
  type VaultPath,
  type Vocabulary,
} from '@dfai/domain';
import type { ArchivePorts } from '../archive/archive-notes.ts';
import { changeProperties, type PropertyChange } from '../automations/apply-changes.ts';
import { meetingTextAsCorrected } from '../meetings/meeting-corrections.ts';
import { validateMeetingFile } from '../meetings/meeting-reading.ts';
import { writeProposals } from '../proposals/write-proposals.ts';
import { listVaultNotes } from '../vault/read-vault.ts';
import { VaultAccessError } from '../vault/ports.ts';
import { loadLinkDirectory, loadProjectTies } from './link-directory.ts';
import { seriesProjectFor } from './meeting-series-source.ts';

/** What linking a meeting reaches: the vault, its index, the markdown port and the panes. */
export type MeetingLinkPorts = Pick<ArchivePorts, 'fs' | 'index' | 'markdown' | 'editors'>;

/** What linking one meeting did — kept so it can be undone, as an automation's run is. */
export interface MeetingLinkRun {
  readonly meeting: VaultPath;
  /** The people and companies it linked. */
  readonly linked: readonly VaultPath[];
  /** The project it filed the meeting under, and why (#227); null when it filed it under none. */
  readonly filed: ProjectSuggestion | null;
  /** Each relation it set, with what it held before and after: what an undo puts back. */
  readonly done: readonly DoneAction[];
  /** Each proposal it wrote into the Inbox. */
  readonly proposed: readonly VaultPath[];
  /** What it could not write, and why: the meeting (unsaved typing, a change since), or a proposal. */
  readonly left: readonly PassedOver[];
  /** Unknown attendees it could not propose, and why. */
  readonly passedOver: readonly PassedOverAttendee[];
  /** Why none of its proposals were written, when the Inbox could not be read or written; null otherwise. */
  readonly unproposed: string | null;
}

/** A meeting that cannot be linked, for a reason said in these words. */
export class MeetingLinkRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'MeetingLinkRefusedError';
  }
}

/**
 * Links the meeting at `path` to its people, companies and likely project
 * (P29-04) — filing it under that project when its twin or series surely
 * says it and its `project` holds nothing (#227): a deterministic step, which the "after a meeting" pipeline runs
 * and which runs on its own as each meeting is imported until then.
 *
 * Its attendees are matched against the vault's people and companies, and
 * its transcript's named speakers against its people (`planMeetingLinks`
 * says how) — the speakers as the vocabulary corrects them (P28-06), whether
 * or not the meeting's words have been corrected yet, so the order of the two
 * steps does not change who is linked. What is sure is added to the meeting's `people` and `companies`,
 * and its `project` set — the only keys it writes, with the mark of linking
 * still owed (#192) taken out in the same write — recording what each held before, so
 * {@link undoMeetingLink} can put it back. A meeting with unsaved typing, or
 * changed since it was read, is left as it is, and said. What is unsure is
 * written as proposals in the Inbox, each once, however often this runs.
 *
 * The links are written first. If the proposals then cannot be — the Inbox
 * refuses to be listed or written — the run still says who it linked, with
 * what it set, and why nothing was proposed (`unproposed`): the links are in
 * the meeting, and saying it could not be linked would be untrue.
 */
export async function linkMeeting({
  ports,
  path,
  today,
  selfName = null,
  selfEmails = [],
  vocabulary,
}: {
  ports: MeetingLinkPorts;
  path: VaultPath;
  /** `YYYY-MM-DD`: the day of the write, as every write that may touch a task is dated. */
  today: string;
  /** The vault owner's name from their profile: an attendee of that name is never proposed. */
  selfName?: string | null;
  /** The vault owner's own addresses, its `selfEmails`: an attendee at one is never proposed. */
  selfEmails?: readonly string[];
  /** The vocabulary the caller's run corrects by, so speakers are read by the same one; read from the index when not given. */
  vocabulary?: Vocabulary | undefined;
}): Promise<MeetingLinkRun> {
  const plan = await planFor({ ports, path, owner: { selfName, selfEmails }, vocabulary });
  const linked = await changeProperties({
    ports,
    changes: [
      ...relationChanges(path, plan.properties, plan.changes),
      ...filingChanges(path, plan),
      ...markChanges(path, plan.properties),
    ],
    kind: 'set',
    today,
  });
  const proposals = await writeProposals({ ...ports, proposals: plan.proposals }).then(
    (made) => ({ ...made, unproposed: null }),
    (cause: unknown) => ({ written: [], left: [], unproposed: messageWithoutPaths(cause) }),
  );
  const set = new Set(linked.done.map((line) => ('key' in line ? line.key : null)));
  const unreadable = plan.unreadable.map(({ reason }) => ({ path, reason }));
  return {
    meeting: path,
    linked: Object.entries(plan.added).flatMap(([key, paths]) => (set.has(key) ? paths : [])),
    filed: set.has(MEETING_PROJECT_KEY) ? (plan.filing?.suggestion ?? null) : null,
    done: linked.done,
    proposed: proposals.written,
    left: [...unreadable, ...linked.left, ...proposals.left],
    passedOver: plan.passedOver,
    unproposed: proposals.unproposed,
  };
}

/** What linking the meeting would do, worked out from the meeting, the index and the vault's notes. */
async function planFor({
  ports,
  path,
  owner,
  vocabulary,
}: {
  ports: MeetingLinkPorts;
  path: VaultPath;
  owner: { selfName: string | null; selfEmails: readonly string[] };
  vocabulary: Vocabulary | undefined;
}): Promise<MeetingLinkPlan & { readonly properties: Readonly<Record<string, unknown>> }> {
  const read = await readMeeting(ports, path);
  const notePaths = await listVaultNotes({ fs: ports.fs });
  const { people, companies } = await loadLinkDirectory({ index: ports.index });
  // An attendee at one of the owner's addresses is them, whatever a group rule made of it.
  const attendees = ownerNotAGroup(attendeesOf(read.properties), owner.selfEmails);
  const matching = matchAttendees(attendees, people, companies);
  // As corrected (P28-06): the import corrects in its stamp write, after this, so a misheard speaker is read as it will arrive.
  const corrected = await meetingTextAsCorrected({ ports, text: read.text, vocabulary });
  const speakers = speakersOf(ports, { heard: read.text, corrected }, people);
  const entities = linkedEntities(matching, speakers);
  const ties = await loadProjectTies({ index: ports.index, meeting: path, entities });
  const projects = rankProjects(ties);
  const { properties } = read;
  const { selfName } = owner;
  const selfEmails = ownerAddressesInUse({ selfEmails: owner.selfEmails, people, selfName });
  const seriesProject = await seriesProjectOf({
    ports,
    path,
    properties,
    matching,
    speakers,
    owner,
    people,
  });
  const input = {
    meeting: path,
    properties,
    notePaths,
    matching,
    speakers,
    projects,
    seriesProject,
    selfName,
    selfEmails,
  };
  return { ...planMeetingLinks(input), properties };
}

/**
 * What the meeting's twin or series says it is filed under (#227), with who
 * it is about to be linked to as its people; not asked of a meeting whose
 * `project` holds anything, which is never filed again.
 */
async function seriesProjectOf({
  ports,
  path,
  properties,
  matching,
  speakers,
  owner,
  people,
}: {
  ports: MeetingLinkPorts;
  path: VaultPath;
  properties: Readonly<Record<string, unknown>>;
  matching: AttendeeMatching;
  speakers: readonly DirectoryPerson[];
  owner: { selfName: string | null; selfEmails: readonly string[] };
  people: readonly DirectoryPerson[];
}): Promise<ProjectSuggestion | null> {
  if (linkedNotes(properties[MEETING_PROJECT_KEY]).length > 0) return null;
  const linked = [...matching.linked.map(({ person }) => person), ...speakers];
  return seriesProjectFor({
    index: ports.index,
    path,
    properties,
    people: linked.map((person) => person.path),
    owner: participantOwnerOf({ people, ...owner }),
  });
}

interface MeetingRead {
  readonly text: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

async function readMeeting(ports: MeetingLinkPorts, path: VaultPath): Promise<MeetingRead> {
  const read = await ports.fs.readTextFile(path).catch((error: unknown) => {
    if (error instanceof VaultAccessError)
      throw new MeetingLinkRefusedError(`There is no meeting at ${path}.`);
    throw error;
  });
  const properties = ports.markdown.frontmatterProperties(splitFrontmatter(read.text).frontmatter);
  if (!isMeetingType(properties['type']))
    throw new MeetingLinkRefusedError(`${path} is not a meeting.`);
  return { text: read.text, properties };
}

/**
 * The people the transcript's named speakers surely are. Only a meeting that
 * follows the import contract has turns to read; one edited out of it is
 * linked by its attendees alone.
 *
 * A label is tried as it was heard first — a name or an alias someone goes
 * by — and only one that is nobody's is tried as the vocabulary corrects it:
 * an alias links (ADR-0027, "Aliases link, Terms correct"), so a term that
 * lists the same spelling as misheard does not take the person away.
 */
function speakersOf(
  ports: MeetingLinkPorts,
  { heard, corrected }: { heard: string; corrected: string },
  people: readonly DirectoryPerson[],
): DirectoryPerson[] {
  const asCorrected = turnsOf(ports, corrected);
  const tried = new Set<string>();
  const found = new Map<VaultPath, DirectoryPerson>();
  turnsOf(ports, heard).forEach((turn, at) => {
    const [name] = namedSpeakers([turn]);
    if (name === undefined || tried.has(name)) return;
    tried.add(name);
    const byHeard = matchSpeakers([name], people);
    // The correction changes spellings, never the turns: turn for turn, the same speaker.
    const corrects = asCorrected[at];
    const matched =
      byHeard.length > 0 || corrects === undefined
        ? byHeard
        : matchSpeakers(namedSpeakers([corrects]), people);
    for (const person of matched) found.set(person.path, person);
  });
  return [...found.values()];
}

/** A meeting's turns; none when it does not follow the contract, and so has none to read. */
function turnsOf(ports: MeetingLinkPorts, text: string): readonly TranscriptTurn[] {
  const reading = validateMeetingFile(ports.markdown, text);
  return reading.ok ? reading.meeting.transcript : [];
}

/** Each relation to set, only while it still holds what was read. */
function relationChanges(
  path: VaultPath,
  properties: Readonly<Record<string, unknown>>,
  changes: Readonly<Record<string, readonly string[]>>,
): PropertyChange[] {
  return Object.entries(changes).map(([key, value]) => ({
    path,
    key,
    expect: priorOf(properties, key),
    to: { value: [...value] },
  }));
}

/** The meeting's `project` set to what its twin or series surely says, only while it still holds what was read. */
function filingChanges(
  path: VaultPath,
  plan: MeetingLinkPlan & Pick<MeetingRead, 'properties'>,
): PropertyChange[] {
  if (plan.filing === null) return [];
  return [
    {
      path,
      key: MEETING_PROJECT_KEY,
      expect: priorOf(plan.properties, MEETING_PROJECT_KEY),
      to: { value: plan.filing.link },
    },
  ];
}

/**
 * The mark of linking still owed (#192) taken out, in the same write as the
 * links: a meeting linked is never left marked, whatever happens after.
 */
function markChanges(
  path: VaultPath,
  properties: Readonly<Record<string, unknown>>,
): PropertyChange[] {
  if (!linkingFailed(properties)) return [];
  return [
    {
      path,
      key: MEETING_LINKS_KEY,
      expect: priorOf(properties, MEETING_LINKS_KEY),
      to: { absent: true },
    },
  ];
}

function priorOf(properties: Readonly<Record<string, unknown>>, key: string): PriorValue {
  return Object.hasOwn(properties, key) ? { value: properties[key] } : { absent: true };
}
