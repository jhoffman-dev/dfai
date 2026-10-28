import { MEETING_ITEM_TASK_PROPERTIES } from '../meetings/meeting-extraction-properties.ts';
import { PERSON_TYPE } from '../people/person.ts';
import { FOCUS_PROPERTY } from '../today/chosen.ts';
import { FILED_UNDER, type BuiltInTypeFile } from '../types/para.ts';
import type { ObjectType, PropertyDef } from '../types/property-def.ts';
import { statusOf } from '../types/status-property.ts';
import {
  FINISHED_TASK_STATUS,
  GTD_STATUSES,
  GTD_STATUS_LABELS,
  NEW_TASK_STATUS,
  TASK_KEYS,
  TASK_TYPE,
  type GtdStatus,
} from './gtd-status.ts';

const plain = (key: string, kind: PropertyDef['kind'], label: string): PropertyDef => ({
  key,
  kind,
  label,
  required: false,
  options: [],
  target: null,
  many: false,
});

/** `status`, with exactly the eight GTD statuses; ticking a task sets Archive. */
export const GTD_STATUS_PROPERTY: PropertyDef = {
  ...plain(TASK_KEYS.status, 'select', 'Status'),
  required: true,
  options: [...GTD_STATUSES],
  done: FINISHED_TASK_STATUS,
};

/**
 * What a task has besides its status (ADR-0029): who it waits on, where it
 * can be done, when it comes back into view, when it is due, how long it
 * takes, when it was finished, where it came from, and what it is filed under.
 */
const TASK_PROPERTIES: readonly PropertyDef[] = [
  FILED_UNDER,
  { ...plain(TASK_KEYS.waitingOn, 'relation', 'Waiting on'), target: PERSON_TYPE },
  plain(TASK_KEYS.contexts, 'multiSelect', 'Contexts'),
  plain(TASK_KEYS.defer, 'date', 'Defer until'),
  plain(TASK_KEYS.due, 'date', 'Due'),
  plain(TASK_KEYS.estimate, 'number', 'Estimate (minutes)'),
  plain(TASK_KEYS.completed, 'date', 'Completed'),
  plain(TASK_KEYS.source, 'text', 'Source'),
];

/**
 * The Task type, as written into a vault that has none: GTD's keys, the day
 * it was chosen for (#108), and the keys a task made from a meeting's action
 * item carries (#177). `focus` is not one of GTD's keys: a vault's own Task
 * type gains it on opening, as DFAI's shipped properties are added
 * (`SHIPPED_PROPERTIES`), so it never makes a vault already on GTD be offered
 * the move again. A vault's
 * own Task type is offered those with meeting post-processing's setup (#191),
 * not with the move to GTD, so a vault already on GTD is not offered the move
 * again for them.
 */
export const TASK_TYPE_FILE: BuiltInTypeFile = {
  type: {
    name: TASK_TYPE,
    label: 'Task',
    icon: 'task',
    properties: [
      GTD_STATUS_PROPERTY,
      ...TASK_PROPERTIES,
      FOCUS_PROPERTY,
      ...MEETING_ITEM_TASK_PROPERTIES,
    ],
  },
  body: [
    '# Task',
    '',
    `Something to do. Its status is one of ${GTD_STATUSES.map((status) => GTD_STATUS_LABELS[status]).join(', ')}:`,
    'a captured task starts in the Inbox, and ticking one off moves it to the Archive with the day it was',
    'finished. A Waiting task may say who it waits on, or not; a deferred one stays out of Next actions until its day.',
    'Chosen for is the day it was chosen to be done on, from the Today page.',
    '',
  ].join('\n'),
};

/** How a vault's own Task type would change to follow GTD. */
export interface TaskTypeChange<Type extends ObjectType = ObjectType> {
  readonly before: Type;
  readonly after: ObjectType;
  /** The properties it gains. */
  readonly added: readonly PropertyDef[];
  /** Its status's options as they are, when they are not yet the eight; null when they are. */
  readonly statusWas: readonly string[] | null;
}

/** Whether a status is GTD's: a choice of exactly the eight, in order, finished by Archive. */
function isGtdStatusProperty(property: PropertyDef): boolean {
  return (
    property.kind === 'select' &&
    property.done === FINISHED_TASK_STATUS &&
    property.options.length === GTD_STATUSES.length &&
    property.options.every((option, at) => option === GTD_STATUSES[at])
  );
}

/** The vault's Task type among its types — its name in any case and spacing — or null. */
export function taskTypeOf<Type extends ObjectType>(types: readonly Type[]): Type | null {
  return types.find((type) => type.name.trim().toLowerCase() === TASK_TYPE) ?? null;
}

/** Whether a Task type's status is GTD's eight: the vault's tasks have moved to GTD. */
export function followsGtd(type: ObjectType): boolean {
  const status = type.properties.find((property) => property.key === TASK_KEYS.status);
  return status !== undefined && isGtdStatusProperty(status);
}

/**
 * The status the vault's own becomes: the eight statuses, finished by
 * Archive, under the vault's own label and `required`. Tones it chose for
 * options that are gone go with them.
 */
function gtdStatusFrom(own: PropertyDef): PropertyDef {
  const colors = Object.entries(own.colors ?? {}).filter(([option]) =>
    GTD_STATUS_PROPERTY.options.includes(option),
  );
  return {
    ...GTD_STATUS_PROPERTY,
    label: own.label,
    required: own.required,
    ...(colors.length > 0 && { colors: Object.fromEntries(colors) }),
  };
}

/**
 * What the vault's Task type lacks to follow GTD, or null when nothing.
 *
 * Its status becomes the eight statuses — the one change that is not an
 * addition, and the reason the tasks have to be migrated with it. The other
 * task properties it has no key for are added; a key it already has is its
 * own and is left as it is, even where GTD would have made it another kind.
 */
export function taskTypeChange<Type extends ObjectType>(own: Type): TaskTypeChange<Type> | null {
  const keys = new Set(own.properties.map((property) => property.key));
  const added = TASK_PROPERTIES.filter((property) => !keys.has(property.key));
  const status = own.properties.find((property) => property.key === TASK_KEYS.status);
  const statusWas =
    status === undefined || !isGtdStatusProperty(status) ? (status?.options ?? []) : null;
  if (added.length === 0 && statusWas === null) return null;

  const properties =
    status === undefined
      ? [GTD_STATUS_PROPERTY, ...own.properties]
      : own.properties.map((property) => (property === status ? gtdStatusFrom(status) : property));
  return {
    before: own,
    after: { ...own, properties: [...properties, ...added] },
    added,
    statusWas,
  };
}

const listed = (words: readonly string[]) =>
  words.length <= 1
    ? (words[0] ?? '')
    : `${words.slice(0, -1).join(', ')} and ${words.at(-1) ?? ''}`;

/**
 * What changing the Task type does, one line per change, as the migration's
 * preview shows it: "Status becomes Inbox, Backlog, … and Archive (it was
 * backlog, next, doing, review and done)." / "Task gains Waiting on and Defer until."
 */
export function taskTypeLines(change: TaskTypeChange): string[] {
  const statuses = listed(GTD_STATUSES.map((status) => GTD_STATUS_LABELS[status]));
  const was = change.statusWas;
  const status =
    was === null
      ? []
      : [
          `Status becomes ${statuses}; ticking a task sets Archive${was.length === 0 ? '' : ` (it was ${listed(was)})`}.`,
        ];
  const added =
    change.added.length === 0
      ? []
      : [`${change.before.label} gains ${listed(change.added.map((property) => property.label))}.`];
  return [...status, ...added];
}

/**
 * The status a captured task starts in: the Inbox, when the vault's Task type
 * has it. Null for a vault still on statuses of its own, which keeps them.
 */
export function capturedTaskStatus(type: ObjectType | null): GtdStatus | null {
  const status = statusOf(type);
  return status?.key === TASK_KEYS.status && status.options.includes(NEW_TASK_STATUS)
    ? NEW_TASK_STATUS
    : null;
}

/** Whether the vault's tasks start in the Inbox: its Task type has that status (ADR-0029). */
export const tasksStartInInbox = (types: readonly ObjectType[]): boolean =>
  capturedTaskStatus(taskTypeOf(types)) !== null;

/** The statuses a row may give a task, and where a note made a task starts. */
export interface ClarifyVocabulary {
  /** The GTD statuses the vault's Task type declares, in GTD's order. */
  readonly statuses: readonly GtdStatus[];
  /** The status a note made a task starts in, or null to leave it unset. */
  readonly startsAt: GtdStatus | null;
}

/**
 * What clarifying may write in this vault (#112): only a status its Task type
 * declares, so a vault on statuses of its own is never given one its boards
 * and views do not know. A vault with no Task type yet is taken to follow
 * GTD, as the built-in type it would be given does.
 */
export function clarifyVocabulary(types: readonly ObjectType[]): ClarifyVocabulary {
  const type = taskTypeOf(types);
  const status = statusOf(type);
  if (type === null) return { statuses: GTD_STATUSES, startsAt: NEW_TASK_STATUS };
  const declared =
    status?.key === TASK_KEYS.status
      ? GTD_STATUSES.filter((each) => status.options.includes(each))
      : [];
  return { statuses: declared, startsAt: capturedTaskStatus(type) };
}
