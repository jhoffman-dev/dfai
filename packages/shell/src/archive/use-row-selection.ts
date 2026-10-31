import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ArchiveOutcome } from '@dfai/application';
import type { VaultPath } from '@dfai/domain';
import type { RowSelection } from '@dfai/ui';

/** What a settled batch did to its rows: the ones it is done with, and the ones to try again. */
export interface BatchAnswer {
  readonly answered: readonly string[];
  readonly failed: readonly string[];
}

/**
 * Which rows of a list are chosen. Let go of whenever `resetKey` changes —
 * another view, another search — so a choice never carries over to rows the
 * person has not seen.
 */
export function useRowSelection(resetKey: string): {
  selection: RowSelection;
  chosen: readonly string[];
  clear: () => void;
  /**
   * Once a batch has been answered: lets go of the rows it `answered`, and
   * chooses again the ones it `failed`, to try again — keeping every row
   * chosen while it ran.
   */
  afterBatch: (batch: BatchAnswer) => void;
  /**
   * Called as a batch starts; its answer is then given to what this returns,
   * as `afterBatch` — except that once the list has been let go of meanwhile
   * (another search, view or mode), no failed row is chosen again: the
   * person no longer sees it, nor chose it there.
   */
  beginBatch: () => (batch: BatchAnswer) => void;
} {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // The row last toggled on its own: where a shift-click's range starts. Let
  // go of with the choice, so a run never starts from a row no longer chosen.
  const anchor = useRef<string | null>(null);
  // Counts the times the list was let go of by `resetKey`, so a batch can
  // tell whether it settles on the list it started on.
  const resets = useRef(0);

  useEffect(() => {
    resets.current += 1;
    anchor.current = null;
    setSelected(new Set());
  }, [resetKey]);

  const onToggle = useCallback((path: string, extend?: { readonly order: readonly string[] }) => {
    const range = extend === undefined ? null : rowsBetween(extend.order, anchor.current, path);
    if (range === null) anchor.current = path;
    setSelected((was) => {
      const next = new Set(was);
      // A range only ever adds; so does a shift-click with nowhere to start from.
      if (range !== null) for (const row of range) next.add(row);
      else if (extend !== undefined || !next.has(path)) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);

  const onToggleAll = useCallback(
    ({ paths, select }: { paths: readonly string[]; select: boolean }) =>
      setSelected((was) => {
        const next = new Set(was);
        for (const path of paths) {
          if (select) next.add(path);
          else next.delete(path);
        }
        return next;
      }),
    [],
  );

  const clear = useCallback(() => {
    anchor.current = null;
    setSelected(new Set());
  }, []);
  const selection = useMemo(
    () => ({ selected, onToggle, onToggleAll }),
    [selected, onToggle, onToggleAll],
  );
  const chosen = useMemo(() => [...selected], [selected]);
  const afterBatch = useCallback(({ answered, failed }: BatchAnswer) => {
    const at = anchor.current;
    if (at !== null && answered.includes(at) && !failed.includes(at)) anchor.current = null;
    setSelected((was) => {
      const next = new Set(was);
      for (const path of answered) next.delete(path);
      for (const path of failed) next.add(path);
      return next;
    });
  }, []);
  const beginBatch = useCallback(() => {
    const startedOn = resets.current;
    return ({ answered, failed }: BatchAnswer) =>
      afterBatch({ answered, failed: resets.current === startedOn ? failed : [] });
  }, [afterBatch]);
  return { selection, chosen, clear, afterBatch, beginBatch };
}

/**
 * The rows from `from` to `to`, both included, in the order the list shows
 * them — either way round; null when either is not in it, so a shift-click
 * with nowhere to start from chooses its own row alone.
 */
export function rowsBetween(
  order: readonly string[],
  from: string | null,
  to: string,
): readonly string[] | null {
  const start = from === null ? -1 : order.indexOf(from);
  const end = order.indexOf(to);
  if (start === -1 || end === -1) return null;
  return order.slice(Math.min(start, end), Math.max(start, end) + 1);
}

/**
 * What a settled batch did to the rows it was given, for `afterBatch`: the
 * ones it could not move are `failed`, to be tried again; every other one was
 * `answered`. A failure at a path it was not given — the stamp at a note's
 * landing, a link in another note — is not a row to choose again. A batch
 * that did not start answered nothing.
 */
export function batchSettled(
  outcome: ArchiveOutcome | null,
  given: readonly VaultPath[],
): { answered: readonly VaultPath[]; failed: readonly VaultPath[] } {
  if (outcome === null) return { answered: [], failed: [] };
  const failedAt = new Set<string>(outcome.failed.map((failure) => failure.path));
  const failed = given.filter((path) => failedAt.has(path));
  return { answered: given.filter((path) => !failedAt.has(path)), failed };
}
