import { useCallback } from 'react';
import {
  calendarEndKey,
  cellShownValue,
  createVaultPath,
  noteTitle,
  type ObjectType,
  type StatusProperty,
  type ViewDisplay,
  type WriteRecord,
} from '@dfai/domain';
import {
  cardAsMoved,
  cardMoveChanges,
  cellEditChanges,
  setNoteProperties,
  TaskRuleRefusedError,
  writeUndoably,
  type ActivityLog,
  type MarkdownPort,
  type PropertyChanges,
  type VaultFsPort,
  FrontmatterRefusedError,
} from '@dfai/application';
import type { CardMove, CellEdit } from '@dfai/ui';
import { withGiveUpRecorded } from '../activity/with-give-up-recorded.ts';
import type { OpenEditors } from '../panes/open-editors.ts';
import { localToday } from '../today.ts';
import { errorMessage } from './error-message.ts';
import type { MoveProperties, WriteProperties } from './use-pending-cards.ts';
import { sayWritten, type ViewUndo } from './write-toast.ts';

/** Writes one note the view shows — a row, a card, or the view note itself. */
export type ChangeProperties = (args: {
  path: string;
  values: PropertyChanges;
  /** What the change did, in the view's words, for the toast that offers to undo it (#320). */
  said?: string;
}) => void;

/**
 * Writes a note the view is showing — which may be open in a pane.
 *
 * A pane holding the note writes it through its own save, so the pane is not
 * left holding a modification time the file has moved past; only a note no
 * pane has open is written straight to the file — and that write is
 * recorded, to be taken back (#320): answered with its record, or null when
 * a pane wrote it or nothing changed.
 */
export async function writeNoteProperties({
  editors,
  fs,
  markdown,
  path,
  values,
  today = localToday(),
  ifModified,
}: {
  editors: OpenEditors;
  fs: VaultFsPort;
  markdown: MarkdownPort;
  path: string;
  values: PropertyChanges;
  /** `YYYY-MM-DD`, for the task rules; the Mac's day unless the caller has a clock of its own. */
  today?: string;
  /**
   * The stamp the caller read the note's file at: a file that has moved on
   * since is refused, not written. A pane holding the note writes what it
   * holds, whatever the file's stamp.
   */
  ifModified?: number;
}): Promise<WriteRecord | null> {
  const target = createVaultPath(path);
  const takenByAPane = await editors.setPropertiesIfOpen({ path: target, values });
  if (takenByAPane) return null;
  const { record } = await writeUndoably({
    fs,
    path: target,
    write: (recording) =>
      setNoteProperties({
        fs: recording,
        markdown,
        path,
        values,
        today,
        ...(ifModified !== undefined && { ifModified }),
      }),
  });
  return record;
}

/**
 * `writeNoteProperties` for a view's gestures: one the view gives up on is
 * recorded in the Activity log, and one written to its file is said in the
 * window's toasts with its Undo, when the view is handed them (#320).
 */
export function useWriteProperties({
  editors,
  fs,
  markdown,
  activity,
  undo,
}: {
  editors: OpenEditors;
  fs: VaultFsPort;
  markdown: MarkdownPort;
  activity: Pick<ActivityLog, 'inOpenVault'>;
  undo?: Omit<ViewUndo, 'fs'> | undefined;
}): WriteProperties {
  return useCallback(
    async ({ path, values, said }) => {
      const edit = {
        activity,
        write: 'edit',
        path,
        refusal: [TaskRuleRefusedError, FrontmatterRefusedError],
      } as const;
      const record = await withGiveUpRecorded(edit, () =>
        writeNoteProperties({ editors, fs, markdown, path, values }),
      );
      if (record !== null && undo !== undefined) {
        sayWritten({ record, undo: { ...undo, fs }, ...(said !== undefined && { words: said }) });
      }
    },
    [editors, fs, markdown, activity, undo],
  );
}

/**
 * `writeNoteProperties` for a view's gestures, which report through the view:
 * a failed one is shown there and recorded in the Activity log.
 */
export function useChangeProperties({
  onChanged,
  onError,
  ...ports
}: Parameters<typeof useWriteProperties>[0] & {
  onChanged: () => void;
  onError: (message: string) => void;
}): ChangeProperties {
  const write = useWriteProperties(ports);
  return useCallback(
    (args) => {
      write(args)
        .then(onChanged)
        .catch((cause: unknown) => onError(errorMessage(cause)));
    },
    [write, onChanged, onError],
  );
}

/** Edits made to the notes a view shows: a cell, a card moved, a date or a bar dragged. */
export function useRowWrites({
  display,
  type,
  groupOptions,
  status,
  changeProperties,
  moveProperties,
  shownOf,
  refuse,
}: {
  display: ViewDisplay;
  /** The type the view lists, whose property kinds a moved card's values are written as. */
  type: ObjectType | null;
  groupOptions: readonly string[];
  /** The type's status, whose done option finishes work on a board, by column or by lane. */
  status: StatusProperty | null;
  changeProperties: ChangeProperties;
  /** A card's move, which the board draws at once (#260) — and a cell's commit, which the table does. */
  moveProperties: MoveProperties;
  /** A row's values as the view draws them now; null for a row it does not show. */
  shownOf: (path: string) => Readonly<Record<string, unknown>> | null;
  /** Says why a change to a note was refused before anything was written. */
  refuse: (message: string, path: string) => void;
}) {
  /**
   * A cell committed in the table (#300): one write, drawn as committed at
   * once, as a card moved is. What it writes, and whether the row still
   * shows what the edit began on, is the application's rule
   * (`cellEditChanges`); a refusal writes nothing and is said over the table.
   * Settles once the write lands and fails as it does — already said, so a
   * table that does not wait on it raises nothing.
   */
  const editCell = useCallback(
    (edit: CellEdit): Promise<void> => {
      let values: PropertyChanges;
      try {
        values = cellEditChanges({ edit, now: shownOf(edit.path), status });
      } catch (cause) {
        refuse(errorMessage(cause), edit.path);
        const refused = Promise.reject(cause instanceof Error ? cause : new Error(String(cause)));
        // Said over the table already: a caller that does not wait on it is not told twice.
        refused.catch(() => undefined);
        return refused;
      }
      return moveProperties({
        path: edit.path,
        values,
        shown: () => ({ [edit.column]: cellShownValue(edit.value) }),
      });
    },
    [status, shownOf, refuse, moveProperties],
  );

  /**
   * A card dropped into another column, another lane, or both: each property
   * it left the group of, written as one change. What finishes the task, and
   * how each value is typed, is the application's rule (`cardMoveChanges`),
   * not decided here — nor is where the card is drawn until its write is
   * read back (`cardAsMoved`).
   */
  const moveCard = useCallback(
    (move: CardMove) => {
      const { groupBy, subGroupBy } = display;
      if (groupBy === null) return;
      const kindOf = (key: string) =>
        type?.properties.find((property) => property.key === key)?.kind;
      const column =
        'value' in move ? { key: groupBy, value: move.value, kind: kindOf(groupBy) } : null;
      const lane =
        'lane' in move && subGroupBy !== null
          ? { key: subGroupBy, value: move.lane, kind: kindOf(subGroupBy) }
          : null;
      if (column === null && lane === null) return;
      const moved = { column, lane, status, columnOptions: groupOptions };
      const to = [column?.value, lane?.value]
        .filter((value): value is string => typeof value === 'string')
        .join(' · ');
      // A failed move is said on the board by the pending cards themselves.
      void moveProperties({
        path: move.path,
        values: cardMoveChanges(moved),
        shown: (values) => cardAsMoved({ values, move: moved }),
        said: `Moved “${noteTitle(createVaultPath(move.path))}” to ${to === '' ? 'no group' : to}.`,
      });
    },
    [display, type, groupOptions, status, moveProperties],
  );

  /**
   * Moves a note on a calendar: its date, and its end when the calendar reads
   * one and the move changes it — written as one edit, like a timeline bar.
   */
  const reschedule = useCallback(
    ({ path, start, end }: { path: string; start: string; end: string | null }) => {
      const { dateKey, startKey, endKey } = display;
      if (dateKey === null) return;
      const spanEnd = calendarEndKey({ dateKey, startKey, endKey });
      changeProperties({
        path,
        values: {
          [dateKey]: start,
          ...(spanEnd === null || end === null ? {} : { [spanEnd]: end }),
        },
      });
    },
    [display, changeProperties],
  );

  /**
   * Moves a bar on a timeline: both ends of the work shift together, written as
   * one edit so the note is never briefly half-moved.
   */
  const moveBar = useCallback(
    ({ path, start, end }: { path: string; start: string; end: string }) => {
      if (display.startKey === null) return;
      const endKey = display.endKey ?? display.startKey;
      changeProperties({
        path,
        values:
          endKey === display.startKey
            ? { [display.startKey]: start }
            : { [display.startKey]: start, [endKey]: end },
      });
    },
    [display.startKey, display.endKey, changeProperties],
  );

  return { editCell, moveCard, reschedule, moveBar };
}
