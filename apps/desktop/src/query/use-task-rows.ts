import { useCallback, useMemo, useRef, useState } from 'react';
import {
  choosesForToday,
  REOPENED_TASK_STATUS,
  taskRowFacts,
  taskRowState,
  taskRowWithChanges,
  type BoardRow,
  type GtdStatus,
  type ObjectType,
  type TodayChoice,
} from '@dfai/domain';
import {
  ChangedSinceError,
  changeUndoably,
  FocusNotChosenError,
  NoteChangedError,
  readAnswers,
  taskRowAsChanged,
  taskRowChange,
  taskRowStillOffers,
  TaskRuleRefusedError,
  whileAsRead,
  type Clock,
  type PropertyChanges,
  type ReadMoment,
  type TaskRowAction,
  type UndoableChange,
} from '@dfai/application';
import {
  todayActionWords,
  type TaskRowControls,
  type TaskRowShown,
  type TodayAction,
} from '@dfai/ui';
import { withGiveUpRecorded } from '../activity/with-give-up-recorded.ts';
import type { Toasts } from '../toasts/toasts.ts';
import { errorMessage } from './error-message.ts';
import type { QueryPagePorts } from './use-query-page.ts';
import { writeNoteProperties } from './use-view-writes.ts';

/** What a write refuses the person, rather than fails at: shown on the row, and no fault. */
const REFUSALS = [
  TaskRuleRefusedError,
  ChangedSinceError,
  NoteChangedError,
  FocusNotChosenError,
] as const;

/** A row's change being written, or written and not yet read back. */
interface Pending {
  /** What the row is drawn as meanwhile: the change's keys, the task rules' own included. */
  readonly changes: Readonly<Record<string, unknown>>;
  /** When its write landed; null while it is being written. */
  readonly landed: ReadMoment | null;
}

/** Why a row's last change was not made, and that same change, to be tried again. */
interface Refused {
  readonly message: string;
  readonly retry: () => void;
}

/** What the rows hold of their own changes, in the view they were made in. */
interface RowsState {
  readonly scope: readonly unknown[];
  readonly pending: ReadonlyMap<string, Pending>;
  readonly refused: ReadonlyMap<string, Refused>;
}

export interface TaskRowsOptions {
  /** The rows as the query's last run read them. */
  readonly rows: readonly BoardRow[];
  /** When that run was asked, and how many runs have begun since. */
  readonly read: ReadMoment;
  readonly runsBegun: () => number;
  readonly indexKey: string;
  /** Whether the rows carry their task's state (`compiled.taskRows`): without it, they are look-only. */
  readonly enabled: boolean;
  /** The index and the view the rows are of: when either changes, nothing carries over. */
  readonly scope: readonly unknown[];
  readonly ports: Omit<QueryPagePorts, 'index'>;
  readonly clock: Pick<Clock, 'today'>;
  readonly types: readonly ObjectType[];
  /** Where each change is said, with its Undo, as Today says its own; nothing is said without. */
  readonly toasts?: Pick<Toasts, 'show' | 'vaultNow'> | undefined;
  /** Re-reads the index once a change has been written. */
  readonly onChanged: () => void;
}

/**
 * A query's task rows made to act (#107): ticked done, moved to another of
 * GTD's statuses, chosen for today or taken off it — each the change Today's
 * rows make (`taskRowChange`), made the way Today makes it: only while the
 * task still is what its row read, undoably. A row is drawn as its change
 * leaves it at once, and stays so until a run of the query asked after the
 * write stands for it (`readAnswers`); meanwhile it takes no other action.
 * A change refused or failed puts the row back and says why on it, with the
 * same change offered again.
 */
export function useTaskRows(options: TaskRowsOptions): {
  readonly rows: readonly BoardRow[];
  readonly controls: TaskRowControls | undefined;
} {
  const { rows, read, enabled, scope, clock, types } = options;
  const [state, setState] = useState<RowsState>(() => emptyIn(scope));
  const here = sameScope(state.scope, scope) ? state : emptyIn(scope);
  const latest = useRef(options);
  latest.current = options;
  const choosing = choosesForToday(types);

  const shownRows = useMemo(() => {
    if (!enabled || here.pending.size === 0) return rows;
    return rows.map((row) => {
      const pending = here.pending.get(row.path);
      if (pending === undefined || readAnswers(pending.landed, read)) return row;
      return { ...row, values: taskRowWithChanges(row.values, pending.changes) };
    });
  }, [enabled, rows, here.pending, read]);

  const held = useRef(here);
  held.current = here;
  const act = useAct({ latest, held, setState });
  const controls = useMemo(
    () =>
      enabled
        ? rowControls({ rows: shownRows, here, read, today: clock.today(), choosing, act })
        : undefined,
    [enabled, shownRows, here, read, clock, choosing, act],
  );
  return { rows: shownRows, controls };
}

const emptyIn = (scope: readonly unknown[]): RowsState => ({
  scope,
  pending: new Map(),
  refused: new Map(),
});

const sameScope = (left: readonly unknown[], right: readonly unknown[]) =>
  left.length === right.length && left.every((each, at) => each === right[at]);

/**
 * What a control asks of a row: an action, a choice for today made on the
 * day it is carried out, not the day the controls were drawn (#107).
 */
type RowPress =
  | Exclude<TaskRowAction, { kind: 'choice' }>
  | { readonly kind: 'choice'; readonly choice: TodayChoice };

/** One press on a row, with the words its toast says it in. */
type Act = (row: BoardRow, press: RowPress, said: TodayAction) => void;

/** The action a press makes on `today`, from the injected clock. */
const actionOf = (press: RowPress, today: string): TaskRowAction =>
  press.kind === 'choice' ? { ...press, today } : press;

/** The controls each row draws, worked out once per drawing from what the rows hold. */
function rowControls({
  rows,
  here,
  read,
  today,
  choosing,
  act,
}: {
  rows: readonly BoardRow[];
  here: RowsState;
  read: ReadMoment;
  today: string;
  choosing: boolean;
  act: Act;
}): TaskRowControls {
  const shown = new Map<string, TaskRowShown>();
  for (const row of rows) {
    const task = taskRowState(row.values);
    if (task === null) continue;
    const pending = here.pending.get(row.path);
    const refused = here.refused.get(row.path);
    shown.set(row.path, {
      ...taskRowFacts({ state: task, today, choosing }),
      waits: pending !== undefined && !readAnswers(pending.landed, read),
      refusal: refused === undefined ? null : { message: refused.message, onRetry: refused.retry },
    });
  }
  return {
    of: (row) => shown.get(row.path),
    onDone: (row, done) =>
      done
        ? act(row, { kind: 'done' }, { kind: 'done' })
        : act(row, { kind: 'reopen' }, { kind: 'move', status: REOPENED_TASK_STATUS }),
    onMove: (row, status: GtdStatus) =>
      act(row, { kind: 'move', status }, { kind: 'move', status }),
    onToday: (row, chosen) => {
      const choice = chosen ? 'unchoose' : 'choose';
      act(row, { kind: 'choice', choice }, { kind: choice });
    },
  };
}

/** The act every control calls: drawn at once, written as Today writes, said with its Undo. */
function useAct({
  latest,
  held,
  setState,
}: {
  latest: { readonly current: TaskRowsOptions };
  /** What the rows hold now, read when a control is pressed. */
  held: { readonly current: RowsState };
  setState: (next: (was: RowsState) => RowsState) => void;
}): Act {
  const change = useCallback(
    (update: (was: RowsState) => RowsState) =>
      setState((was) =>
        update(sameScope(was.scope, latest.current.scope) ? was : emptyIn(latest.current.scope)),
      ),
    [latest, setState],
  );
  const act = useCallback<Act>(
    (row, press, said) => {
      const options = latest.current;
      const task = taskRowState(row.values);
      // A row whose last change has yet to be read back takes no other until then.
      const waiting = held.current.pending.get(row.path);
      if (task === null || (waiting !== undefined && !readAnswers(waiting.landed, options.read)))
        return;
      const today = options.clock.today();
      const action = actionOf(press, today);
      const values = taskRowChange(action);
      const changes = taskRowAsChanged({ task, values, today }) ?? {};
      const asked = options.indexKey;
      const retry = () => {
        // Judged afresh, on the day it is pressed: a task read differently since is left as it is.
        const now = latest.current.rows.find((each) => each.path === row.path);
        const fresh = now === undefined ? null : taskRowState(now.values);
        const choosing = choosesForToday(latest.current.types);
        const again = actionOf(press, latest.current.clock.today());
        if (now === undefined || fresh === null) return;
        if (!taskRowStillOffers({ asked: task, now: fresh, action: again, choosing })) {
          change((was) => ({ ...was, refused: without(was.refused, row.path) }));
          return;
        }
        act(now, press, said);
      };
      const pending: Pending = { changes, landed: null };
      change((was) => withPending(was, { path: row.path, pending, read: options.read }));
      const guarded = whileAsRead({ values, row: task.asRead });
      writeRow({ options, path: row.path, values: guarded, today }).then(
        (made) => {
          const landed = { ...pending, landed: { at: options.runsBegun(), indexKey: asked } };
          change((was) => replacing(was, row.path, pending, landed));
          announce({ options, made, title: row.title, said, path: row.path });
          options.onChanged();
        },
        (cause: unknown) => {
          const refused = { message: errorMessage(cause), retry };
          change((was) => withRefused(was, { path: row.path, pending, refused }));
        },
      );
    },
    [latest, held, change],
  );
  return act;
}

/**
 * With a row's change pending, any refusal said on it before let go, and the
 * changes the view has read back since forgotten, so drawing the rows does
 * not lay them over again.
 */
function withPending(
  was: RowsState,
  { path, pending, read }: { path: string; pending: Pending; read: ReadMoment },
): RowsState {
  const unread = [...was.pending].filter(([, each]) => !readAnswers(each.landed, read));
  return {
    ...was,
    pending: new Map([...unread, [path, pending]]),
    refused: without(was.refused, path),
  };
}

/** With a row's change refused: drawn as read again, and why said on it. */
function withRefused(
  was: RowsState,
  { path, pending, refused }: { path: string; pending: Pending; refused: Refused },
): RowsState {
  const own = was.pending.get(path) === pending;
  return {
    ...was,
    pending: own ? without(was.pending, path) : was.pending,
    refused: new Map([...was.refused, [path, refused]]),
  };
}

function without<Value>(map: ReadonlyMap<string, Value>, path: string): ReadonlyMap<string, Value> {
  if (!map.has(path)) return map;
  return new Map([...map].filter(([key]) => key !== path));
}

/** The row's pending change, landed — unless another change has taken its place since. */
function replacing(was: RowsState, path: string, before: Pending, after: Pending): RowsState {
  if (was.pending.get(path) !== before) return was;
  return { ...was, pending: new Map([...was.pending, [path, after]]) };
}

/** Writes one row's change as Today writes its own: read before and after, so it can be undone. */
function writeRow({
  options,
  path,
  values,
  today,
}: {
  options: TaskRowsOptions;
  path: string;
  values: PropertyChanges;
  today: string;
}): Promise<UndoableChange> {
  const { editors, fs, markdown, activity } = options.ports;
  const edit = { activity, write: 'edit', path, refusal: REFUSALS } as const;
  return withGiveUpRecorded(edit, () =>
    changeUndoably({
      fs,
      markdown,
      path,
      write: async (readAt) => {
        await writeNoteProperties({
          editors,
          fs,
          markdown,
          path,
          values,
          today,
          ifModified: readAt,
        });
      },
    }),
  );
}

/** Says the change in the window's toasts with its Undo, as Today does; an Undo refused says why. */
function announce({
  options,
  made,
  title,
  said,
  path,
}: {
  options: TaskRowsOptions;
  made: UndoableChange;
  title: string;
  said: TodayAction;
  path: string;
}): void {
  const { toasts } = options;
  const undo = made.undo;
  if (toasts === undefined || undo === null) return;
  const madeIn = toasts.vaultNow();
  toasts.show({
    message: todayActionWords({ title, action: said }),
    tone: 'change',
    onUndo: () => {
      // The toast is of the vault it was made in: an Undo pressed in another writes nothing.
      if (toasts.vaultNow() !== madeIn) return;
      writeRow({ options, path, values: undo, today: options.clock.today() }).then(
        () => options.onChanged(),
        (cause: unknown) =>
          toasts.show({
            message: errorMessage(cause),
            tone: REFUSALS.some((refusal) => cause instanceof refusal) ? 'warning' : 'error',
          }),
      );
    },
  });
}
