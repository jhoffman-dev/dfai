import { useCallback, useMemo, useState } from 'react';
import {
  editedFrontmatter,
  editView,
  groupingEdit,
  hasViewEdits,
  moveColumn,
  remainingEdits,
  toggleColumn,
  toggledSorts,
  viewCopyFrontmatter,
  viewEditChanges,
  viewSettingsOf,
  type QueryFilter,
  type QuerySort,
  type VaultPath,
  type ViewEdits,
} from '@dfai/domain';
import {
  writeViewNote,
  ViewRefusedError,
  type ActivityLog,
  type MarkdownPort,
  type OpenNote,
  type VaultFsPort,
} from '@dfai/application';
import { withGiveUpRecorded } from '../activity/with-give-up-recorded.ts';
import { errorMessage } from './error-message.ts';
import type { ViewDrafts } from './use-view-drafts.ts';
import type { ChangeProperties } from './use-view-writes.ts';

const NONE: ViewEdits = {};
const NO_COLUMNS: readonly string[] = [];
const NO_SORTS: readonly QuerySort[] = [];

/**
 * The toolbar's changes to a view: applied to what is drawn at once, written
 * to the view note only on Save view, or to a new note on Save as new view.
 */
export function useViewEdits({
  note,
  drafts,
  changeProperties,
  fs,
  markdown,
  viewPaths,
  activity,
  onChanged,
}: {
  note: OpenNote | null;
  drafts: ViewDrafts;
  changeProperties: ChangeProperties;
  fs: VaultFsPort;
  markdown: MarkdownPort;
  /** Every saved view, so a new one's name is checked against them. */
  viewPaths: readonly string[];
  activity: Pick<ActivityLog, 'inOpenVault'>;
  onChanged: () => void;
}) {
  const saved = useMemo(() => (note === null ? null : viewSettingsOf(note.properties)), [note]);
  const path = note?.path ?? null;
  // Once the note agrees with an edit — it was saved, here or elsewhere — it is no longer one.
  const edits = useMemo(
    () => (saved === null || path === null ? NONE : remainingEdits(saved, drafts.editsFor(path))),
    [saved, path, drafts],
  );
  const shown = useMemo(
    () => (note === null ? {} : editedFrontmatter(note.properties, edits)),
    [note, edits],
  );
  const shownSettings = useMemo(() => viewSettingsOf(shown), [shown]);

  const change = useCallback(
    (next: ViewEdits) => {
      if (saved === null || path === null) return;
      drafts.setEdits(path, editView(saved, edits, next));
    },
    [saved, path, drafts, edits],
  );

  const saving = useSaving({
    note,
    edits,
    drafts,
    changeProperties,
    fs,
    markdown,
    viewPaths,
    activity,
    onChanged,
  });
  const settingChanges = useSettingChanges({
    columns: shownSettings?.columns ?? NO_COLUMNS,
    subGroupBy: shownSettings?.subGroupBy ?? null,
    change,
  });
  const toggleSort = useToggleSort(shownSettings?.sorts ?? NO_SORTS, settingChanges.setSorts);

  return {
    shown,
    edited: hasViewEdits(edits),
    ...settingChanges,
    ...saving,
    toggleSort,
    /** Any other change to the view's settings — a layout and what it needs. */
    applyEdits: change,
  };
}

function useSettingChanges({
  columns,
  subGroupBy,
  change,
}: {
  columns: readonly string[];
  subGroupBy: string | null;
  change: (next: ViewEdits) => void;
}) {
  const setFilters = useCallback(
    (filters: readonly QueryFilter[]) => change({ filters }),
    [change],
  );
  const setSorts = useCallback((sorts: readonly QuerySort[]) => change({ sorts }), [change]);
  const setGroupBy = useCallback(
    (groupBy: string | null) => change(groupingEdit(subGroupBy, groupBy)),
    [change, subGroupBy],
  );
  const setSubGroupBy = useCallback(
    (next: string | null) => change({ subGroupBy: next }),
    [change],
  );
  const showOrHide = useCallback(
    (key: string) => change({ columns: toggleColumn(columns, key) }),
    [change, columns],
  );
  const move = useCallback(
    (key: string, by: -1 | 1) => change({ columns: moveColumn(columns, key, by) }),
    [change, columns],
  );
  return {
    setFilters,
    setSorts,
    setGroupBy,
    setSubGroupBy,
    toggleColumn: showOrHide,
    moveColumn: move,
  };
}

function useToggleSort(sorts: readonly QuerySort[], setSorts: (sorts: QuerySort[]) => void) {
  return useCallback((column: string) => setSorts(toggledSorts(sorts, column)), [sorts, setSorts]);
}

function useSaving({
  note,
  edits,
  drafts,
  changeProperties,
  fs,
  markdown,
  viewPaths,
  activity,
  onChanged,
}: {
  note: OpenNote | null;
  edits: ViewEdits;
  drafts: ViewDrafts;
  changeProperties: ChangeProperties;
  fs: VaultFsPort;
  markdown: MarkdownPort;
  viewPaths: readonly string[];
  activity: Pick<ActivityLog, 'inOpenVault'>;
  onChanged: () => void;
}) {
  const [saveAsError, setSaveAsError] = useState<string | null>(null);

  // The view is a note too, and a pane showing it writes it through its own save.
  const save = useCallback(() => {
    if (note !== null) changeProperties({ path: note.path, values: viewEditChanges(edits) });
  }, [note, edits, changeProperties]);

  const reset = useCallback(() => {
    if (note !== null) drafts.setEdits(note.path, NONE);
  }, [note, drafts]);

  /** The view with its edits, written as a new view; this one goes back to how it is saved. */
  const saveAs = useCallback(
    async (name: string): Promise<VaultPath | null> => {
      if (note === null) return null;
      try {
        const frontmatter = viewCopyFrontmatter(note.properties, edits);
        const named = { activity, write: 'view', path: null, refusal: ViewRefusedError } as const;
        const created = await withGiveUpRecorded(named, () =>
          writeViewNote({ fs, markdown, takenPaths: viewPaths, name, frontmatter }),
        );
        setSaveAsError(null);
        drafts.setEdits(note.path, NONE);
        onChanged();
        return created;
      } catch (cause) {
        setSaveAsError(errorMessage(cause));
        return null;
      }
    },
    [note, edits, fs, markdown, viewPaths, drafts, activity, onChanged],
  );

  return { save, reset, saveAs, saveAsError };
}
