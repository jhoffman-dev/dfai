import { useCallback, useMemo, useRef, useState } from 'react';
import {
  assistApplyStep,
  assistNotAppliedYet,
  messageWithoutPaths,
  type AssistEvidence,
  type AssistRow,
  type VaultPath,
} from '@dfai/domain';
import {
  applyAssistRow,
  applySureRows,
  undoAssistRow,
  undoAssistRows,
  type ActivityLog,
  type ApplyAssistPorts,
  type AssistApplied,
  type AssistUndo,
  type AssistUndone,
  type Clock,
} from '@dfai/application';
import type { AssistActions, AssistRowAction } from '@dfai/ui';
import type { WriteGiven, Written } from './use-inbox.ts';

/** A write of the Inbox's, queued behind its clarifications. */
export type InboxWrite = (job: (given: WriteGiven) => Promise<Written>) => Promise<boolean>;

/** The rows of one preview, each with the evidence its Apply re-checks. */
export interface AssistPlanned {
  readonly rows: readonly AssistRow[];
  readonly evidence: readonly AssistEvidence[];
}

/** Where one row stands with being applied. */
type RowState =
  | { readonly kind: 'idle'; readonly said: string | null }
  | { readonly kind: 'applying' }
  | {
      readonly kind: 'applied';
      readonly words: string;
      readonly undo: AssistUndo;
      readonly problem: string | null;
    }
  | { readonly kind: 'undoing'; readonly words: string; readonly undo: AssistUndo }
  | { readonly kind: 'asked'; readonly words: string }
  | { readonly kind: 'undone'; readonly words: string };

interface Applying {
  readonly rows: ReadonlyMap<string, RowState>;
  /** The paths applied, in the order they were: Undo all takes the last first. */
  readonly order: readonly string[];
  readonly said: string;
}

const IDLE: RowState = { kind: 'idle', said: null };
/** Where nothing is applied, nothing is said: never asked for, as no write is made. */
const NO_ACTIVITY: Pick<ActivityLog, 'inOpenVault'> = {
  inOpenVault: () => ({ record: () => undefined }),
};
const NOTHING_YET: Applying = { rows: new Map(), order: [], said: '' };

/** A row with nothing to press: shown with why, when it is one that waits (#925). */
const previewOnly = (row: AssistRow): AssistRowAction => {
  const why = notYet(row);
  return why === null ? { kind: 'none' } : { kind: 'preview', words: why };
};

/** Why a row Apply could write is shown without Apply for now (#925): the domain's kinds. Null when applied. */
const notYet = (row: AssistRow): string | null => {
  const step = assistApplyStep(row);
  return step === null ? null : assistNotAppliedYet(step);
};

/** Whether a row can be applied: the domain says so, and the preview kept what it saw of it. */
const appliable = (row: AssistRow, evidence: ReadonlyMap<string, AssistEvidence>) =>
  assistApplyStep(row) !== null && notYet(row) === null && evidence.has(row.path);

/**
 * Apply and Undo on Inbox assist's rows (#909): per row and for all, each
 * written through the Inbox's own queue, so the list follows every move. It
 * decides nothing: the use-cases re-check, write and undo; this holds where
 * each row stands, and says it. A preview shown afresh starts over.
 */
export function useAssistApply({
  planned,
  apply,
  clock,
}: {
  planned: AssistPlanned | null;
  /** The Inbox's write queue and Activity log; null where nothing is applied. */
  apply: { write: InboxWrite; activity: Pick<ActivityLog, 'inOpenVault'> } | null;
  clock: Pick<Clock, 'now' | 'today' | 'localNow'>;
}) {
  const write = apply?.write ?? null;
  const activity = apply?.activity ?? NO_ACTIVITY;
  const [applying, setApplying] = useState<{ of: AssistPlanned | null; state: Applying }>({
    of: null,
    state: NOTHING_YET,
  });
  const state = applying.of === planned ? applying.state : NOTHING_YET;
  const latest = useRef({ planned, write, clock, activity, state });
  latest.current = { planned, write, clock, activity, state };
  const abort = useRef<AbortController | null>(null);

  /** Changes this preview's rows, unless another preview is shown by now. */
  const update = useCallback(
    (of: AssistPlanned, change: (before: Applying) => Applying) =>
      setApplying((before) => {
        if (latest.current.planned !== of) return before;
        return { of, state: change(before.of === of ? before.state : NOTHING_YET) };
      }),
    [],
  );
  // The rows asked for and not yet settled, known at once: a second press before the page draws again does nothing.
  const claimed = useRef(new Set<string>());
  const actions = useActions({ latest, update, abort, claimed });
  const evidence = useMemo(
    () => new Map((planned?.evidence ?? []).map((each) => [each.item.path, each] as const)),
    [planned],
  );
  const actionOf = useCallback(
    (row: AssistRow): AssistRowAction =>
      appliable(row, evidence) ? shownAction(state.rows.get(row.path) ?? IDLE) : previewOnly(row),
    [evidence, state],
  );
  const busy = [...state.rows.values()].some(
    (each) => each.kind === 'applying' || each.kind === 'undoing',
  );
  const rows = planned?.rows ?? [];
  return {
    actionOf,
    actions: write === null || !rows.some((row) => appliable(row, evidence)) ? null : actions,
    canApplyAll: rows.some(
      (row) => appliable(row, evidence) && (state.rows.get(row.path) ?? IDLE).kind === 'idle',
    ),
    canUndoAll: [...state.rows.values()].some((each) => each.kind === 'applied'),
    busy,
    said: state.said,
    /** Stops "Apply all" after the row it is on: the suggestions were put away. */
    stop: () => abort.current?.abort(),
    /** The items being applied or undone now (#911): Suggest waits for them, and they are not left unfinished. */
    writing: () => claimed.current as ReadonlySet<string>,
  };
}

type Latest = {
  current: {
    planned: AssistPlanned | null;
    write: InboxWrite | null;
    clock: Pick<Clock, 'now' | 'today' | 'localNow'>;
    activity: Pick<ActivityLog, 'inOpenVault'>;
    state: Applying;
  };
};
type Update = (of: AssistPlanned, change: (before: Applying) => Applying) => void;

function useActions({
  latest,
  update,
  abort,
  claimed,
}: {
  latest: Latest;
  update: Update;
  abort: { current: AbortController | null };
  claimed: { current: Set<string> };
}): AssistActions {
  return useMemo(() => {
    const claim = (paths: readonly string[]) => {
      const free = paths.filter((path) => !claimed.current.has(path));
      for (const path of free) claimed.current.add(path);
      return { free, release: () => free.forEach((path) => claimed.current.delete(path)) };
    };
    const begin = () => {
      const { planned, write, clock, activity, state } = latest.current;
      if (planned === null || write === null) return null;
      const portsOf = (given: WriteGiven): ApplyAssistPorts => ({
        ...given.ports,
        clock,
        activity,
      });
      return { planned, write, state, portsOf };
    };
    const evidenceOf = (planned: AssistPlanned, path: string) =>
      planned.evidence.find((each) => each.item.path === path);
    return {
      onApply: (path) => {
        const now = begin();
        const row = now?.planned.rows.find((each) => each.path === path);
        if (now === null || row === undefined || (now.state.rows.get(path) ?? IDLE).kind !== 'idle')
          return;
        const claimedRow = claim([path]);
        if (claimedRow.free.length === 0) return;
        update(now.planned, (before) => withRow(before, path, { kind: 'applying' }));
        void now
          .write(async (given) => {
            const applied = await applyAssistRow(now.portsOf(given), {
              row,
              evidence: evidenceOf(now.planned, path),
              notePaths: given.notePaths,
            }).then(
              (done) => done.applied,
              (cause: unknown): AssistApplied => ({
                kind: 'failed',
                words: `Not applied: ${messageWithoutPaths(cause)}`,
              }),
            );
            update(now.planned, (before) => afterApply(before, row, applied));
            return writtenBy(applied);
          })
          .finally(claimedRow.release);
      },
      onApplyAll: () => {
        const now = begin();
        if (now === null) return;
        const idle = now.planned.rows.filter(
          (row) =>
            (now.state.rows.get(row.path) ?? IDLE).kind === 'idle' &&
            assistApplyStep(row) !== null &&
            notYet(row) === null,
        );
        const claimedRows = claim(idle.map((row) => row.path));
        const rows = idle.filter((row) => claimedRows.free.includes(row.path));
        if (rows.length === 0) return;
        const controller = new AbortController();
        abort.current = controller;
        update(now.planned, (before) =>
          rows.reduce((so, row) => withRow(so, row.path, { kind: 'applying' }), before),
        );
        void now
          .write(async (given) => {
            const results = await applySureRows(now.portsOf(given), {
              rows: rows.map((row) => ({ row, evidence: evidenceOf(now.planned, row.path) })),
              notePaths: given.notePaths,
              signal: controller.signal,
              onEach: ({ path, applied }) =>
                update(now.planned, (before) =>
                  afterApply(
                    before,
                    rows.find((row) => row.path === path)!,
                    applied,
                  ),
                ),
            }).catch((cause: unknown) => {
              update(now.planned, (before) => ({
                ...before,
                said: `Apply all stopped: ${messageWithoutPaths(cause)}`,
              }));
              return [];
            });
            // Rows not reached — stopped, or failed before them — are offered again.
            update(now.planned, (before) => settleUnreached(before));
            return { done: true, wrote: results.some(({ applied }) => writtenBy(applied).wrote) };
          })
          .finally(claimedRows.release);
      },
      onUndo: (path) => {
        const now = begin();
        const held = now?.state.rows.get(path);
        if (now === null || held?.kind !== 'applied') return;
        const claimedRow = claim([path]);
        if (claimedRow.free.length === 0) return;
        update(now.planned, (before) =>
          withRow(before, path, { kind: 'undoing', words: held.words, undo: held.undo }),
        );
        void now
          .write(async (given) => {
            const undone = await undoAssistRow(now.portsOf(given), {
              undo: held.undo,
              notePaths: given.notePaths,
            }).catch((cause: unknown): AssistUndone => ({
              kind: 'refused',
              words: `Not undone: ${messageWithoutPaths(cause)}`,
            }));
            update(now.planned, (before) => afterUndo(before, path, held, undone));
            // A partly done undo wrote notes too: the Inbox reads its list again (#911).
            return { done: undone.kind === 'undone', wrote: undone.kind !== 'refused' };
          })
          .finally(claimedRow.release);
      },
      onUndoAll: () => {
        const now = begin();
        if (now === null) return;
        const appliedRows = now.state.order.flatMap((path) => {
          const held = now.state.rows.get(path);
          return held?.kind === 'applied' ? [{ path: path as VaultPath, held }] : [];
        });
        const claimedRows = claim(appliedRows.map(({ path }) => path));
        const undos = appliedRows.filter(({ path }) => claimedRows.free.includes(path));
        if (undos.length === 0) return;
        update(now.planned, (before) =>
          undos.reduce(
            (so, { path, held }) =>
              withRow(so, path, { kind: 'undoing', words: held.words, undo: held.undo }),
            before,
          ),
        );
        void now
          .write(async (given) => {
            const results = await undoAssistRows(now.portsOf(given), {
              undos: undos.map(({ path, held }) => ({ path, undo: held.undo })),
              notePaths: given.notePaths,
              onEach: ({ path, undone }) =>
                update(now.planned, (before) =>
                  afterUndo(before, path, undos.find((each) => each.path === path)!.held, undone),
                ),
            });
            return { done: true, wrote: results.some(({ undone }) => undone.kind !== 'refused') };
          })
          .finally(claimedRows.release);
      },
    };
  }, [latest, update, abort, claimed]);
}

const withRow = (before: Applying, path: string, row: RowState): Applying => ({
  ...before,
  rows: new Map([...before.rows, [path, row]]),
});

/** Whether an apply wrote anything, so the Inbox reads its list again: a failed row may have, and taken it back. */
const writtenBy = (applied: AssistApplied): Written => ({
  done: applied.kind === 'applied',
  wrote: applied.kind !== 'asked',
});

function afterApply(before: Applying, row: AssistRow, applied: AssistApplied): Applying {
  const said = `${row.title}: ${applied.words}`;
  if (applied.kind === 'applied') {
    const next = withRow(before, row.path, {
      kind: 'applied',
      words: applied.words,
      undo: applied.undo,
      problem: null,
    });
    return {
      ...next,
      order: [...before.order.filter((path) => path !== row.path), row.path],
      said,
    };
  }
  if (applied.kind === 'failed' && applied.undo !== undefined) {
    // Taken back part-way (#911): held, with Undo on offer to finish it, and why beside it.
    const next = withRow(before, row.path, {
      kind: 'applied',
      words: 'Not applied, and not wholly taken back.',
      undo: applied.undo,
      problem: applied.words,
    });
    return {
      ...next,
      order: [...before.order.filter((path) => path !== row.path), row.path],
      said,
    };
  }
  const state: RowState =
    applied.kind === 'asked'
      ? { kind: 'asked', words: applied.words }
      : { kind: 'idle', said: applied.words };
  return { ...withRow(before, row.path, state), said };
}

function afterUndo(
  before: Applying,
  path: string,
  held: { words: string; undo: AssistUndo },
  undone: AssistUndone,
): Applying {
  const said = `${held.undo.title}: ${undone.words}`;
  if (undone.kind === 'undone') {
    return {
      ...withRow(before, path, { kind: 'undone', words: undone.words }),
      order: before.order.filter((each) => each !== path),
      said,
    };
  }
  // Refused: held as it was. Stopped part-way: held with what it put back, to be finished.
  const undo = undone.kind === 'partly' ? undone.undo : held.undo;
  return {
    ...withRow(before, path, { kind: 'applied', words: held.words, undo, problem: undone.words }),
    said,
  };
}

function settleUnreached(before: Applying): Applying {
  const rows = new Map(
    [...before.rows].map(([path, row]) => [path, row.kind === 'applying' ? IDLE : row] as const),
  );
  return { ...before, rows };
}

function shownAction(state: RowState): AssistRowAction {
  switch (state.kind) {
    case 'idle':
      return { kind: 'apply', said: state.said };
    case 'applying':
      return { kind: 'busy', words: 'Applying…' };
    case 'undoing':
      return { kind: 'busy', words: 'Undoing…' };
    case 'applied':
      return { kind: 'applied', words: state.words, problem: state.problem };
    case 'asked':
      return { kind: 'asked', words: state.words };
    case 'undone':
      return { kind: 'undone', words: state.words };
  }
}
