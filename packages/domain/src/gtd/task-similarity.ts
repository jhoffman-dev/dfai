/**
 * Which tasks an Inbox task may be a copy of (#899, #906): a title rule that
 * gives a short list of candidates, each with why it was listed. It never
 * says an item is a duplicate. Inbox assist hands the list to Claude, and a
 * duplicate is planned only when this rule and Claude agree (`assist-plan.ts`).
 *
 * Two titles are compared as words: folded to one case, punctuation and
 * spacing dropped, and the filler a quick capture adds ("please", "todo",
 * "fwd:") left out — only words that cannot change what the task is. A task
 * under one project is never a copy of a task under another; one without a
 * project may be a copy of anything. Only `same-title` may ever be planned as
 * a duplicate: the same words in another order can be another task ("Pay
 * Mara for Tobias", "Pay Tobias for Mara").
 */

import { isArchivedPath } from '../archive/archive.ts';
import type { VaultPath } from '../vault/vault-path.ts';
import { FINISHED_TASK_STATUS, NEW_TASK_STATUS, type GtdStatus } from './gtd-status.ts';

/** A task in the vault, as the rule compares it. */
export interface TaskCandidate {
  readonly path: VaultPath;
  /** Its note's title, as the vault shows it. */
  readonly title: string;
  /** The project or area it is filed under, or null. */
  readonly project: VaultPath | null;
  readonly status: GtdStatus | null;
  /** `YYYY-MM-DD`, or null. */
  readonly due: string | null;
  /** The time of day its due names (#928), `HH:MM`; absent for a date-only due. */
  readonly dueTime?: string;
  /** True when its due is written as several entries: never the same as one (PR #930 audit). */
  readonly dueMany?: boolean;
  /** True when a due date is written that does not read as one day. */
  readonly dueUnread: boolean;
  /** `YYYY-MM-DD`: the day it comes back into play; null when none is read. */
  readonly defer: string | null;
  /** How it repeats, as written in any form, or null: a repeating task is never planned as one an item copies. */
  readonly recurrence: string | null;
  /** Who it waits on, as written; '' for nobody. */
  readonly waitingOn: string;
  /** Its contexts, as written. */
  readonly contexts: readonly string[];
  /** The people it lists, as written. */
  readonly people: readonly string[];
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

/**
 * Words a quick capture adds that cannot change what the task is. "to", "re"
 * and "remember" are not among them: "Move to Tobias" is not "Move Tobias".
 */
export const TITLE_FILLER: ReadonlySet<string> = new Set([
  'a',
  'an',
  'the',
  'please',
  'pls',
  'todo',
  'fw',
  'fwd',
]);

/**
 * The most words of a title compared: a capture can hold a whole page as its
 * title, and comparing it with every task would hold Suggest up.
 */
export const TITLE_WORDS_MAX = 64;

/** A title's words as the rule compares them: one case, no punctuation, no filler, at most {@link TITLE_WORDS_MAX}. */
export function titleWords(title: string): readonly string[] {
  return foldTitle(title).words;
}

/** A title folded once: its words, and whether any were left past the cap. */
interface FoldedTitle {
  readonly words: readonly string[];
  readonly cut: boolean;
}

function foldTitle(title: string): FoldedTitle {
  const read = title.slice(0, TITLE_WORDS_MAX * 64);
  const words: string[] = [];
  for (const word of read
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)) {
    if (word === '' || TITLE_FILLER.has(word)) continue;
    if (words.length === TITLE_WORDS_MAX) return { words, cut: true };
    words.push(word);
  }
  return { words, cut: read.length < title.length };
}

/** How alike two titles are, or null when the rule does not list them together. The same either way round. */
export function titleLikeness(left: string, right: string): TaskLikeness | null {
  return foldedLikeness(foldTitle(left), foldTitle(right));
}

/**
 * How alike two folded titles are. Titles cut at the cap are never the same
 * title, nor the same words: what lies past it is unread, so they are at
 * most one within the other — a question, never a plan (#907).
 */
function foldedLikeness(left: FoldedTitle, right: FoldedTitle): TaskLikeness | null {
  const [a, b] = [left.words, right.words];
  if (a.length === 0 || b.length === 0) return null;
  const cut = left.cut || right.cut;
  if (a.length === b.length && a.every((word, at) => word === b[at])) {
    return cut ? 'contained' : 'same-title';
  }
  const setA = new Set(a);
  const setB = new Set(b);
  const [fewer, more] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  if (![...fewer].every((word) => more.has(word))) return null;
  if (fewer.size === more.size && !cut) return 'same-words';
  return fewer.size >= CONTAINED_MIN_WORDS ? 'contained' : null;
}

const RANK: Readonly<Record<TaskLikeness, number>> = {
  'same-title': 0,
  'same-words': 1,
  contained: 2,
};

/**
 * The tasks `item` may copy, surest first and then by path, at most
 * {@link DUPLICATE_TASKS_PER_ITEM}: never the item itself, never a task
 * still at the Inbox status (it is an item too: two captures are not one
 * another's kept copy), never a finished task or one in the Archive (a copy
 * of finished work is new work), and never a task under another project than
 * the item's. The item's title is folded once, whatever the vault holds.
 */
export function possibleDuplicateTasks({
  item,
  tasks,
}: {
  item: Pick<TaskCandidate, 'path' | 'title' | 'project'>;
  tasks: readonly TaskCandidate[];
}): PossibleDuplicateTask[] {
  const folded = foldTitle(item.title);
  return tasks
    .filter((task) => mayBeCopied(item, task))
    .flatMap((task) => {
      const likeness = foldedLikeness(folded, foldTitle(task.title));
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
  if (task.status === NEW_TASK_STATUS) return false;
  return item.project === null || task.project === null || item.project === task.project;
}
