import { useCallback } from 'react';
import {
  createVaultPath,
  groupPrefill,
  groupValueProperty,
  NEW_NOTE_CONTENTS,
  type ObjectType,
  type RowGroup,
  type VaultPath,
  type ViewQuery,
} from '@dfai/domain';
import type { CardAdd } from '@dfai/ui';
import {
  createNote as makeNote,
  TaskRuleRefusedError,
  type ActivityLog,
  type MarkdownPort,
  type VaultFsPort,
} from '@dfai/application';
import { withGiveUpRecorded } from '../activity/with-give-up-recorded.ts';
import { localToday } from '../today.ts';
import { errorMessage } from './error-message.ts';

/**
 * New notes made from a view: a card added to a board column (and lane), a
 * note added under a table's group, a note added on a calendar's day or time,
 * or "New task" from the toolbar, which lands in the board's first column.
 */
export function useCardCreation({
  fs,
  markdown,
  query,
  type,
  groupBy,
  subGroupBy,
  dateKey,
  groupOptions,
  notePaths,
  activity,
  onChanged,
  onError,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  query: ViewQuery | null;
  /** The view's type, whose property kinds say how a group's value is written. */
  type: ObjectType | null;
  /** The property a board groups by, which a new card is filed under. */
  groupBy: string | null;
  /** The property a board's swimlanes are, which a card added in a lane is given too. */
  subGroupBy: string | null;
  /** The date a calendar places notes by, which a note added on a day is given. */
  dateKey: string | null;
  groupOptions: readonly string[];
  notePaths: readonly string[];
  activity: Pick<ActivityLog, 'inOpenVault'>;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  /**
   * Adds a note of the view's type, already carrying the column or the day it
   * was added to, so it lands where it was asked for rather than off the view.
   */
  const createNote = useCallback(
    async ({
      values,
      name,
    }: {
      values: Readonly<Record<string, unknown>>;
      name: string;
    }): Promise<VaultPath | null> => {
      if (query === null) return null;

      const frontmatter = markdown.updateFrontmatter(null, {
        type: query.type,
        ...values,
      });

      try {
        // Made as every new note is, so a card added to Archive is dated.
        const card = {
          activity,
          write: 'card',
          path: null,
          refusal: TaskRuleRefusedError,
        } as const;
        const path = await withGiveUpRecorded(card, () =>
          makeNote({
            fs,
            markdown,
            today: localToday(),
            name: name.trim() === '' ? `New ${query.type}` : name,
            beside: null,
            notePaths: notePaths.map(createVaultPath),
            contents: frontmatter + NEW_NOTE_CONTENTS,
          }),
        );
        onChanged();
        return path;
      } catch (cause) {
        onError(errorMessage(cause));
        return null;
      }
    },
    [fs, markdown, query, notePaths, activity, onChanged, onError],
  );

  /** A board's group value as the property to write — typed by its kind, as a table's "+ New" is. */
  const inGroup = useCallback(
    (key: string | null, value: string | null | undefined): Record<string, unknown> =>
      groupValueProperty({ type, key, value }),
    [type],
  );

  // Failure is already on screen as the view's error; nothing is waiting on these.
  const addCard = useCallback(
    ({ value, lane, name }: CardAdd) => {
      void createNote({
        values: { ...inGroup(groupBy, value), ...inGroup(subGroupBy, lane) },
        name,
      });
    },
    [createNote, inGroup, groupBy, subGroupBy],
  );

  /** A note added at the foot of a table's group, given that group's values. */
  const addInGroup = useCallback(
    (chain: readonly RowGroup[]) => createNote({ values: groupPrefill(chain), name: '' }),
    [createNote],
  );

  const addOnDate = useCallback(
    ({ value, name }: { value: string; name: string }) => {
      if (dateKey !== null) void createNote({ values: { [dateKey]: value }, name });
    },
    [createNote, dateKey],
  );

  const addNote = useCallback(
    () => createNote({ values: inGroup(groupBy, groupOptions[0] ?? null), name: '' }),
    [createNote, inGroup, groupBy, groupOptions],
  );

  return { addCard, addInGroup, addOnDate, addNote };
}
