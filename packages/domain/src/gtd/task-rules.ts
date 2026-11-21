import {
  FINISHED_TASK_STATUS,
  gtdStatusOf,
  holdsStatus,
  isBlankValue,
  TASK_KEYS,
  TASK_TYPE,
} from './gtd-status.ts';
import { DUE_KEY, LAST_COMPLETED_KEY, RECURRENCE_KEY } from '../query/repeating-task.ts';
import { focusIsOwn } from '../today/row-read.ts';

type Properties = Readonly<Record<string, unknown>>;

/** What a change to a task comes to under its rules: the changes to write, or why not. */
export type TaskRuleOutcome = { readonly changes: Properties } | { readonly refused: string };

const has = (properties: Properties, key: string) => Object.hasOwn(properties, key);

/** The note as the change leaves it: a null in the changes takes the key out. */
function changed(before: Properties, changes: Properties): Properties {
  const after: Record<string, unknown> = { ...before };
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === undefined) delete after[key];
    else after[key] = value;
  }
  return after;
}

/** The key a note says what it is by. */
const TASK_TYPE_KEY = 'type';

/**
 * Every key the task rules read to judge a change, a repeating task's roll
 * included (ADR-0029). A note that lists one of them twice cannot be judged:
 * which copy the rules should read cannot be told.
 */
export const TASK_RULE_KEYS: readonly string[] = [
  TASK_TYPE_KEY,
  TASK_KEYS.status,
  TASK_KEYS.completed,
  RECURRENCE_KEY,
  DUE_KEY,
];

/** Whether a note's properties say it is a task: its `type` is Task, in any case and spacing. */
export const isTaskNote = (properties: Properties) =>
  String(properties[TASK_TYPE_KEY] ?? '')
    .trim()
    .toLowerCase() === TASK_TYPE;

/** A finished task: Archive, on a note that is a task. */
const isFinished = (note: Properties) =>
  isTaskNote(note) && holdsStatus(note[TASK_KEYS.status], FINISHED_TASK_STATUS);

/**
 * The change with a GTD status it sets in another spelling — `waiting `,
 * `[waiting]` — written as the status itself, on a note that is a task: the
 * index, the board and a tick all read the one spelling.
 */
function spelledAsStatus(before: Properties, changes: Properties): Properties {
  const status = TASK_KEYS.status;
  if (!has(changes, status) || !isTaskNote(changed(before, changes))) return changes;
  const canonical = gtdStatusOf(changes[status]);
  return canonical === null || canonical === changes[status]
    ? changes
    : { ...changes, [status]: canonical };
}

/**
 * The GTD rules a change to a task is held to, whoever makes it — a board
 * drag, the properties panel, a tick, a new note, an automation, the API
 * (ADR-0029). They judge the note the change leaves, not the keys it names:
 *
 * - Waiting is a status like any other: `waiting_on` is never required, and
 *   a task Waiting on nobody is written as asked (#202).
 * - Finishing is a day: a task that becomes finished (Archive) is given
 *   `completed:` today, unless the note it leaves says a day; one taken out
 *   of Archive loses its day, unless the change says one, so unticking
 *   leaves nothing stale behind.
 * - Finishing ends the day's choice (#108): a task finished, or a repeating
 *   one rolled on (the roll writes `lastCompleted` with `due` or `status`),
 *   loses a `focus` that is a day, unless the change names `focus` itself.
 *   One that is the person's own, or blank, is left as it is.
 *
 * A status is read as the index reads it — trimmed, a one-item list as its
 * item — so a spelling the Archive rule reads is held to it too, and a GTD
 * status set in another spelling is written as the status itself.
 *
 * A note that is not a task passes as it is.
 */
export function taskRuleChanges({
  before,
  changes,
  today,
}: {
  before: Properties;
  changes: Properties;
  /** `YYYY-MM-DD`, from the injected clock. */
  today: string;
}): TaskRuleOutcome {
  return heldToRules({ before, changes: spelledAsStatus(before, changes), today });
}

function heldToRules({
  before,
  changes,
  today,
}: {
  before: Properties;
  changes: Properties;
  today: string;
}): TaskRuleOutcome {
  return { changes: withChoiceEnded(before, datedOnFinishing({ before, changes, today })) };
}

function datedOnFinishing({
  before,
  changes,
  today,
}: {
  before: Properties;
  changes: Properties;
  today: string;
}): Properties {
  const after = changed(before, changes);
  const completed = TASK_KEYS.completed;
  if (isFinished(after) && !isFinished(before) && isBlankValue(after[completed])) {
    return { ...changes, [completed]: today };
  }
  const reopened = isFinished(before) && !isFinished(after) && isTaskNote(after);
  if (reopened && !has(changes, completed) && !isBlankValue(before[completed])) {
    return { ...changes, [completed]: null };
  }
  return changes;
}

/**
 * The change, taking a dated `focus` out of a task it finishes or rolls on.
 * A blank `focus:` — as a property template writes it — is no choice, and stays.
 */
function withChoiceEnded(before: Properties, changes: Properties): Properties {
  const focus = TASK_KEYS.focus;
  if (!has(before, focus) || has(changes, focus)) return changes;
  if (isBlankValue(before[focus]) || focusIsOwn(before)) return changes;
  const after = changed(before, changes);
  const finished = isFinished(after) && !isFinished(before);
  return finished || isRoll(after, changes) ? { ...changes, [focus]: null } : changes;
}

/**
 * Whether a change is a repeating task's roll: `lastCompleted` written with
 * the next `due` or the status it goes back to, as the roll writes them — not
 * `lastCompleted` edited alone by hand.
 */
const isRoll = (after: Properties, changes: Properties) =>
  isTaskNote(after) &&
  has(changes, LAST_COMPLETED_KEY) &&
  (has(changes, DUE_KEY) || has(changes, TASK_KEYS.status));
