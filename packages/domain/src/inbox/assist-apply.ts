/**
 * What applying one Inbox assist row does (#909): the exact set of changes a
 * planned row comes to, derived from the row alone, and what is said once
 * they are done. Whether they may still be done is `assist-recheck.ts`'s.
 *
 * Every change only fills what is empty; nothing written is ever written
 * over. Three kinds of row are applied:
 *
 * - **a task**: made a task where it is not one yet, given the project and
 *   the due date the plan found empty, and linked to its people;
 * - **a note filed**: filed under its one project, and linked to its people;
 * - **a duplicate**: the Inbox item itself — never the kept task — stamped
 *   with the task it copies and moved to the Archive.
 *
 * A task the plan has wait on someone is not applied in this slice: the
 * person is written only with the Waiting status, and the item's status is
 * written already (an Inbox task's is `inbox`), so applying it would write
 * over a field. A question, and an item left, are never applied.
 */

import { DUPLICATE_OF_KEY } from '../meetings/meeting-arrival.ts';
import { MEETING_PEOPLE_KEY } from '../meeting-links/meeting-link-keys.ts';
import { TASK_KEYS } from '../gtd/gtd-status.ts';
import { FILED_UNDER_KEY } from '../types/para.ts';
import type { VaultPath } from '../vault/vault-path.ts';
import type { AssistRow, AssistTarget } from './assist-plan.ts';

/** Filling in a task or a note: only what the plan found empty. */
export interface AssistFill {
  /** True when the item is made a task: it is not one yet. */
  readonly makeTask: boolean;
  readonly project: AssistTarget | null;
  /** `YYYY-MM-DD`, or null. */
  readonly due: string | null;
}

/** A person to add: their cleaned name, and the address exactly as the item gives it. */
export interface AssistNewPerson {
  readonly name: string;
  readonly email: string;
}

/** What applying one row writes. */
export interface AssistApplyStep {
  readonly path: VaultPath;
  readonly title: string;
  /** The task or note filled in; null for a duplicate. */
  readonly fill: AssistFill | null;
  /** People already in People, linked under `people`. */
  readonly links: readonly AssistTarget[];
  /** New people, each made in People and then linked under `people`. */
  readonly adds: readonly AssistNewPerson[];
  /** The task a duplicate copies: the item is stamped with it and archived. Null for any other row. */
  readonly duplicateOf: AssistTarget | null;
}

/** Why a planned row is shown but not applied in this slice; null for a row that is. */
export function assistNotAppliable(row: AssistRow): string | null {
  const { step } = row;
  if (step.kind === 'ask' || step.kind === 'leave') return 'Questions and items left are never applied.';
  if (step.kind === 'task' && step.waitingOn !== null) {
    return 'Who a task waits on is set by hand for now: it changes the task’s status.';
  }
  return null;
}

/** The changes a planned row comes to; null for a row that is not applied. */
export function assistApplyStep(row: AssistRow): AssistApplyStep | null {
  if (assistNotAppliable(row) !== null) return null;
  const { step } = row;
  const base = { path: row.path, title: row.title };
  if (step.kind === 'duplicate') {
    return { ...base, fill: null, links: [], adds: [], duplicateOf: step.of };
  }
  const links = row.people.flatMap((each) => (each.kind === 'link' ? [each.person] : []));
  const adds = row.people.flatMap((each) =>
    each.kind === 'add' ? [{ name: each.name, email: each.email }] : [],
  );
  const fill: AssistFill =
    step.kind === 'task'
      ? { makeTask: step.makeTask, project: step.project, due: step.due }
      : { makeTask: false, project: step.kind === 'file' ? step.project : null, due: null };
  return { ...base, fill, links, adds, duplicateOf: null };
}

/**
 * The frontmatter keys applying `step` writes on the item, each one that must
 * still be empty when it is applied: `type` and `status` for a note made a
 * task, `project` and `due` when filled, `people` when anyone is linked, and
 * the duplicate stamp.
 */
export function assistStepKeys(step: AssistApplyStep): string[] {
  const { fill } = step;
  return [
    ...(fill?.makeTask === true ? ['type', TASK_KEYS.status] : []),
    ...(fill?.project != null ? [FILED_UNDER_KEY] : []),
    ...(fill?.due != null ? [TASK_KEYS.due] : []),
    ...(step.links.length + step.adds.length > 0 ? [MEETING_PEOPLE_KEY] : []),
    ...(step.duplicateOf !== null ? [DUPLICATE_OF_KEY] : []),
  ];
}

/** Every vault path `step` names: the item, its project, its people and the task it copies. */
export function assistStepPaths(step: AssistApplyStep): VaultPath[] {
  return [
    step.path,
    ...(step.fill?.project != null ? [step.fill.project.path] : []),
    ...step.links.map((person) => person.path),
    ...(step.duplicateOf !== null ? [step.duplicateOf.path] : []),
  ];
}

/** What applying `step` did, in a sentence or two: "Made it a task under Larkspur Payroll. Linked Mara Quill." */
export function assistAppliedWords(step: AssistApplyStep): string {
  if (step.duplicateOf !== null) {
    return `Archived as a duplicate of ${step.duplicateOf.title}.`;
  }
  const { fill } = step;
  const under = fill?.project != null ? ` under ${fill.project.title}` : '';
  const due = fill?.due != null ? `, due ${fill.due}` : '';
  const did =
    fill?.makeTask === true
      ? `Made it a task${under}${due}.`
      : under !== ''
        ? `Filed it${under}${due}.`
        : due !== ''
          ? `Set it due ${fill!.due}.`
          : '';
  const people = [
    ...step.links.map((person) => `Linked ${person.title}.`),
    ...step.adds.map((person) => `Added ${person.name}.`),
  ];
  return [did, ...people].filter((part) => part !== '').join(' ');
}
