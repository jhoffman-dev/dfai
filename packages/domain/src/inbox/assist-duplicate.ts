/**
 * Whether an Inbox item copies a task already in the vault (#899, #906).
 * Slice 3 archives an item planned as a duplicate, so a duplicate is planned
 * only when the vault confirms it and Claude merely agrees (#907):
 *
 * - the title rule found the very same title (`same-title`), not the same
 *   words in another order nor a title within a longer one;
 * - Claude, sure the item is a task, picked that task;
 * - the task is filed where the item is, or would be: the same project, or none for both;
 * - the task does not repeat (anything written under its recurrence), is not
 *   someday, longterm or deferred, and has no due date written that reads as no day;
 * - the item and the task do not differ on a due date, who it waits on, a
 *   defer date, its people or its contexts, where both have one;
 * - and the item is not the newer of two captures in the Inbox, nor one of two
 *   that cannot be told apart.
 *
 * Anything else the rule or Claude found is a question naming the vault's
 * own title. A planned duplicate names everything written on this copy that
 * the kept task lacks or may lack (`newerHolds`), so applying it can ask
 * before anything is lost: it only ever errs toward naming more.
 */

import type { PossibleDuplicateTask, TaskCandidate } from '../gtd/task-similarity.ts';
import type { VaultPath } from '../vault/vault-path.ts';
import type { AssistItemAnswer } from './assist-answer.ts';
import { sameProject, type AssistHeld, type HeldField } from './assist-held.ts';
import { OFF_LIST } from './assist-people.ts';

/** A planned duplicate: the task kept, and what this copy holds that it lacks. */
export interface AssistDuplicate {
  readonly kind: 'duplicate';
  readonly of: { readonly path: VaultPath; readonly title: string };
  /**
   * The keys written on this copy that the kept task lacks, has differently,
   * or is not read for, each in lower case, and `body` for words of its own.
   */
  readonly newerHolds: readonly string[];
}

/** What the duplicate rule reads of one item. */
export interface AssistCopyFacts {
  readonly answer: AssistItemAnswer;
  /** What the item has written on it under the fields a plan fills. */
  readonly held: AssistHeld;
  /** The one project Claude would file it under, or null. */
  readonly filing: VaultPath | null;
  readonly candidates: readonly PossibleDuplicateTask[];
  /** The title of another Inbox item this one is the newer copy of, or can't be told from; null for none. */
  readonly inboxTwin: string | null;
  readonly listedPeople: HeldField | null;
  /** Whether the item has words of its own beyond its title. */
  readonly hasBody: boolean;
  /** Every property written on the item, by lower-case key; left out where a caller read none. */
  readonly written?: ReadonlyMap<string, readonly string[]>;
}

/**
 * Keys that say what a note is or when it was touched, not what the task
 * holds: never counted as something this copy has that the kept one lacks.
 * So are DFAI's own `atlas_` keys.
 */
export const COPY_BOOKKEEPING_KEYS: ReadonlySet<string> = new Set([
  'type',
  'status',
  'title',
  'created',
  'updated',
  'modified',
  'id',
]);

type Question = { readonly kind: 'ask'; readonly question: string };
const ask = (question: string): Question => ({ kind: 'ask', question });
const sameAs = (task: { title: string }) => ask(`Is this the same as ${task.title}?`);

/** The duplicate planned, a question, or null when neither the rule nor Claude found a copy. */
export function assistDuplicate(facts: AssistCopyFacts): AssistDuplicate | Question | null {
  const { answer, candidates } = facts;
  if (facts.inboxTwin !== null) {
    return ask(`Is this the same as ${facts.inboxTwin}, also in your Inbox?`);
  }
  if (answer.duplicateOf === null) {
    const found = candidates.find((each) => each.likeness === 'same-title');
    return found === undefined ? null : sameAs(found.task);
  }
  const picked = candidates.find((each) => each.task.path === answer.duplicateOf);
  if (picked === undefined) return ask(OFF_LIST);
  const { task } = picked;
  if (picked.likeness !== 'same-title' || answer.kind !== 'task') return sameAs(task);
  if (!filedAlike(facts, task) || !dueAlike(facts, task) || !settled(task)) return sameAs(task);
  if (differs(facts, task)) return sameAs(task);
  return {
    kind: 'duplicate',
    of: { path: task.path, title: task.title },
    newerHolds: newerHolds(facts, task),
  };
}

/** Whether the task is filed where the item is, or Claude would file it: the same project, or none for both. */
function filedAlike({ held, filing }: AssistCopyFacts, task: TaskCandidate): boolean {
  if (held.project !== null)
    return task.project !== null && sameProject(held.project, task.project);
  return filing === task.project;
}

/** Whether the item is due on the task's day, where both have one; a due date written but unread on either never is. */
function dueAlike({ held, answer }: AssistCopyFacts, task: TaskCandidate): boolean {
  if (task.dueUnread || (held.due !== null && held.due.resolved === null)) return false;
  const mine = held.due?.resolved ?? answer.due;
  return task.due === null || mine === null || mine === task.due;
}

/** A task that neither repeats nor waits for later: someday, longterm and deferred tasks are questions. */
function settled(task: TaskCandidate): boolean {
  if (task.recurrence !== null || task.defer !== null) return false;
  return task.status !== 'someday' && task.status !== 'longterm';
}

const folded = (names: readonly string[]) =>
  new Set(names.map((name) => name.trim().toLowerCase()).filter((name) => name !== ''));

/** Whether two lists, both written, name different things. */
function bothDiffer(mine: readonly string[], theirs: readonly string[]): boolean {
  const [a, b] = [folded(mine), folded(theirs)];
  if (a.size === 0 || b.size === 0) return false;
  return a.size !== b.size || [...a].some((each) => !b.has(each));
}

/** What the item says it waits on, as written. */
function waitsOn({ held, written }: AssistCopyFacts): readonly string[] {
  return written?.get('waiting_on') ?? held.waitingOn?.written ?? [];
}

/** Whether the item and the task, both having one, differ on who it waits on, a defer date, its people or contexts. */
function differs(facts: AssistCopyFacts, task: TaskCandidate): boolean {
  const { held, written, listedPeople } = facts;
  const deferred =
    written?.get('defer') ?? (held.defer === null ? [] : [held.defer.resolved ?? '']);
  return (
    bothDiffer(waitsOn(facts), task.waitingOn.split(', ')) ||
    bothDiffer(deferred, task.defer === null ? [] : [task.defer]) ||
    bothDiffer(listedPeople?.written ?? [], task.people) ||
    bothDiffer(written?.get('contexts') ?? [], task.contexts)
  );
}

/** What the task holds under a key, where it is read; undefined where it is not. */
function taskHolds(task: TaskCandidate, key: string): readonly string[] | undefined {
  const of: Readonly<Record<string, readonly string[]>> = {
    due: task.due === null ? [] : [task.due],
    defer: task.defer === null ? [] : [task.defer],
    waiting_on: task.waitingOn === '' ? [] : task.waitingOn.split(', '),
    contexts: task.contexts,
    people: task.people,
  };
  return of[key];
}

/**
 * Every key written on the item that the task lacks, has differently, or is
 * not read for — bookkeeping aside — and `body` for words of its own. What
 * it holds under the fields a plan fills counts too, read or not: this only
 * ever errs toward naming more.
 */
function newerHolds(facts: AssistCopyFacts, task: TaskCandidate): string[] {
  const keys = [...new Set([...(facts.written?.keys() ?? []), ...heldKeys(facts)])];
  const holds = keys.filter((key) => {
    if (COPY_BOOKKEEPING_KEYS.has(key) || key.startsWith('atlas_')) return false;
    // Filed alike already: the same project, or none for both.
    if (key === 'project') return false;
    const theirs = taskHolds(task, key);
    const mine = facts.written?.get(key) ?? [];
    return theirs === undefined || theirs.length === 0 || bothDiffer(mine, theirs);
  });
  return facts.hasBody ? [...holds, 'body'] : holds;
}

/** The keys an item holds under the fields a plan fills, as its row reads them. */
function heldKeys({ held, listedPeople }: AssistCopyFacts): string[] {
  return [
    held.due !== null ? 'due' : null,
    held.project !== null ? 'project' : null,
    held.waitingOn !== null ? 'waiting_on' : null,
    held.defer !== null ? 'defer' : null,
    listedPeople !== null ? 'people' : null,
  ].filter((key) => key !== null);
}
