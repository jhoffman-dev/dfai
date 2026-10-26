import { TASK_TYPE } from '../gtd/gtd-status.ts';
import { followsGtd, taskTypeOf } from '../gtd/task-type.ts';
import type { BuiltInTypeFile } from '../types/para.ts';
import type { ObjectType, PropertyDef } from '../types/property-def.ts';

/**
 * A timeblock is a note (ADR-0030): a stretch of the calendar that one big
 * task is placed on, or several small ones are pushed into.
 */
export const BLOCK_TYPE = 'block';

/** The keys a block is read by, as they are written in its frontmatter. */
export const BLOCK_KEYS = {
  start: 'start',
  end: 'end',
  tasks: 'tasks',
  gcalEventId: 'gcal_event_id',
  gcalEtag: 'gcal_etag',
  gcalCalendar: 'gcal_calendar',
  gcalMissing: 'gcal_missing',
  gcalSyncedTitle: 'gcal_synced_title',
  gcalSyncedStart: 'gcal_synced_start',
  gcalSyncedEnd: 'gcal_synced_end',
} as const;

/**
 * How a new calendar of blocks is drawn: each block on the clock from its
 * start to its end, which is what a block is — rather than placed by its start
 * for the half hour a note with no end is drawn as.
 */
export const BLOCK_CALENDAR = {
  dateKey: BLOCK_KEYS.start,
  startKey: BLOCK_KEYS.start,
  endKey: BLOCK_KEYS.end,
} as const;

const plain = (key: string, kind: PropertyDef['kind'], label: string): PropertyDef => ({
  key,
  kind,
  label,
  required: false,
  options: [],
  target: null,
  many: false,
});

/** The Block type, as written into a vault whose tasks follow GTD and that has none. */
export const BLOCK_TYPE_FILE: BuiltInTypeFile = {
  type: {
    name: BLOCK_TYPE,
    label: 'Block',
    icon: 'calendar',
    properties: [
      { ...plain(BLOCK_KEYS.start, 'date', 'Start'), required: true },
      { ...plain(BLOCK_KEYS.end, 'date', 'End'), required: true },
      { ...plain(BLOCK_KEYS.tasks, 'relation', 'Tasks'), target: TASK_TYPE, many: true },
      plain(BLOCK_KEYS.gcalEventId, 'text', 'Google event'),
      plain(BLOCK_KEYS.gcalEtag, 'text', 'Google version'),
      plain(BLOCK_KEYS.gcalCalendar, 'text', 'Google calendar'),
      plain(BLOCK_KEYS.gcalMissing, 'checkbox', 'Deleted in Google'),
      plain(BLOCK_KEYS.gcalSyncedTitle, 'text', 'Title agreed with Google'),
      plain(BLOCK_KEYS.gcalSyncedStart, 'text', 'Start agreed with Google'),
      plain(BLOCK_KEYS.gcalSyncedEnd, 'text', 'End agreed with Google'),
    ],
  },
  body: [
    '# Block',
    '',
    'Time set aside on the calendar, from its start to its end, for the tasks it links.',
    'A block holding one task gives that task all of its time; a block holding several',
    'shares its time among them by what each has left of its estimate.',
    '',
  ].join('\n'),
};

/** A type's name as the disk compares its file's: in any case. */
const folded = (name: string) => name.trim().toLowerCase();

/** Whether a type, by its name, is the Block type: in any case, as its file is found. */
export const isBlockType = (name: string | null | undefined): boolean =>
  name !== null && name !== undefined && folded(name) === BLOCK_TYPE;

/** The vault's Block type, or the built-in one when the vault has not written it yet. */
export function blockTypeOf(types: readonly ObjectType[]): ObjectType {
  return types.find((type) => isBlockType(type.name)) ?? BLOCK_TYPE_FILE.type;
}

/**
 * The Block type to write into a vault, or null when there is none to write.
 * It is written once the vault's tasks follow GTD (ADR-0029) — timeblocking
 * schedules GTD's tasks against their estimates — and never over a Block
 * type the vault has. A vault on task statuses of its own, or with no tasks,
 * is left as it is.
 */
export function blockTypeToWrite(existing: readonly ObjectType[]): BuiltInTypeFile | null {
  const task = taskTypeOf(existing);
  const hasBlock = existing.some((type) => isBlockType(type.name));
  return task !== null && followsGtd(task) && !hasBlock ? BLOCK_TYPE_FILE : null;
}
