import {
  aboutWords,
  createVaultPath,
  datedNote,
  isVaultOwner,
  linkingAmong,
  meetingQuotes,
  meetingTurnsOf,
  messageWithoutPaths,
  namesOf,
  noteTitle,
  speaksInMeetings,
  type DatedNote,
  type ItemContext,
  type SpeakerQuote,
  type TranscriptTurn,
  type TurnFilter,
  type VaultPath,
} from '@dfai/domain';
import type { Clock } from '../ports.ts';
import { readLinkedPage } from '../linked-pages/read-linked-page.ts';
import { VaultAccessError } from '../vault/ports.ts';
import {
  askedOrProblem,
  citedEntity,
  problemsOf,
  type AssistantReads,
  type CitedEntity,
  type SectionProblem,
} from './assistant-reads.ts';
import type { FoundPassage, PassageFinder } from './ports.ts';
import { readAssistantEntity } from './read-entity.ts';

/** The most meeting files one answer reads, however many meetings match: a bound on the work, not on the vault. */
export const MEETINGS_READ_CAP = 50;

/** A meeting, and what was said in it that the question asked for. */
export interface QuotedMeeting extends DatedNote {
  /** The turns wanted, in the order spoken, at most `QUOTES_PER_MEETING`. */
  readonly quotes: readonly SpeakerQuote[];
  /** How many turns were wanted before the cap. */
  readonly matched: number;
}

/** `meetings(entity, since, until, about)`: a page's meetings, with who said what in them. */
export interface AssistantMeetings {
  readonly entity: CitedEntity;
  readonly since: string | null;
  /** The last day a meeting may be dated: the day asked for, else the app's today. */
  readonly until: string;
  readonly about: string | null;
  /** The names a person's turns were matched by — the title, file name and aliases; null for a page that does not speak. */
  readonly speakers: readonly string[] | null;
  /** Newest first. With `about`, only meetings where a wanted turn was found. */
  readonly meetings: readonly QuotedMeeting[];
  /** More meetings matched than were read or listed. */
  readonly truncated: boolean;
  readonly problems: readonly SectionProblem[];
}

interface Asked {
  readonly since: string | null;
  /** Meetings dated after this are left out; the app's today when null. */
  readonly until?: string | null;
  readonly about: string | null;
  readonly limit: number;
}

/**
 * A Person's, Company's, Project's or Area's meetings (P32-04), as its
 * linked page lists them, dated from `since` to `until` (the app's today
 * unless asked: a meeting on the calendar is not yet one that was held), each
 * with the turns that answer the question: a person's own turns — `You`
 * among them when the person is the vault's owner — and, with `about`, only
 * the turns holding it, in meetings the `finder` found it in. Only the
 * meetings answered are read from the vault, at most {@link MEETINGS_READ_CAP};
 * a page that does not speak and is asked about nothing reads none.
 * Nothing is written.
 */
export async function readMeetingQuotes({
  reads,
  clock,
  finder,
  path,
  asked,
  selfName = null,
}: {
  reads: AssistantReads;
  clock: Pick<Clock, 'today'>;
  finder: PassageFinder;
  path: VaultPath;
  asked: Asked;
  /** The vault owner's name from the profile: whose `You` turns are the owner's own. */
  selfName?: string | null;
}): Promise<AssistantMeetings> {
  const entity = await readAssistantEntity({ ...reads, path, tool: 'meetings' });
  const sections = await readLinkedPage({
    ...reads,
    clock,
    asWritten: true,
    notePath: entity.path,
    typeName: entity.type,
    ranges: { meetings: 'all' },
    only: ['meetings'],
  });
  const today = clock.today();
  const until = asked.until ?? today;
  // Meetings cite no `source`, so no block is looked up.
  const context = {
    ...linkingAmong(reads.notePaths),
    sources: new Map<string, string>(),
    hasBlock: () => false,
    day: today,
    // Meetings are dated, never due: no time is asked about.
    time: null,
  };
  const listed = sections.flatMap((section) => section.rows).map((row) => datedNote(row, context));
  const inRange = newestFirst(
    listed.filter((meeting) =>
      within({ meeting, since: asked.since, until: asked.until ?? null, today }),
    ),
  );
  const speakers = speaksInMeetings(entity.type)
    ? namesOf(entity.title, entity.frontmatter, noteTitle(entity.path))
    : null;
  const answered = await quotedMeetings({
    reads,
    finder,
    inRange,
    speakers,
    includesSelf: speakers !== null && isVaultOwner(speakers, selfName),
    asked,
    context,
  });
  return {
    entity: citedEntity(entity, context),
    since: asked.since,
    until,
    about: asked.about,
    speakers,
    meetings: answered.meetings,
    truncated: answered.truncated || sections.some((section) => section.truncated),
    problems: [...problemsOf(sections), ...answered.problems],
  };
}

/**
 * Whether a meeting is dated within the days asked. An undated one cannot be
 * said to be after `since` or before an `until` that was asked for; with no
 * `until` asked, only the app's today bounds a dated meeting.
 */
function within({
  meeting,
  since,
  until,
  today,
}: {
  meeting: DatedNote;
  since: string | null;
  until: string | null;
  today: string;
}): boolean {
  if (meeting.date === null) return since === null && until === null;
  return (since === null || meeting.date >= since) && meeting.date <= (until ?? today);
}

/** Newest first, an undated meeting after the dated ones; meetings of one day keep the order given. */
function newestFirst(meetings: readonly DatedNote[]): DatedNote[] {
  return [...meetings].sort((left, right) => {
    if (left.date === right.date) return 0;
    if (left.date === null) return 1;
    if (right.date === null) return -1;
    return left.date < right.date ? 1 : -1;
  });
}

interface Quoting {
  readonly reads: AssistantReads;
  readonly finder: PassageFinder;
  readonly inRange: readonly DatedNote[];
  readonly speakers: readonly string[] | null;
  readonly includesSelf: boolean;
  readonly asked: Asked;
  readonly context: ItemContext;
}

interface Quoted {
  readonly meetings: QuotedMeeting[];
  /** More meetings matched than were read or listed. */
  readonly truncated: boolean;
  readonly problems: readonly SectionProblem[];
}

/** The meetings answered, newest first, and whether more matched than were read or listed. */
async function quotedMeetings(quoting: Quoting): Promise<Quoted> {
  const { asked, inRange } = quoting;
  if (asked.about === null) {
    const read = await readQuoted(quoting, inRange.slice(0, asked.limit), () => null);
    return {
      meetings: read.meetings,
      truncated: inRange.length > asked.limit || read.problems.length > 0,
      problems: read.problems,
    };
  }
  const words = aboutWords(asked.about);
  if (words === null) return { meetings: [], truncated: false, problems: [] };
  const found = await askedOrProblem({
    part: 'search',
    fallback: { passages: [], complete: false },
    ask: () =>
      quoting.finder.find({
        about: asked.about ?? '',
        within: inRange.map((meeting) => meeting.path),
        limit: inRange.length,
      }),
  });
  const byPath = new Map(found.value.passages.map((passage) => [passage.path, passage]));
  // Newest first, as the meetings were given: the ones to read are the newest holding `about`, not the best ranked.
  const candidates = inRange.filter((meeting) => byPath.has(meeting.path));
  const read = await readQuoted(quoting, candidates, (meeting) =>
    passageFilter(byPath.get(meeting.path), words),
  );
  const answered = read.meetings.filter((meeting) => meeting.quotes.length > 0);
  return {
    meetings: answered.slice(0, asked.limit),
    truncated:
      answered.length > asked.limit ||
      candidates.length > MEETINGS_READ_CAP ||
      !found.value.complete ||
      read.problems.length > 0,
    problems: [...found.problems, ...read.problems],
  };
}

/** What a found passage asks of a meeting's turns: the blocks it named, or else the words. */
function passageFilter(
  passage: FoundPassage | undefined,
  words: readonly string[],
): Pick<TurnFilter, 'words' | 'blocks'> {
  return passage?.blocks === null || passage === undefined
    ? { words, blocks: null }
    : { words: null, blocks: new Set(passage.blocks) };
}
/**
 * Reads each meeting — at most {@link MEETINGS_READ_CAP} — and quotes the turns
 * its filter wants, naming each meeting the index lists but that could not be read.
 */
async function readQuoted(
  { reads, speakers, includesSelf, context }: Quoting,
  meetings: readonly DatedNote[],
  about: (meeting: DatedNote) => Pick<TurnFilter, 'words' | 'blocks'> | null,
): Promise<{ meetings: QuotedMeeting[]; problems: SectionProblem[] }> {
  const problems: SectionProblem[] = [];
  const quoted = await Promise.all(
    meetings.slice(0, MEETINGS_READ_CAP).map(async (meeting) => {
      const filter: TurnFilter = {
        speakers,
        includesSelf,
        words: null,
        blocks: null,
        ...about(meeting),
      };
      // A page that does not speak, asked nothing about, lists the meeting unread: every turn is no answer.
      if (filter.speakers === null && filter.words === null && filter.blocks === null) {
        return { ...meeting, quotes: [], matched: 0 };
      }
      const path = createVaultPath(meeting.path);
      const read = await turnsOf(reads, path);
      if (read.problem !== null) problems.push(read.problem);
      const turns = read.turns;
      return { ...meeting, ...meetingQuotes({ path, turns, filter, targetOf: context.targetOf }) };
    }),
  );
  return { meetings: quoted, problems };
}

/**
 * A meeting's turns as its file holds them now. A file the index no longer
 * lists was deleted since and says nothing; one it still lists but that cannot
 * be read is a problem, never a meeting where nothing was said.
 */
async function turnsOf(
  reads: Pick<AssistantReads, 'fs' | 'notePaths'>,
  path: VaultPath,
): Promise<{ turns: readonly TranscriptTurn[]; problem: SectionProblem | null }> {
  try {
    return { turns: meetingTurnsOf((await reads.fs.readTextFile(path)).text), problem: null };
  } catch (error) {
    if (!(error instanceof VaultAccessError)) throw error;
    if (!reads.notePaths.includes(path)) return { turns: [], problem: null };
    const problem = `${noteTitle(path)} could not be read: ${messageWithoutPaths(error)}`;
    return { turns: [], problem: { section: 'meetings', problem } };
  }
}
