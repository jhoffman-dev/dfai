import { useCallback, useRef, type KeyboardEvent } from 'react';
import type { TodayReport } from '@dfai/application';
import {
  TODAY_KEYS,
  todayKeyActionOf,
  type TodayChoice,
  type TodayKeyAction,
  type TodayKeyLetter,
  type TodayLists,
  type TodaySectionId,
  type TodayTask,
  type VaultPath,
} from '@dfai/domain';
import { ROW_MOVE_HINTS, ROW_UNDO_HINT, typesInto, useRowKeys, type UndoLast } from './row-keys.ts';
import type { RowFocus } from './today-row-focus.ts';

/** What a row's keys call: the same acts its own controls do. */
export interface TodayKeyActs {
  readonly onOpen: (path: VaultPath) => void;
  readonly onDone: (task: TodayTask) => void;
  readonly onDefer: (task: TodayTask, days: number) => void;
  readonly onMove: (task: TodayTask, status: string) => void;
  readonly onChoose: (task: TodayTask, choice: TodayChoice) => void;
}

/** What each of Today's keys is called in its hint strip. */
const TODAY_KEY_LABELS: Readonly<Record<TodayKeyLetter, string>> = {
  x: 'Done',
  t: 'Today',
  d: 'Defer a day',
  n: 'Next',
  w: 'Waiting',
  s: 'Someday',
  m: 'Move to…',
};

/** The Today page's hint strip (#109): moving and opening, each of `TODAY_KEYS`, and Undo. */
export const TODAY_KEY_HINTS: readonly (readonly [keys: string, does: string])[] = [
  ...ROW_MOVE_HINTS,
  ...TODAY_KEYS.map((key) => [key.toUpperCase(), TODAY_KEY_LABELS[key]] as const),
  ROW_UNDO_HINT,
];

/** A row's handle carries its path, so a key knows its row from where it was pressed. */
const ROW_MARK = '[data-today-row]';

/** A task on the page, with the section and the group it is listed in, or null when it is not. */
function placedTask(
  today: TodayLists,
  path: VaultPath,
): { task: TodayTask; section: TodaySectionId; group: string } | null {
  for (const section of today.sections) {
    for (const group of section.groups) {
      const task = group.tasks.find((each) => each.path === path);
      if (task !== undefined) return { task, section: section.id, group: group.key };
    }
  }
  return null;
}

/** Where the page lists a task — its section and group — or null: one moved elsewhere is drawn anew. */
export function todayPlaceOf(today: TodayLists | null, path: VaultPath): string | null {
  const placed = today === null ? null : placedTask(today, path);
  return placed === null ? null : `${placed.section}\n${placed.group}`;
}

/**
 * Keyboard triage on Today (#109): the keys of any triage page's row, and
 * X, T, D, N, W, S and M, each doing what one of the row's controls does.
 * Asked on the page rather than each row; a key pressed in a field, a menu
 * or a dialog is left to it, and a row whose controls wait takes none.
 */
export function useTodayKeys({
  today,
  order,
  focus,
  acts,
  waits,
  undoWaits,
  onUndo,
}: {
  today: TodayReport | null;
  order: readonly VaultPath[];
  focus: RowFocus;
  acts: TodayKeyActs;
  /** Whether a row's controls wait: an action under way, or its last not read back. */
  waits: (path: VaultPath) => boolean;
  /** Whether any change is on its way: until it lands, the undo on offer is the one before. */
  undoWaits: () => boolean;
  onUndo?: UndoLast | undefined;
}): (event: KeyboardEvent<HTMLElement>) => void {
  const rowKey = useRowKeys({
    order,
    focusRow: focus.focusRow,
    elementOf: focus.elementOf,
    onOpen: acts.onOpen,
    onUndo,
    undoWaits,
  });
  const read = useRef({ today, acts, waits });
  read.current = { today, acts, waits };
  return useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      const target = event.target;
      if (!(target instanceof Element) || typesInto(target)) return;
      const path = target.closest<HTMLElement>(ROW_MARK)?.dataset['todayRow'] as
        VaultPath | undefined;
      if (path === undefined || rowKey(event, path)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const { today: shown, acts: now, waits: waitsNow } = read.current;
      const placed = shown === null ? null : placedTask(shown, path);
      if (shown === null || placed === null) return;
      const action = todayKeyActionOf(event.key, {
        status: placed.task.status,
        section: placed.section,
        choosing: shown.choosing,
        focusIsOwn: placed.task.focusIsOwn === true,
      });
      if (action === null) return;
      event.preventDefault();
      // A key held down repeats; the repeats are not more presses.
      if (event.repeat || waitsNow(path)) return;
      perform({ action, task: placed.task, acts: now, row: target.closest(ROW_MARK) });
    },
    [rowKey],
  );
}

function perform({
  action,
  task,
  acts,
  row,
}: {
  action: TodayKeyAction;
  task: TodayTask;
  acts: TodayKeyActs;
  row: Element | null;
}): void {
  if (action.kind === 'done') acts.onDone(task);
  else if (action.kind === 'defer') acts.onDefer(task, action.days);
  else if (action.kind === 'move') acts.onMove(task, action.status);
  else if (action.kind === 'choice') acts.onChoose(task, action.choice);
  // Pressed as Return would press it: the menu opens with its first status focused.
  else row?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.click();
}
