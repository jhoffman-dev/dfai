import {
  blocksHeld,
  compileBlocksQuery,
  compileFollowUpsQuery,
  compileSourcesQuery,
  followUpRowsOf,
  isQueryIdentifier,
  linkingAmong,
  linkedPageType,
  messageWithoutPaths,
  noteCitation,
  PERSON_TYPE,
  sourceBlockOf,
  sourcesOf,
  statusOf,
  taskTypeOf,
  type AnsweredSection,
  type Citation,
  type FollowUpRow,
  type ItemContext,
  type ObjectType,
  type BlockRef,
  type TaskStatusWords,
  type VaultPath,
} from '@dfai/domain';
import type { IndexPort } from '../index/ports.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import type { VaultFsPort } from '../vault/ports.ts';
import type { AssistantEntity } from './read-entity.ts';

/*
 * What the assistant's tools share (P32-04): the ports and the vault's types
 * and notes they read with, and the two index questions — sources and
 * follow-ups — each answered in one statement.
 */

/** What every assistant read is asked with. */
export interface AssistantReads {
  readonly index: IndexPort;
  readonly fs: VaultFsPort;
  readonly markdown: MarkdownPort;
  readonly types: readonly ObjectType[];
  readonly notePaths: readonly VaultPath[];
}

/** The page an answer is about, cited like every item in it. */
export interface CitedEntity {
  readonly path: string;
  readonly title: string;
  readonly type: string;
  readonly cite: Citation;
}

/** A section of the page that could not be answered, and why; the others still stand. */
export interface SectionProblem {
  readonly section: string;
  readonly problem: string;
}

/**
 * The status words of the vault's Task type: `status`, finished by `archive`,
 * unless it says otherwise. Null when the type has no status, or one whose
 * key the query language cannot name — a linked page reads no such key either.
 */
export function taskStatusWords(types: readonly ObjectType[]): TaskStatusWords | null {
  const status = statusOf(taskTypeOf(types));
  return status === null || !isQueryIdentifier(status.key)
    ? null
    : { key: status.key, done: status.done };
}

/** The entity, cited, as an answer starts with it. */
export function citedEntity(entity: AssistantEntity, context: ItemContext): CitedEntity {
  return {
    path: entity.path,
    title: entity.title,
    type: entity.type,
    cite: noteCitation(entity.path, context.targetOf),
  };
}

/** Each unanswerable section, said once. */
export function problemsOf(sections: readonly AnsweredSection[]): SectionProblem[] {
  return sections.flatMap((section) =>
    section.problem === null ? [] : [{ section: section.id, problem: section.problem }],
  );
}

/** What an answer holds besides its problems, and the problems met reading it. */
export interface WithProblems<Value> {
  readonly value: Value;
  readonly problems: readonly SectionProblem[];
}

/**
 * Asks the index something an answer can do without: when the index fails, the
 * answer stands on `fallback` and says which part it is missing. Only the
 * index's own failure is caught — it is the only thing `ask` does.
 */
export async function askedOrProblem<Value>({
  part,
  fallback,
  ask,
}: {
  /** What the answer is missing without it. */
  part: string;
  fallback: Value;
  ask: () => Promise<Value>;
}): Promise<WithProblems<Value>> {
  try {
    return { value: await ask(), problems: [] };
  } catch (error) {
    const problem = `The index could not answer: ${messageWithoutPaths(error)}`;
    return { value: fallback, problems: [{ section: part, problem }] };
  }
}

/** The `source` of every one of these notes, read in one statement. */
function sourcesFor(
  index: IndexPort,
  paths: readonly string[],
): Promise<WithProblems<ReadonlyMap<string, string>>> {
  return askedOrProblem({
    part: 'sources',
    fallback: new Map<string, string>(),
    ask: async () => {
      const compiled = compileSourcesQuery(paths);
      if (compiled === null) return new Map<string, string>();
      return sourcesOf((await index.query(compiled.sql, compiled.parameters)).rows);
    },
  });
}

/** Which of the blocks the `sources` name the index holds, in one statement. */
function blocksAmong(
  index: IndexPort,
  blocks: readonly BlockRef[],
): Promise<WithProblems<ItemContext['hasBlock']>> {
  return askedOrProblem({
    part: 'sources',
    // A block that cannot be checked is not vouched for: cited as its note.
    fallback: () => false,
    ask: async () => {
      const compiled = compileBlocksQuery(blocks);
      if (compiled === null) return () => false;
      return blocksHeld((await index.query(compiled.sql, compiled.parameters)).rows);
    },
  });
}

/**
 * How the items of an answer are cited: links among the vault's notes, each
 * item's `source`, and whether the block a `source` names is still there.
 * A `source` or block the index cannot be asked leaves items uncited and the
 * answer says so.
 */
export async function itemContext({
  reads,
  sourcePaths,
  followUps = [],
  day,
  time,
}: {
  reads: AssistantReads;
  /** The tasks and decisions whose `source` an item cites. */
  sourcePaths: readonly string[];
  /** Follow-ups, which carry their own `source`. */
  followUps?: readonly FollowUpRow[];
  day: string;
  /** The wall time asked at, when `day` is the clock's today (`wallTimeOn`); null otherwise. */
  time: string | null;
}): Promise<WithProblems<ItemContext>> {
  const sources = await sourcesFor(reads.index, sourcePaths);
  const linking = linkingAmong(reads.notePaths);
  const written = [...sources.value.values(), ...followUps.map((row) => row.source)];
  const named = written.flatMap((source) => sourceBlockOf(source, linking.resolve) ?? []);
  const blocks = await blocksAmong(reads.index, named);
  const context = { ...linking, sources: sources.value, day, time, hasBlock: blocks.value };
  return { value: context, problems: [...sources.problems, ...blocks.problems] };
}

/**
 * The open follow-ups linked with the page or any of its meetings; none
 * without a Task status. Their own `source`s are cited with the rest: pass
 * them to {@link itemContext}.
 */
export function followUpsAround({
  index,
  types,
  entity,
  meetings,
  status,
}: {
  index: IndexPort;
  types: readonly ObjectType[];
  entity: string;
  meetings: readonly string[];
  status: TaskStatusWords | null;
}): Promise<WithProblems<FollowUpRow[]>> {
  return askedOrProblem({
    part: 'follow-ups',
    fallback: [],
    ask: async () => {
      const task = taskTypeOf(types);
      if (task === null || status === null) return [];
      const person = types.find((type) => linkedPageType(type.name) === PERSON_TYPE);
      const compiled = compileFollowUpsQuery({
        entity,
        meetings,
        taskType: task.name,
        personType: person?.name ?? null,
        statusKey: status.key,
        done: status.done,
      });
      return followUpRowsOf((await index.query(compiled.sql, compiled.parameters)).rows);
    },
  });
}

/** The paths of the rows of these sections. */
export function rowPaths(
  sections: readonly AnsweredSection[],
  ids: readonly AnsweredSection['id'][],
): string[] {
  return sections
    .filter((section) => ids.includes(section.id))
    .flatMap((section) => section.rows.map((row) => row.path));
}
