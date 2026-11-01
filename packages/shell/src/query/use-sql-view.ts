import { useEffect, useMemo, useState } from 'react';
import {
  parseSqlView,
  parseViewDisplay,
  sortResultRows,
  toggledSorts,
  type QuerySort,
  type ViewLayout,
} from '@dfai/domain';
import { runSql, type IndexPort, type OpenNote, type ViewResult } from '@dfai/application';
import { errorMessage } from './error-message.ts';

const NO_SORTS: readonly QuerySort[] = [];

/**
 * Runs the open note when it is a SQL view: its statement, through the index's
 * read-only path, again whenever the index changes. The result is read-only,
 * so a heading click sorts what came back rather than editing the note.
 */
export function useSqlView({
  note,
  index,
  indexKey,
}: {
  note: OpenNote | null;
  index: IndexPort;
  indexKey: string;
}): {
  sql: string | null;
  layout: ViewLayout;
  result: ViewResult | null;
  error: string | null;
  sorts: readonly QuerySort[];
  toggleSort: (column: string) => void;
} {
  const sql = useMemo(() => (note === null ? null : parseSqlView(note.properties)), [note]);
  const layout = useMemo(() => parseViewDisplay(note?.properties ?? {}).layout, [note]);
  const [result, setResult] = useState<ViewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sorts, setSorts] = useState<readonly QuerySort[]>(NO_SORTS);

  useEffect(() => {
    setError(null);
    if (sql === null) {
      setResult(null);
      return;
    }
    let cancelled = false;
    runSql({ index, sql })
      .then((found) => {
        if (!cancelled) setResult({ ...found, sql });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setResult(null);
        setError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [index, sql, indexKey]);

  const sorted = useMemo(
    () => (result === null ? null : { ...result, rows: sortResultRows(result, sorts) }),
    [result, sorts],
  );

  return {
    sql,
    layout,
    result: sorted,
    error,
    sorts,
    toggleSort: (column) => setSorts((was) => toggledSorts(was, column)),
  };
}
