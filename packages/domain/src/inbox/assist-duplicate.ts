/**
 * Whether an Inbox item copies a task already in the vault (#899, #906).
 * Slice 3 archives an item planned as a duplicate, so a duplicate is planned
 * only when the vault confirms it and Claude merely agrees (#907):
 *
 * - the title rule found the very same title (`same-title`), not the same
 *   words in another order nor a title within a longer one;
 * - Claude, sure the item is a task, picked that task;
 * - the task is filed where the item is, or would be: the same project, or none for both;
 * - the task does not repeat, and is not due on another day than the item;
 * - and the item is not the newer of two captures in the Inbox, nor one of two
 *   that cannot be told apart.
 *
 * Anything else the rule or Claude found is a question naming the vault's
 * own title. A planned duplicate says what this copy holds that the kept task
 * lacks, so applying it can ask before anything is lost.
 */

import type { PossibleDuplicateTask, TaskCandidate } from '../gtd/task-similarity.ts';
import type { VaultPath } from '../vault/vault-path.ts';
import type { AssistItemAnswer } from './assist-answer.ts';
import { sameProject, type AssistHeld, type HeldField } from './assist-held.ts';
import { OFF_LIST } from './assist-people.ts';

/** What the newer copy holds that the task it copies lacks. */
export type AssistCopyHolds = 'due' | 'project' | 'waitingOn' | 'people' | 'notes';

/** A planned duplicate: the task kept, and what this copy holds that it lacks. */
export interface AssistDuplicate {
  readonly kind: 'duplicate';
  readonly of: { readonly path: VaultPath; readonly title: string };
  readonly newerHolds: readonly AssistCopyHolds[];
}

/** What the duplicate rule reads of one item. */
export interface AssistCopyFacts {
  readonly answer: AssistItemAnswer;
  /** What the item has written on it. */
  readonly held: AssistHeld;
  /** The one project Claude would file it under, or null. */
  readonly filing: VaultPath | null;
  readonly candidates: readonly PossibleDuplicateTask[];
  /** The title of another Inbox item this one is the newer copy of, or can't be told from; null for none. */
  readonly inboxTwin: string | null;
  readonly listedPeople: HeldField | null;
  /** Whether the item has words of its own beyond its title. */
  readonly hasBody: boolean;
}

type Question = { readonly kind: 'ask'; readonly question: string };
const ask = (question: string): Question => ({ kind: 'ask', question });
const sameAs = (task: { title: string }) => ask(`Is this the same as ${task.title}?`);

/** The duplicate planned, a question, or null when neither the rule nor Claude found a copy. */
export function assistDuplicate(facts: AssistCopyFacts): AssistDuplicate | Question | null {
  const { answer, candidates } = facts;
  if (facts.inboxTwin !== null)
    return ask(`Is this the same as ${facts.inboxTwin}, also in your Inbox?`);
  if (answer.duplicateOf === null) {
    const found = candidates.find((each) => each.likeness === 'same-title');
    return found === undefined ? null : sameAs(found.task);
  }
  const picked = candidates.find((each) => each.task.path === answer.duplicateOf);
  if (picked === undefined) return ask(OFF_LIST);
  const { task } = picked;
  if (picked.likeness !== 'same-title' || answer.kind !== 'task') return sameAs(task);
  if (!filedAlike(facts, task) || !dueAlike(facts, task) || repeats(task)) return sameAs(task);
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

/** Whether the item is due on the task's day, where both have one; a due date written but unread is not. */
function dueAlike({ held, answer }: AssistCopyFacts, task: TaskCandidate): boolean {
  if (task.due === null) return true;
  if (held.due !== null) return held.due.resolved === task.due;
  return answer.due === null || answer.due === task.due;
}

const repeats = (task: TaskCandidate) => task.recurrence !== null && task.recurrence.trim() !== '';

/** What the item holds that the task lacks; people and notes always, the task's own not being read. */
function newerHolds(facts: AssistCopyFacts, task: TaskCandidate): AssistCopyHolds[] {
  const { held } = facts;
  return [
    held.due !== null && task.due === null ? 'due' : null,
    held.project !== null && task.project === null ? 'project' : null,
    held.waitingOn !== null && task.waitingOn.trim() === '' ? 'waitingOn' : null,
    facts.listedPeople !== null ? 'people' : null,
    facts.hasBody ? 'notes' : null,
  ].filter((each): each is AssistCopyHolds => each !== null);
}
