import { useEffect, useMemo, useState } from 'react';
import { isDashboard, parseDashboard, type ObjectType, type Widget } from '@dfai/domain';
import { runDashboard, type IndexPort, type OpenNote, type WidgetResult } from '@dfai/application';
import { useNoteNames } from '@dfai/ui';

/**
 * Runs the open note when that note is a dashboard.
 *
 * Every widget is re-run whenever the index moves, which is what makes a
 * dashboard live: edit a task anywhere in the vault and the counts follow,
 * because both are reading the same derived index.
 */
export function useDashboard({
  note,
  index,
  types,
  notePaths,
  indexKey,
}: {
  note: OpenNote | null;
  index: IndexPort;
  /** The vault's types, so a donut can list a select's options nothing has yet. */
  types: readonly ObjectType[];
  /** Every note, so a link in a query widget names the note it means. */
  notePaths: readonly string[];
  /** Changes when the index does, so the widgets refresh after an edit. */
  indexKey: string;
}): { widgets: readonly Widget[]; results: readonly WidgetResult[] | null } {
  const widgets = useMemo(
    () => (note === null || !isDashboard(note.properties) ? null : parseDashboard(note.properties)),
    [note],
  );

  const [results, setResults] = useState<readonly WidgetResult[] | null>(null);
  // How a linked note reads, so a query widget's groups are named as a view names them.
  const names = useNoteNames();

  useEffect(() => {
    if (widgets === null) {
      setResults(null);
      return;
    }

    let cancelled = false;
    runDashboard({ index, widgets, types, notePaths, names })
      .then((found) => {
        if (!cancelled) setResults(found);
      })
      .catch(() => {
        // runDashboard reports a failing widget as a result, so a rejection here
        // means the index itself is gone. Showing the last good numbers would be
        // a lie, so the dashboard goes back to drawing nothing.
        if (!cancelled) setResults([]);
      });

    return () => {
      cancelled = true;
    };
  }, [index, widgets, types, notePaths, names, indexKey]);

  return { widgets: widgets ?? [], results: widgets === null ? null : (results ?? []) };
}
