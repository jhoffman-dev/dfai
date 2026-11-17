/**
 * Which tasks an Inbox task may be a copy of (#899, #906): a title rule that
 * gives a short list of candidates, each with why it was listed. It never
 * says an item is a duplicate. Inbox assist hands the list to Claude, and a
 * duplicate is planned only when this rule and Claude agree (`assist-plan.ts`).
 *
 * Two titles are compared as words: folded to one case, punctuation and
 * spacing dropped, and the filler a quick capture adds ("please", "todo",
 * "re:") left out. A task under one project is never a copy of a task under
 * another; one without a project may be a copy of anything.
 */

import { isArchivedPath } from '../archive/archive.ts';
import type { VaultPath } from '../vault/vault-path.ts';
import { FINISHED_TASK_STATUS, type GtdStatus } from './gtd-status.ts';

/** A task in the vault, as the rule compares it. */
export interface TaskCandidate {
  readonly path: VaultPath;
  /** Its note's title, as the vault shows it. */
  readonly title: string;
  /** The project or area it is filed under, or null. */
  readonly project: VaultPath | null;
  readonly status: GtdStatus | null;
}

/**
 * Why a task was listed, surest first:
 *
 * - `same-title` — the same words in the same order;
 * - `same-words` — the same words in another order ("Payroll contract: renew");
 * - `contained` — every word of the shorter title, of at least {@link CONTAINED_MIN_WORDS}, is in the longer.
 */
export type TaskLikeness = 'same-title' | 'same-words' | 'contained';

/** A task that may be the one an item copies, and why it was listed. */
export interface PossibleDuplicateTask {
  readonly task: TaskCandidate;
  readonly likeness: TaskLikeness;
}

/** The most candidates listed for one item: each one is a path in the prompt, and a long list is no shortlist. */
export const DUPLICATE_TASKS_PER_ITEM = 3;

/**
 * The fewest words a shorter title needs before its words found in a longer
 * one count: "call mara" is in half the tasks a vault holds.
 */
export const CONTAINED_MIN_WORDS = 3;

/** Words a quick capture adds that say nothing about the task. */
export const TITLE_FILLER: ReadonlySet<string> = new Set([
  'a',
  'an',
  'the',
  'to',
  'please',
  'pls',
  'todo',
  're',
  'fw',
  'fwd',
  'asap',
  'reminder',
  'remember',
]);

/** A title's words as the rule compares them: one case, no punctuation, no filler. */
export function titleWords(title: string): readonly string[] {
  return title
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '' && !TITLE_FILLER.has(word));
}

/** How alike two titles are, or null when the rule does not list them together. The same either way round. */
export function titleLikeness(left: string, right: string): TaskLikeness | null {
  const a = titleWords(left);
  const b = titleWords(right);
  if (a.length === 0 || b.length === 0) return null;
  if (a.join(' ') === b.join(' ')) return 'same-title';
  const setA = new Set(a);
  const setB = new Set(b);
  const [fewer, more] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  if (![...fewer].every((word) => more.has(word))) return null;
  if (fewer.size === more.size) return 'same-words';
  return fewer.size >= CONTAINED_MIN_WORDS ? 'contained' : null;
}

const RANK: Readonly<Record<TaskLikeness, number>> = {
  'same-title': 0,
  'same-words': 1,
  contained: 2,
};

/**
 * The tasks `item` may copy, surest first and then by path, at most
 * {@link DUPLICATE_TASKS_PER_ITEM}: never the item itself, never a finished
 * task or one in the Archive (a copy of finished work is new work), and never
 * a task under another project than the item's.
 */
export function possibleDuplicateTasks({
  item,
  tasks,
}: {
  item: Pick<TaskCandidate, 'path' | 'title' | 'project'>;
  tasks: readonly TaskCandidate[];
}): PossibleDuplicateTask[] {
  return tasks
    .filter((task) => mayBeCopied(item, task))
    .flatMap((task) => {
      const likeness = titleLikeness(item.title, task.title);
      return likeness === null ? [] : [{ task, likeness }];
    })
    .sort((a, b) => RANK[a.likeness] - RANK[b.likeness] || byPath(a.task.path, b.task.path))
    .slice(0, DUPLICATE_TASKS_PER_ITEM);
}

/** By code point, so the order is the same in every locale. */
const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function mayBeCopied(item: Pick<TaskCandidate, 'path' | 'project'>, task: TaskCandidate): boolean {
  if (task.path === item.path) return false;
  if (task.status === FINISHED_TASK_STATUS || isArchivedPath(task.path)) return false;
  return item.project === null || task.project === null || item.project === task.project;
}
