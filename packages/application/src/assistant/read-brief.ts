import {
  briefPartsOf,
  createVaultPath,
  lastMeetingRow,
  MEETING_TYPE,
  openLoopsOf,
  type BriefParts,
  type OpenLoops,
  type VaultPath,
} from '@dfai/domain';
import type { Clock } from '../ports.ts';
import { wallTimeOn, type DueClock } from '../review/review-moment.ts';
import { readLinkedPage, type LinkedSection } from '../linked-pages/read-linked-page.ts';
import {
  citedEntity,
  followUpsAround,
  itemContext,
  problemsOf,
  rowPaths,
  taskStatusWords,
  type AssistantReads,
  type CitedEntity,
  type SectionProblem,
} from './assistant-reads.ts';
import { readAssistantEntity, type AssistantEntity } from './read-entity.ts';
import { NO_STATUS } from './read-open-loops.ts';

/**
 * `brief(entity, date)`: what to know before talking to a person, a company
 * or about a project — or before a meeting — on a day, each item cited.
 */
export interface AssistantBrief
  extends Omit<OpenLoops, 'truncated'>, Omit<BriefParts, 'truncated'> {
  readonly entity: CitedEntity;
  /** The day the brief is for, `YYYY-MM-DD`: meetings and decisions after it are left out. */
  readonly date: string;
  /** Whether a list was cut, or the index held rows back. */
  readonly truncated: boolean;
  readonly problems: readonly SectionProblem[];
}

/**
 * A brief (P32-04), read from the page's linked sections (P30-06) — its
 * meetings, open loops, decisions and linked notes — and, when it has met
 * before, the tasks and decisions of its last meeting on or before `date`.
 * The tasks are as they stand now; `date` says what was met and decided by
 * then, and what is overdue on it. Only the page's own note is read from the
 * vault; nothing is written.
 */
export async function readBrief({
  reads,
  clock,
  path,
  date,
}: {
  reads: AssistantReads;
  clock: DueClock;
  path: VaultPath;
  /** `YYYY-MM-DD`; today, on the app's clock, when null. */
  date: string | null;
}): Promise<AssistantBrief> {
  const entity = await readAssistantEntity({ ...reads, path, tool: 'brief' });
  const day = date ?? clock.today();
  const sections = await pageSections({ reads, clock, entity, day });
  const last = lastMeetingRow(sections, day);
  const lastSections =
    last === null ? [] : await meetingSections(reads, clock, createVaultPath(last.path));
  const status = taskStatusWords(reads.types);
  const sourced = [
    ...rowPaths(sections, ['tasks', 'waiting', 'decisions']),
    ...rowPaths(lastSections, ['tasks']),
  ];
  const followUps = await followUpsAround({
    ...reads,
    entity: entity.path,
    meetings: rowPaths(sections, ['meetings']),
    status,
  });
  const cited = await itemContext({
    reads,
    sourcePaths: sourced,
    followUps: followUps.value,
    day,
    time: wallTimeOn(clock, day),
  });
  const { value: context } = cited;
  const words = status ?? NO_STATUS;
  const loops = openLoopsOf({ sections, followUps: followUps.value, status: words, context });
  const parts = briefPartsOf({
    sections,
    lastMeetingSections: lastSections,
    status: words,
    context,
  });
  return {
    entity: citedEntity(entity, context),
    date: day,
    ...loops,
    ...parts,
    truncated: loops.truncated || parts.truncated,
    problems: [
      ...problemsOf([...sections, ...lastSections]),
      ...followUps.problems,
      ...cited.problems,
    ],
  };
}

/** Every section of the page: its meetings and decisions all, its linked notes the recent ones. */
function pageSections({
  reads,
  clock,
  entity,
  day,
}: {
  reads: AssistantReads;
  clock: Pick<Clock, 'today'>;
  entity: AssistantEntity;
  /** The day the brief is for: "recent" counts back from it, not from today. */
  day: string;
}): Promise<LinkedSection[]> {
  return readLinkedPage({
    ...reads,
    clock,
    asWritten: true,
    notePath: entity.path,
    typeName: entity.type,
    projectStatus: entity.status,
    ranges: { meetings: 'all', decisions: 'all', notes: 'recent' },
    recentOn: day,
  });
}

/** The tasks and decisions of one meeting, as its own page lists them. */
function meetingSections(
  reads: AssistantReads,
  clock: Pick<Clock, 'today'>,
  path: VaultPath,
): Promise<LinkedSection[]> {
  return readLinkedPage({
    ...reads,
    clock,
    asWritten: true,
    notePath: path,
    typeName: MEETING_TYPE,
    only: ['tasks', 'decisions'],
  });
}
