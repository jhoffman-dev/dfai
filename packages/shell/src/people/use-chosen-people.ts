import { useEffect, useMemo } from 'react';
import type { VaultPath } from '@dfai/domain';
import type { BulkAction, RowSelection } from '@dfai/ui';
import type { BatchAnswer } from '../archive/use-row-selection.ts';
import { useRowSelection } from '../archive/use-row-selection.ts';
import type { ChosenPeople } from './people-merge.ts';

/** Merging the people a table's rows chose (#464). */
export interface ChosenPeopleMerge {
  /** Asks who to merge these people into; `settled` hears what the merge answered. */
  readonly mergeMany: (
    paths: readonly VaultPath[],
    settled?: (answer: BatchAnswer) => void,
  ) => void;
  /** Says which people the table in `tab` has chosen now, for ⌘K's "Merge selected people…". */
  readonly noteChosen: (tab: string, chosen: ChosenPeople | null) => void;
}

/** A table's chosen rows and what can be done to them. */
export interface ChosenRows {
  readonly selection: RowSelection;
  readonly actions: readonly BulkAction[];
  readonly count: number;
  readonly clear: () => void;
}

const mergeLabel = (n: number) => (n === 1 ? 'Merge into…' : `Merge ${n} people into…`);

/**
 * What a table of people does with its chosen rows (#464): "Merge … into…"
 * for them, said to ⌘K as this tab's choice, and — as an archive batch does —
 * let go of once a merge of them is made, but for any still in the vault. A
 * row no longer in the table, gone to the Trash by a merge made elsewhere, is
 * let go of too. Nothing where the table is not of people.
 */
export function usePeopleChoice({
  tab,
  merge,
  chosen,
  present,
  afterBatch,
  beginBatch,
}: {
  tab: string;
  merge: ChosenPeopleMerge | null;
  chosen: readonly string[];
  /** The rows the table shows now, or null while it has not read them. */
  present: readonly string[] | null;
  afterBatch: (answer: BatchAnswer) => void;
  beginBatch: () => (answer: BatchAnswer) => void;
}): readonly BulkAction[] {
  useEffect(() => {
    if (present === null) return;
    const shown = new Set(present);
    const gone = chosen.filter((path) => !shown.has(path));
    if (gone.length > 0) afterBatch({ answered: gone, failed: [] });
  }, [present, chosen, afterBatch]);
  useEffect(() => {
    if (merge === null) return;
    const paths = chosen as VaultPath[];
    merge.noteChosen(tab, { paths, settled: beginBatch() });
    return () => merge.noteChosen(tab, null);
  }, [merge, tab, chosen, beginBatch]);
  return useMemo(() => {
    if (merge === null || chosen.length === 0) return [];
    const paths = chosen as VaultPath[];
    return [{ label: mergeLabel(paths.length), onRun: () => merge.mergeMany(paths, beginBatch()) }];
  }, [merge, chosen, beginBatch]);
}

/** The Person type's table: its chosen rows, merged with {@link usePeopleChoice}. Null for another type. */
export function useChosenPeople({
  tab,
  resetKey,
  merge,
  present,
}: {
  tab: string;
  resetKey: string;
  merge: ChosenPeopleMerge | null;
  present: readonly string[] | null;
}): ChosenRows | null {
  const { selection, chosen, clear, afterBatch, beginBatch } = useRowSelection(resetKey);
  const actions = usePeopleChoice({ tab, merge, chosen, present, afterBatch, beginBatch });
  return useMemo(
    () => (merge === null ? null : { selection, actions, count: chosen.length, clear }),
    [merge, selection, actions, chosen.length, clear],
  );
}

/** The notes a table's result shows, by its `path` column; null while there is none to read them from. */
export function rowPaths(
  result: {
    readonly columns: readonly string[];
    readonly rows: readonly (readonly unknown[])[];
  } | null,
): readonly string[] | null {
  const at = result === null ? -1 : result.columns.indexOf('path');
  return result === null || at === -1 ? null : result.rows.map((row) => String(row[at] ?? ''));
}
