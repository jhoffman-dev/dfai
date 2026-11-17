/**
 * Inbox assist's words (#899): the one sentence that sums a plan up, and
 * what each row says would be done. Said here, so every surface that shows a
 * plan says it the same way and the page holds no rule.
 */

import type { AssistPersonStep } from './assist-people.ts';
import { ASSIST_ITEMS_PER_ASK, type AssistRow, type AssistStep } from './assist-plan.ts';

/** How a row's step is shown: filed (a task or a note), a duplicate, a question, or left. */
export type AssistTone = 'file' | 'duplicate' | 'ask' | 'leave';

export function assistTone(step: AssistStep): AssistTone {
  if (step.kind === 'task') return 'file';
  return step.kind;
}

/**
 * The plan in one sentence: "14 items: would act on 6, link 3 people, add 1
 * person, 1 duplicate, 2 questions, would leave 2". A part with none is left
 * out; no items at all is said plainly.
 */
export function assistSummary(rows: readonly AssistRow[]): string {
  if (rows.length === 0) return 'Nothing to suggest: no items to look at.';
  const count = (tone: AssistTone) => rows.filter((row) => assistTone(row.step) === tone).length;
  const people = (kind: AssistPersonStep['kind']) =>
    rows.reduce((sum, row) => sum + row.people.filter((each) => each.kind === kind).length, 0);
  const [acted, linked, added, copies, asked, left] = [
    count('file'),
    people('link'),
    people('add'),
    count('duplicate'),
    count('ask'),
    count('leave'),
  ];
  const parts = [
    acted > 0 ? `would act on ${acted}` : null,
    linked > 0 ? `link ${linked} ${linked === 1 ? 'person' : 'people'}` : null,
    added > 0 ? `add ${added} ${added === 1 ? 'person' : 'people'}` : null,
    copies > 0 ? `${copies} ${copies === 1 ? 'duplicate' : 'duplicates'}` : null,
    asked > 0 ? `${asked} ${asked === 1 ? 'question' : 'questions'}` : null,
    left > 0 ? `would leave ${left}` : null,
  ].filter((part) => part !== null);
  return `${rows.length} ${rows.length === 1 ? 'item' : 'items'}: ${parts.join(', ')}`;
}

/** What would be done with a row's item, in DFAI's words. */
export function assistStepWords(step: AssistStep): string {
  switch (step.kind) {
    case 'task':
      return taskWords(step);
    case 'file':
      return `File under ${step.project.title}`;
    case 'duplicate':
      return `Looks like a duplicate of ${step.of.title}`;
    case 'leave':
      return 'Leave it';
    case 'ask':
      return 'Ask you';
  }
}

function taskWords(step: Extract<AssistStep, { kind: 'task' }>): string {
  const head = step.makeTask ? 'Make it a task' : 'Keep it a task';
  const parts = [
    step.project === null ? head : `${head} under ${step.project.title}`,
    step.due === null ? null : `due ${step.due}`,
    step.waitingOn === null ? null : `waiting on ${step.waitingOn.title}`,
  ].filter((part) => part !== null);
  return parts.join(', ');
}

/** What would be done about the people a row names, a line each: "Links Mara Quill", "Would add Tobias Fenn". */
export function assistPeopleWords(row: AssistRow): string[] {
  return row.people.map((each) =>
    each.kind === 'link' ? `Links ${each.person.title}` : `Would add ${each.name}`,
  );
}

/** The row's one short reason: its question, why it is left, or Claude's why. */
export function assistReason(row: AssistRow): string {
  if (row.step.kind === 'ask') return row.step.question;
  if (row.step.kind === 'leave') return row.step.because;
  return row.why ?? '';
}

/** What is said of the items after those one ask looked at; null when there are none. */
export function assistMoreWords(notConsidered: number): string | null {
  if (notConsidered === 0) return null;
  const items = notConsidered === 1 ? '1 more item was' : `${notConsidered} more items were`;
  return `${items} not looked at: one ask looks at ${ASSIST_ITEMS_PER_ASK}.`;
}
