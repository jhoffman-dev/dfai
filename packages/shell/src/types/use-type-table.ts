import { useCallback, useEffect, useMemo, useState } from 'react';
import { typeTableQuery, type ObjectType, type QuerySort } from '@dfai/domain';
import {
  runView,
  TaskRuleRefusedError,
  type ActivityLog,
  type IndexPort,
  type MarkdownPort,
  type VaultFsPort,
  type ViewResult,
  FrontmatterRefusedError,
} from '@dfai/application';
import { withGiveUpRecorded } from '../activity/with-give-up-recorded.ts';
import type { OpenEditors } from '../panes/open-editors.ts';
import { writeNoteProperties } from '../query/use-view-writes.ts';

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Every note of one type, as a table.
 *
 * This is what a type in the sidebar opens. It is generated from the type
 * rather than saved as a view note, so there is nothing to keep in step and
 * nothing written to the vault by looking at it. Sorting is the one thing you
 * can change, and it lasts as long as the table is open: a saved view is the
 * place to write an order down.
 */
export function useTypeTable({
  fs,
  markdown,
  index,
  types,
  typeName,
  indexKey,
  onChanged,
  editors,
  activity,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  index: IndexPort;
  types: readonly ObjectType[];
  /** The type whose table is open, or null when a note is. */
  typeName: string | null;
  indexKey: string;
  onChanged: () => void;
  /** The panes, so a note one of them holds is written through it. */
  editors: OpenEditors;
  /** Where a cell edit the table gives up on is recorded. */
  activity: Pick<ActivityLog, 'inOpenVault'>;
}): {
  type: ObjectType | null;
  result: ViewResult | null;
  sorts: readonly QuerySort[];
  error: string | null;
  toggleSort: (column: string) => void;
  editCell: (args: { path: string; column: string; value: string }) => void;
} {
  const type = useMemo(
    () => types.find((candidate) => candidate.name === typeName) ?? null,
    [types, typeName],
  );

  const [sorts, setSorts] = useState<readonly QuerySort[]>([]);
  const [result, setResult] = useState<ViewResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A different type is a different table, so it starts from the type's own order.
  useEffect(() => setSorts([]), [typeName]);

  const query = useMemo(() => {
    if (type === null) return null;
    const generated = typeTableQuery(type);
    return sorts.length === 0 ? generated : { ...generated, sorts };
  }, [type, sorts]);

  useEffect(() => {
    if (query === null) {
      setResult(null);
      setError(null);
      return;
    }

    let cancelled = false;
    setError(null);
    runView({ index, query })
      .then((found) => {
        if (!cancelled) setResult(found);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setResult(null);
        setError(message(cause));
      });

    return () => {
      cancelled = true;
    };
  }, [index, query, indexKey]);

  const toggleSort = useCallback((column: string) => {
    setSorts((current) => {
      const sort = current.find((candidate) => candidate.key === column);
      if (sort === undefined) return [{ key: column, direction: 'asc' }];
      return sort.direction === 'asc' ? [{ key: column, direction: 'desc' }] : [];
    });
  }, []);

  const editCell = useCallback(
    ({ path, column, value }: { path: string; column: string; value: string }) => {
      // Through the pane holding the note, when one does: writing the file
      // underneath it would leave its next save to be refused.
      const values = { [column]: value === '' ? null : value };
      const edit = {
        activity,
        write: 'edit',
        path,
        refusal: [TaskRuleRefusedError, FrontmatterRefusedError],
      } as const;
      withGiveUpRecorded(edit, () => writeNoteProperties({ editors, fs, markdown, path, values }))
        .then(onChanged)
        .catch((cause: unknown) => setError(message(cause)));
    },
    [editors, fs, markdown, activity, onChanged],
  );

  return { type, result, sorts: query?.sorts ?? [], error, toggleSort, editCell };
}
