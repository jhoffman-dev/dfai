import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import {
  focusChange,
  TASK_KEYS,
  taskDeferral,
  tasksStartInInbox,
  taskTypeOf,
  type ObjectType,
  type TaskAsRead,
  type TodayChoice,
  type VaultPath,
} from '@dfai/domain';
import {
  archiveTaskChange,
  changeUndoably,
  readAnswers,
  readToday,
  todayAsPending,
  whileAsRead,
  type IndexPort,
  type PropertyChanges,
  type TodayReport,
  type UndoableChange,
} from '@dfai/application';
import { todayActionWords, type TodayAction } from '@dfai/ui';
import { errorMessage } from '../query/error-message.ts';
import { keptTodayReport } from './kept-today-report.ts';
import { createTodayWrites, NOTHING_SETTLING, type TodayWrites } from './today-writes.ts';
import { useReviewWrites, type ReviewWritesOptions } from '../review/use-review-writes.ts';
import type { Toasts } from '../toasts/toasts.ts';

/** How often an open page asks the clock whether the day has turned. */
const DAY_CHECK_MS = 60_000;

/** The page's one place in the window's toasts: a change takes the place of the one before (#320). */
const TODAY_TOAST = 'today';

export interface TodayOptions extends Omit<ReviewWritesOptions, 'ports' | 'clock'> {
  readonly ports: ReviewWritesOptions['ports'] & { readonly index: Pick<IndexPort, 'query'> };
  /** Today's date, and now: the day the page turns on comes from here alone. */
  readonly clock: Parameters<typeof readToday>[0]['clock'];
  /** The vault's types: the page is offered once the vault has tasks. */
  readonly types: readonly ObjectType[];
  /** The vault that is open: what was read of one vault is never shown, or undone, in another. */
  readonly vaultKey: string | null;
  /** Changes when the index does, so the page shows what it now holds. */
  readonly indexKey: string;
  /**
   * Whether the index is ready to be asked; while it is not, nothing is read.
   * What was last read of this vault stays on the page meanwhile: the index
   * is refreshed after every change to a file, the page's own included, and
   * a page that emptied each time would lose its place, its focus and any
   * open menu. Ready unless said.
   */
  readonly indexReady?: boolean;
  /** Whether the page is showing, which is when it is read. */
  readonly open: boolean;
  /**
   * The writes in flight, held by the window for the vault so every tab on
   * Today shares them (tab-model.md, PR B); the hook holds its own when
   * handed none.
   */
  readonly held?: TodayWrites;
  /**
   * Where each change is said, with its Undo (#320): the window's toasts,
   * drawn outside the page so saying it draws no row. Nothing is said when
   * handed none.
   */
  readonly toasts?: Pick<Toasts, 'show'>;
}

/**
 * The Today page (#111): the day as the index has it, and its row actions —
 * the weekly review's writes, the last of them remembered so it can be taken
 * back. A row moves the moment it is acted on, to where its change leaves it
 * (`todayAsPending`, #260), and stays there until a read of the index made
 * after the write is on the page; a change that is refused or fails puts it
 * back. Nothing is reloaded.
 *
 * A row acts on what it showed. The page is always a little behind the
 * files, so an action is made only while the task still says what its row
 * read, and a row that has been acted on takes no other action until a read
 * made after the write is on the page.
 */
export function useToday(options: TodayOptions) {
  const { ports, editors, clock, types, vaultKey, indexKey, open, onSettled, activity, toasts } =
    options;
  const indexReady = options.indexReady ?? true;
  const [read, setRead] = useState<ReadFrom | null>(null);
  const [own] = useState(createTodayWrites);
  const held = options.held ?? own;
  const last = useStore(held.store, (state) => state.last);
  const settling = useStore(held.store, (state) => state.settling);
  const setLast = useCallback(
    (next: LastChange | null | ((was: LastChange | null) => LastChange | null)) =>
      held.store.setState((state) => ({
        last: typeof next === 'function' ? next(state.last) : next,
      })),
    [held],
  );
  const setSettling = useCallback(
    (next: (was: Settling) => Settling) =>
      held.store.setState((state) => ({ settling: next(state.settling) })),
    [held],
  );
  // Counts the reads begun by any tab, so a row can tell one made after its write from one already under way.
  const readsBegun = held.reads;
  // The index's key as a change begins. A read begun after the write can still
  // be of the index from before it, now that a refresh keeps the index ready
  // (#239): the row settles only on a read of an index that has moved since.
  const keyNow = useRef(indexKey);
  // The vault open now, read when a toast's Undo is pressed: one made in
  // another vault writes nothing here, through the window's panes or not.
  const vaultNow = useRef({ index: ports.index, vaultKey });
  vaultNow.current = { index: ports.index, vaultKey };
  keyNow.current = indexKey;
  const day = useDayOf(clock, open);
  // The types the sidebar's Inbox count is read with, so the page's Inbox link counts the same.
  const startInInbox = tasksStartInInbox(types);
  const { busy, problem, setProblem, actOn } = useReviewWrites({
    ports,
    editors,
    clock,
    onSettled,
    activity,
  });

  // The parts of the ports the read is made through: the window hands new
  // ports each time it lists the tree again, which is no reason to read (#325).
  const { index, fs, markdown } = ports;
  useEffect(() => {
    if (!open || !indexReady) return;
    let cancelled = false;
    readsBegun.begun += 1;
    const begun = readsBegun.begun;
    const land = (landed: Pick<ReadFrom, 'report' | 'error'>) => {
      if (cancelled) return;
      // A task that reads the same keeps its object, so its row is not drawn again (#217).
      setRead((before) => {
        const shown = before !== null && sameVault(before, { index, vaultKey }) ? before : null;
        const report =
          landed.report === null ? null : keptTodayReport(shown?.report ?? null, landed.report);
        return { index, vaultKey, error: landed.error, report };
      });
      setSettling((rows) => withoutSettledBy(rows, { begun, key: indexKey }));
    };
    readToday({ index, fs, markdown, clock, tasksStartInInbox: startInInbox })
      .then((report) => land({ report, error: null }))
      .catch((cause: unknown) => land({ report: null, error: errorMessage(cause) }));
    return () => {
      cancelled = true;
    };
    // `day` is here to read again when it turns; the read takes the day from the clock itself.
  }, [index, fs, markdown, clock, vaultKey, indexKey, indexReady, open, day, startInInbox]);

  // Only what was read of the vault now open: another vault's paths are not this one's.
  const ofThisVault = (from: OfAVault) => sameVault(from, { index: ports.index, vaultKey });
  const current = read !== null && ofThisVault(read) ? read : null;
  const undoable = last !== null && ofThisVault(last) ? last : null;
  const rows = useMemo(() => rowsAsRead(current?.report ?? null), [current]);
  const { index: indexOpen } = ports;
  const settlingHere = useMemo(
    () => new Set(sameVault(settling, { index: indexOpen, vaultKey }) ? settling.rows.keys() : []),
    [settling, indexOpen, vaultKey],
  );
  const pendingHere = sameVault(settling, { index: indexOpen, vaultKey })
    ? settling.changes
    : NONE_PENDING;
  // What was last drawn, so a pending task drawn the same as before keeps its
  // object through a re-read and its row is not drawn again (#217).
  const drawn = useRef<TodayReport | null>(null);
  const shownToday = useMemo(() => {
    if (current === null || current.report === null) return null;
    const pending = todayAsPending({ report: current.report, pending: pendingHere });
    const kept = pending === current.report ? pending : keptTodayReport(drawn.current, pending);
    drawn.current = kept;
    return kept;
  }, [current, pendingHere]);
  const knownHere = useMemo(
    () =>
      sameVault(settling, { index: indexOpen, vaultKey })
        ? new Map([...settling.known].map(([path, { task }]) => [path, task]))
        : NONE_KNOWN,
    [settling, indexOpen, vaultKey],
  );

  /** Takes one change back — only while it is still the last one, so an older toast undoes nothing. */
  const undoChange = useCallback(
    async (change: LastChange) => {
      if (held.store.getState().last !== change) return;
      if (!sameVault(change, vaultNow.current)) return;
      const { path } = change;
      const askedAt = keyNow.current;
      const undone = await actOn(path, (put) => put(change.undo));
      // An undo that could not be written is offered again, in a toast of its own, to be tried again.
      if (!undone) {
        if (sameVault(change, vaultNow.current)) offerAgain.current(change);
        return;
      }
      setLast((was) => (was === change ? null : was));
      // The task is back as it was, so its row can be acted on again — as what the
      // file held before the change, which the page's own read may be behind.
      const since = readsBegun.begun;
      setSettling((was) => ({
        ...was,
        rows: new Map([...was.rows].filter(([row]) => row !== path)),
        changes: new Map([...was.changes].filter(([row]) => row !== path)),
        known: new Map([...was.known, [path, { task: change.was, since, askedAt }]]),
      }));
    },
    [held, actOn],
  );
  // Said in the window's toasts as the change lands, in its commit, not in an effect after it.
  const offerAgain = useRef<(change: LastChange) => void>(() => undefined);
  const announce = useCallback(
    (change: LastChange) =>
      toasts?.show({
        message: todayActionWords(change),
        tone: 'change',
        slot: TODAY_TOAST,
        onUndo: () => void undoChange(change),
        // The undo lasts as long as the toast offering it: once that has gone, so has the undo.
        onGone: () => setLast((was) => (was === change ? null : was)),
      }),
    [toasts, undoChange, setLast],
  );
  useEffect(() => {
    offerAgain.current = (change) => {
      setLast(change);
      announce(change);
    };
  });

  const change = useCallback(
    async ({ path, title, action, values }: Change) => {
      if (settlingHere.has(path)) return;
      const askedAt = keyNow.current;
      const { fs, markdown, index } = ports;
      const row = knownHere.get(path) ?? rows.get(path);
      const guarded = row === undefined ? values : whileAsRead({ values, row });
      // Shown at once, in the same commit as the action: the row moves before the write lands.
      setSettling((was) => withPending(ofVault(was, { index, vaultKey }), { path, values }));
      let made: UndoableChange | null = null;
      await actOn(path, async (put) => {
        made = await changeUndoably({
          fs,
          markdown,
          path,
          write: (readAt) => put(guarded, readAt),
        });
      });
      // Only now: an action that was refused or failed leaves the earlier undo on offer, and its row back.
      if (made === null) {
        setSettling((was) => withoutPending(was, { path, values }));
        return;
      }
      // A change that could not be read back was still made: nothing to offer, and the row settles.
      const { undo: takeBack, was: before } = made as UndoableChange;
      const changed =
        takeBack === null
          ? null
          : { index, vaultKey, path, title, action, undo: takeBack, was: before };
      setLast(changed);
      if (changed !== null) announce(changed);
      const since = readsBegun.begun;
      setSettling((was) => withLanded(was, { path, values, landed: { since, askedAt } }));
    },
    [actOn, ports, vaultKey, rows, knownHere, settlingHere, announce],
  );

  const done = useCallback(
    (task: Row) => void change({ ...task, action: { kind: 'done' }, values: archiveTaskChange() }),
    [change],
  );
  const setStatus = useCallback(
    ({ status, ...task }: Row & { status: string }) =>
      void change({
        ...task,
        action: { kind: 'move', status },
        values: { [TASK_KEYS.status]: status },
      }),
    [change],
  );
  const defer = useCallback(
    ({ days, ...task }: Row & { days: number }) => {
      const deferral = taskDeferral({ today: clock.today(), days });
      if (deferral === null) setProblem('Today’s date could not be read, so nothing was deferred.');
      else void change({ ...task, action: { kind: 'defer', days }, values: deferral });
    },
    [change, clock, setProblem],
  );
  // Chosen for the clock's day, which is the page's own once it has read again at midnight.
  const choose = useCallback(
    ({ choice, ...task }: Row & { choice: TodayChoice }) =>
      void change({
        ...task,
        action: { kind: choice },
        values: focusChange({ choice, today: clock.today() }),
      }),
    [change, clock],
  );
  const undo = useCallback(
    async () => (undoable === null ? undefined : undoChange(undoable)),
    [undoable, undoChange],
  );
  const dismiss = useCallback(() => setLast(null), []);
  // One notice per change, kept across renders, so its time runs from when it was shown (#165).
  const undoNow = useRef(undo);
  useEffect(() => {
    undoNow.current = undo;
  });
  const notice = useMemo(
    () =>
      undoable === null
        ? null
        : {
            title: undoable.title,
            action: undoable.action,
            onUndo: () => void undoNow.current(),
            onDismiss: dismiss,
          },
    [undoable, dismiss],
  );

  return {
    /** Whether the vault has tasks, which is when the page's sidebar row shows. */
    shown: taskTypeOf(types) !== null,
    /** The last change, while it can be taken back — as its toast offers. */
    notice,
    page: {
      today: shownToday,
      error: current?.error ?? null,
      busy,
      problem,
      settling: settlingHere,
      onDone: done,
      onSetStatus: setStatus,
      onDefer: defer,
      onChoose: choose,
    },
  };
}

/**
 * The clock's day, asked again each minute and whenever the window is looked
 * at again, while the page is open: a page left open overnight — the Mac
 * asleep, timers and all — turns to the new day when it is next seen.
 */
function useDayOf(clock: Pick<TodayOptions['clock'], 'today'>, open: boolean): string {
  const [day, setDay] = useState(() => clock.today());
  useEffect(() => {
    if (!open) return;
    const ask = () => setDay(clock.today());
    ask();
    const timer = setInterval(ask, DAY_CHECK_MS);
    window.addEventListener('focus', ask);
    document.addEventListener('visibilitychange', ask);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', ask);
      document.removeEventListener('visibilitychange', ask);
    };
  }, [clock, open]);
  return day;
}

/** What each row on the page was read as, by its task's path. */
function rowsAsRead(report: TodayReport | null): ReadonlyMap<VaultPath, TaskAsRead> {
  const rows = new Map<VaultPath, TaskAsRead>();
  for (const section of report?.sections ?? []) {
    for (const group of section.groups) {
      for (const { path, status, due, defer, focus } of group.tasks)
        rows.set(path, { status, due, defer, focus: focus ?? null });
    }
  }
  return rows;
}

/**
 * When a write landed, as a read can tell it: `since` is the count of reads
 * begun by then, and `askedAt` the index's key as the write began. A read
 * catches up with the write when it began after it (#217) and its key has
 * moved since (#239): an index still at `askedAt` is of the vault from before.
 */
interface Landed {
  readonly since: number;
  readonly askedAt: string;
}

/** The rows acted on and not yet read back, and what the page knows better than its read. */
export interface Settling extends OfAVault {
  /** Each row acted on, and when its write landed: null while it is being written. */
  readonly rows: ReadonlyMap<VaultPath, Landed | null>;
  /** What is being written to each of those rows, which the page draws it as meanwhile. */
  readonly changes: ReadonlyMap<VaultPath, PropertyChanges>;
  /**
   * What a row's task is known to be, where the page knows better than its
   * last read: a change the page made and took back leaves the task as the
   * file held it before. Forgotten once a read has caught up with the undo.
   */
  readonly known: ReadonlyMap<VaultPath, Landed & { readonly task: TaskAsRead }>;
}

/** Something read or written in one vault, under one index. */
export interface OfAVault {
  readonly index: unknown;
  readonly vaultKey: string | null;
}

const sameVault = (left: OfAVault, right: OfAVault) =>
  left.index === right.index && left.vaultKey === right.vaultKey;

const NONE_KNOWN: ReadonlyMap<VaultPath, TaskAsRead> = new Map();
const NONE_PENDING: ReadonlyMap<VaultPath, PropertyChanges> = new Map();

/** What is settling in this vault: nothing of another vault's carries over. */
const ofVault = (settling: Settling, vault: OfAVault): Settling =>
  sameVault(settling, vault) ? settling : { ...NOTHING_SETTLING, ...vault };

/** With a row being written: held, and drawn as its change leaves it. */
function withPending(
  settling: Settling,
  { path, values }: { readonly path: VaultPath; readonly values: PropertyChanges },
): Settling {
  return {
    ...settling,
    rows: new Map([...settling.rows, [path, null]]),
    changes: new Map([...settling.changes, [path, values]]),
  };
}

/** Without a row whose change was refused or failed: it is drawn as read again, and free. */
function withoutPending(
  settling: Settling,
  { path, values }: { readonly path: VaultPath; readonly values: PropertyChanges },
): Settling {
  // Only this action's own: the changes are this action's object, so another vault's never match.
  if (settling.changes.get(path) !== values) return settling;
  return {
    ...settling,
    rows: new Map([...settling.rows].filter(([row]) => row !== path)),
    changes: new Map([...settling.changes].filter(([row]) => row !== path)),
  };
}

/** With a row's write landed: held, and drawn as changed, until a read catches up with it. */
function withLanded(
  settling: Settling,
  {
    path,
    values,
    landed,
  }: { readonly path: VaultPath; readonly values: PropertyChanges; readonly landed: Landed },
): Settling {
  // Only this action's own row: one let go since — another vault opened — stays let go.
  if (settling.changes.get(path) !== values) return settling;
  return { ...settling, rows: new Map([...settling.rows, [path, landed]]) };
}

/**
 * Without what a read has caught up with: the `begun`-th read, of the index as
 * `key` says, settles the rows and lets go of the undone tasks whose writes
 * landed before it began, once the index has moved since they began.
 */
function withoutSettledBy(
  settling: Settling,
  read: { readonly begun: number; readonly key: string },
): Settling {
  const moment = { at: read.begun, indexKey: read.key };
  const behind = (landed: Landed | null) =>
    !readAnswers(landed === null ? null : { at: landed.since, indexKey: landed.askedAt }, moment);
  const rows = new Map([...settling.rows].filter(([, landed]) => behind(landed)));
  const changes = new Map([...settling.changes].filter(([path]) => rows.has(path)));
  const known = new Map([...settling.known].filter(([, landed]) => behind(landed)));
  const unchanged = rows.size === settling.rows.size && known.size === settling.known.size;
  return unchanged ? settling : { ...settling, rows, changes, known };
}

/** The row acted on: its task, and what the page calls it. */
interface Row {
  readonly path: VaultPath;
  readonly title: string;
}

interface Change extends Row {
  readonly action: TodayAction;
  readonly values: PropertyChanges;
}

/** The last change the page wrote, the vault it was written in, and the change that takes it back. */
export interface LastChange extends Row, OfAVault {
  readonly action: TodayAction;
  /** The change that takes it back. */
  readonly undo: PropertyChanges;
  /** What the task was before, and is again once undone. */
  readonly was: TaskAsRead;
}

/** A read of the page, and the index it was read from. */
interface ReadFrom extends OfAVault {
  readonly report: TodayReport | null;
  readonly error: string | null;
}
