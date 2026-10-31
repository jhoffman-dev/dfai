import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import {
  clarifyVocabulary,
  createVaultPath,
  FILED_UNDER_TYPES,
  filingRefusal,
  noteTitle,
  PERSON_TYPE,
  tasksStartInInbox,
  waitingOnRefusal,
  type Clarification,
  type EntryMove,
  type GtdStatus,
  type InboxKey,
  type ObjectType,
  type VaultPath,
} from '@dfai/domain';
import {
  clarifiedAnything,
  clarifyInboxItem,
  ClarifyRefusedError,
  listInbox,
  listInboxThrough,
  notesInUseOfTypes,
  undoClarifyInboxItem,
  type ActivityLog,
  type ArchivePorts,
  type ClarifyOutcome,
  type ClarifyUndo,
  type Clock,
  type InboxListing,
  type ReadMoment,
  type WindowClosingPort,
} from '@dfai/application';
import type { InboxRefusal, RelationChoice } from '@dfai/ui';
import { withGiveUpRecorded } from '../activity/with-give-up-recorded.ts';
import { useAnswersWrittenBeforeClose } from '../proposals/answer-queue.ts';
import { errorMessage } from '../query/error-message.ts';
import type { Toasts } from '../toasts/toasts.ts';
import {
  returnSettled,
  withoutLeaving,
  type LeavingRow,
  type ReturningRow,
} from './leaving-rows.ts';
import { keptWhereSame } from './kept-where-same.ts';
import { notesAfterOwnMoves } from './own-moves.ts';
import { useSummaryPending } from './use-summary-pending.ts';
import { createInboxWrites, type InboxSaid, type InboxWrites } from './inbox-writes.ts';
import { useUntilListedAgain } from '../rows/until-listed-again.ts';

export { LISTED_AGAIN_LIMIT_MS } from '../rows/until-listed-again.ts';

export interface InboxOptions {
  readonly ports: ArchivePorts;
  readonly notePaths: readonly VaultPath[];
  /** The vault that is open, which everything the page shows is read from; null with none. */
  readonly vaultKey: string | null;
  /** The vault's types: once its tasks start in the Inbox, a status is what clarifies one. */
  readonly types: readonly ObjectType[];
  readonly clock: Pick<Clock, 'today'>;
  /** Changes when the index does, so the Inbox lists what it now holds. */
  readonly indexKey: string;
  /**
   * Changes when the projects, areas or people it offers may have: what to
   * file under and who a task waits on are read again on it. The index's key
   * when not said.
   */
  readonly choicesKey?: string;
  /** Whether the index is ready to be asked; while it builds, nothing is read or shown. Ready unless said. */
  readonly indexReady?: boolean;
  /** Whether the Inbox page is showing, which is when what to file under is read. */
  readonly open: boolean;
  /**
   * Re-reads the tree and the index once the clarifications asked for are all
   * written. What it hands back settles once the index holds them — false if
   * it does not — and nothing handed back means it does at once.
   */
  readonly onSettled: () => Promise<boolean> | void;
  /** Where a write the page gives up on is recorded; a refusal is not. */
  readonly activity: Pick<ActivityLog, 'inOpenVault'>;
  /** The window's close, held until the clarifications still being written are written. */
  readonly closing: WindowClosingPort;
  /**
   * The writes in flight, held by the window for the vault so every tab on
   * the Inbox shares them (tab-model.md, PR B); the hook holds its own when
   * handed none.
   */
  readonly held?: InboxWrites;
  /**
   * Where each clarification is said once written, with its Undo (#320):
   * the window's toasts, drawn outside the page so saying it draws no row.
   * Nothing is said when handed none.
   */
  readonly toasts?: Pick<Toasts, 'show'>;
}

/** The page's one place in the window's toasts: a clarification takes the place of the one before. */
const INBOX_TOAST = 'inbox';

/** The last clarification, which its toast offers to take back. */
type LastClarification = NonNullable<InboxSaid['last']>;

/** What the row says once a note is clarified: only what could not be done. */
function outcomeProblem(outcome: ClarifyOutcome): string | null {
  if (outcome.failed.length === 0) return null;
  return outcome.failed.map(({ path, reason }) => `${noteTitle(path)}: ${reason}`).join(' ');
}

/**
 * The Inbox page (P30-01, #112): what waits — the `Inbox` folder's notes and
 * every task still at Inbox — what a note can be filed under and who a task
 * can wait on, clarifying a row, and taking the last one back. The rules are
 * the use-cases'; this holds what is on screen.
 *
 * A clarified row leaves the list at once and is written in the background,
 * after any still being written (#217), so the next row can be worked
 * straight away. One that fails comes back with why. The tree and the index
 * are read again once every clarification asked for is written — not once
 * for each — and a row that left stays off the list until a read of the
 * index that has caught up with its write lands.
 *
 * The list is read whatever page is open, so the sidebar's count is right;
 * the projects, areas and people only while the page shows. Everything shown
 * is what the open vault's index answered (#55): after a vault switch the
 * last read's paths are another vault's, so neither they nor their actions
 * are offered until this one's read is in. While the same vault's index
 * re-reads, what it last answered stays up, and so does what a row holds.
 */
export function useInbox(options: InboxOptions) {
  const { ports, notePaths, vaultKey, types, clock, indexKey, open, onSettled, activity } = options;
  const { toasts } = options;
  const choicesKey = options.choicesKey ?? indexKey;
  const settled = useIndexMovedOn({ vaultKey, indexKey });
  // Asked only while it is ready; what it last answered for this vault stays up while it re-reads.
  const fresh = settled && (options.indexReady ?? true);
  const [choices, setChoices] = useState<Choices | null>(null);
  const [own] = useState(createInboxWrites);
  const held = options.held ?? own;
  const said = useStore(held.store, (state) => state.said);
  const setSaid = useCallback(
    (next: (before: InboxSaid | null) => InboxSaid | null) =>
      held.store.setState((state) => ({ said: next(state.said) })),
    [held],
  );
  const [undoing, setUndoing] = useState(0);
  const {
    actions: writes,
    leaving,
    caughtUp,
  } = useClarifyWrites({
    held,
    onSettled,
    closing: options.closing,
    vaultKey,
    notePaths,
    indexKey,
  });
  const startInInbox = tasksStartInInbox(types);
  const { listing, showMore } = useInboxListing({
    index: ports.index,
    vaultKey,
    indexKey,
    fresh,
    tasksStartInInbox: startInInbox,
    moment: writes.moment,
    caughtUp,
  });

  useEffect(() => {
    if (!open || !fresh) return;
    let cancelled = false;
    readChoices(ports.index)
      .then((found) => {
        if (cancelled) return;
        // The same projects and people as last time are the same lists, so no row is drawn again for them.
        setChoices((before) => {
          const same = before?.vaultKey === vaultKey ? before : null;
          return {
            vaultKey,
            filing: keptWhereSame(same?.filing ?? null, found.filing, byPath),
            people: keptWhereSame(same?.people ?? null, found.people, byPath),
            error: null,
          };
        });
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setChoices({ vaultKey, filing: [], people: [], error: errorMessage(cause) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [ports.index, choicesKey, fresh, vaultKey, open]);

  const shown = settled && listing?.vaultKey === vaultKey ? listing : null;
  const offered = settled && choices?.vaultKey === vaultKey ? choices : null;
  const told = said?.vaultKey === vaultKey ? said : null;
  const contents = useMemo(
    () =>
      shown?.contents === null || shown?.contents === undefined
        ? null
        : withoutLeaving(
            shown.contents,
            leaving.vaultKey === vaultKey ? leaving.rows : NO_ROWS,
            shown.read,
          ),
    [shown, leaving, vaultKey],
  );

  const shownRead = shown?.read ?? null;
  const listedAgain = useUntilListedAgain(
    useCallback(
      (row: ReturningRow) => returnSettled(row, contents, shownRead),
      [contents, shownRead],
    ),
    vaultKey,
  );

  /** Says what a write left, of the vault it was asked in; `kept` leaves the last action to take back. */
  const say = useCallback(
    (asked: string | null, result: Result) =>
      setSaid((before) => {
        const same = before?.vaultKey === asked ? before : null;
        const refusals = same?.refusals ?? NO_REFUSALS;
        return {
          vaultKey: asked,
          problem: result.problem,
          refusals: result.row === undefined ? refusals : withRowSaid(refusals, result.row),
          last: result.last === 'kept' ? (same?.last ?? null) : result.last,
        };
      }),
    [setSaid],
  );

  // Said in the window's toasts as the write lands, in its commit, not in an effect after it.
  const announce = useCallback(
    (clarified: LastClarification) =>
      toasts?.show({
        message: `Clarified “${clarified.title}”.`,
        tone: 'change',
        slot: INBOX_TOAST,
        onUndo: () => void undoNow.current(clarified),
        onGone: () =>
          setSaid((before) => (before?.last === clarified ? { ...before, last: null } : before)),
      }),
    [toasts, setSaid],
  );

  const clarify = useCallback(
    ({ path, clarification }: { path: VaultPath; clarification: Clarification }) => {
      if (!settled) return Promise.resolve(false);
      // Made a task, a note stays in the Inbox, on a row of its own; anything else leaves it.
      const leaves = clarification.asTask !== true;
      const asked = vaultKey;
      if (leaves) writes.leave(asked, path);
      const write = clarification.project === undefined ? 'edit' : 'filing';
      const named = { activity: logOfVaultOpenNow(activity), write, path } as const;
      return writes.enqueue(ports, asked, async (given) => {
        try {
          const outcome = await withGiveUpRecorded({ ...named, refusal: ClarifyRefusedError }, () =>
            clarifyInboxItem({
              ports: given.ports,
              path,
              clarification,
              notePaths: given.notePaths,
              today: clock.today(),
            }),
          );
          // What could not be done is said on the row, not in Activity: an outcome with
          // its undo is no give-up, as Archive says a note moved but not stamped.
          const reason = outcomeProblem(outcome);
          // Said on the row the note is on now — filed, its new path's — and cleared where it was.
          const row = { path: outcome.path, was: path, reason };
          const changed = clarifiedAnything(outcome);
          // Clarified but not filed — the move refused, say — the row comes back to say why.
          if (reason === null && leaves && changed) writes.written(asked, path);
          else writes.stay(asked, path);
          // Nothing changed is nothing to call clarified, nor to take back.
          if (!changed) {
            say(asked, { problem: null, row, last: 'kept' });
            return NOT_WRITTEN;
          }
          const clarified = { title: noteTitle(path), undo: outcome.undo };
          say(asked, { problem: null, row, last: clarified });
          announce(clarified);
          return { done: reason === null, wrote: true };
        } catch (cause) {
          writes.stay(asked, path);
          say(asked, {
            problem: null,
            row: { path, reason: errorMessage(cause) },
            last: 'kept',
          });
          return NOT_WRITTEN;
        }
      });
    },
    [settled, vaultKey, writes, activity, ports, clock, say, announce],
  );

  const last = told?.last ?? null;
  // The vault open now, read as an undo ends: a vault opened meanwhile is offered nothing of the last one's.
  const vaultNow = useRef(vaultKey);
  vaultNow.current = vaultKey;
  /**
   * Takes one clarification back — only while it is still the last one of the
   * vault open now, so an older toast, or one made in another vault, undoes nothing.
   */
  const undoClarification = useCallback(
    (taken: LastClarification, returning?: ReturningRow) => {
      const shown = held.store.getState().said;
      if (!settled || shown?.vaultKey !== vaultKey || shown.last !== taken) {
        return Promise.resolve(false);
      }
      const asked = vaultKey;
      const path = taken.undo.to;
      const named = { activity: logOfVaultOpenNow(activity), write: 'edit', path } as const;
      setUndoing((count) => count + 1);
      return writes
        .enqueue(ports, asked, async (given) => {
          // Pressed twice, or for one already taken back: there is nothing left to take back.
          if (writes.undone(taken.undo)) return NOT_WRITTEN;
          try {
            await withGiveUpRecorded({ ...named, refusal: ClarifyRefusedError }, () =>
              undoClarifyInboxItem({
                ports: given.ports,
                undo: taken.undo,
                notePaths: given.notePaths,
              }),
            );
            writes.markUndone(taken.undo);
            // Waits, with the rows written, for the refresh this write asks for.
            if (returning !== undefined) held.held.returning.push(returning);
            // Its toast has gone by now — pressing Undo sends it — so the last may already be let go.
            setSaid((before) =>
              before?.vaultKey === asked && (before.last === taken || before.last === null)
                ? {
                    ...before,
                    problem: null,
                    refusals: withRowSaid(before.refusals, {
                      path: taken.undo.from,
                      was: taken.undo.to,
                      reason: null,
                    }),
                    last: null,
                  }
                : before,
            );
            return { done: true, wrote: true };
          } catch (cause) {
            // Not taken back: it is offered again, in a toast of its own, to be tried again.
            const still = vaultNow.current === asked;
            say(asked, { problem: errorMessage(cause), last: still ? taken : 'kept' });
            if (still) announce(taken);
            return NOT_WRITTEN;
          }
        })
        .finally(() => setUndoing((count) => count - 1));
    },
    [settled, held, vaultKey, activity, writes, ports, say, setSaid, announce],
  );
  const undo = useCallback(
    () => (last === null ? Promise.resolve(false) : undoClarification(last)),
    [last, undoClarification],
  );
  /**
   * The same from the keyboard (#109), resolving to where the note it took
   * back is listed again, or null when it took none. It waits for any
   * clarification still being written first: until that lands, the undo on
   * offer is the one before it, which is not the one asked for.
   */
  const takeBackLast = useCallback(async (): Promise<VaultPath | null> => {
    await writes.drained();
    const taken = held.store.getState().said?.last ?? null;
    if (taken === null) return null;
    const back: ReturningRow = { path: taken.undo.from, settled: null };
    if (!(await undoClarification(taken, back))) return null;
    // Not at once: reads begun before the index caught up still lack the row,
    // and the page gives up on a row after a few lists without it (#109).
    await listedAgain(back);
    return back.path;
  }, [writes, held, undoClarification, listedAgain]);

  // The undo lasts as long as the toast offering it (#165): once that has gone, so has the undo.
  const dismissLastAction = useCallback(
    () => setSaid((before) => (before === null ? null : { ...before, last: null })),
    [setSaid],
  );
  const undoNow = useRef(undoClarification);
  useEffect(() => {
    undoNow.current = undoClarification;
  });

  const summaryPending = useSummaryPending({
    ports,
    notePaths,
    vaultKey,
    items: contents?.items ?? null,
    open,
    clock,
    indexKey,
  });

  // The types are read again after every write: the same statuses are kept the
  // same list, or every row would be drawn again for a list that says the same (#217).
  const statusesWere = useRef<readonly GtdStatus[] | null>(null);
  const statuses = useMemo(() => {
    const read = clarifyVocabulary(types).statuses;
    return keptWhereSame(statusesWere.current, read, String);
  }, [types]);
  useEffect(() => {
    statusesWere.current = statuses;
  }, [statuses]);
  // One object per clarification, not one per render: its bar's time is kept by it (#165).
  const lastAction = useMemo(() => (last === null ? null : { title: last.title }), [last]);
  return {
    contents,
    /** The statuses a row may give a task: the ones the vault's Task type declares. */
    statuses,
    error: shown?.error ?? offered?.error ?? null,
    filing: offered?.filing ?? NONE,
    people: offered?.people ?? NONE,
    /** While an undo is being written, so it is not asked for twice. */
    busy: undoing > 0,
    /** Why the last undo could not be done, or null. */
    problem: told?.problem ?? null,
    /** Why each row's last clarification was refused or left unfinished, until that row is clarified again. */
    refusals: told?.refusals ?? NO_REFUSALS,
    /** Why each imported meeting listed still waits for its summary, by path (#186). */
    summaryPending,
    /** The last clarification, while it can be taken back. */
    lastAction,
    clarify,
    undo,
    takeBackLast,
    dismissLastAction,
    /** Lists the next page of what waits (#167). */
    showMore,
    /** Settles once every clarification asked for so far is written, or has failed. */
    written: writes.drained,
  };
}

/** The refusals said, with one row's said again: its reason now, or none — and none where it was. */
function withRowSaid(refusals: readonly InboxRefusal[], row: SaidRow): readonly InboxRefusal[] {
  const others = refusals.filter((each) => each.path !== row.path && each.path !== row.was);
  return row.reason === null ? others : [...others, { path: row.path, reason: row.reason }];
}

/**
 * The Activity log of the vault open now, kept for a write that may begin
 * later: a clarification queued behind others is recorded where it was asked
 * for, not in whatever vault is open by the time it is written.
 */
function logOfVaultOpenNow(
  activity: Pick<ActivityLog, 'inOpenVault'>,
): Pick<ActivityLog, 'inOpenVault'> {
  const recorder = activity.inOpenVault();
  return { inOpenVault: () => recorder };
}

/** What one queued write did: whether it was done, and whether it wrote. */
interface Written {
  readonly done: boolean;
  readonly wrote: boolean;
}

const NOT_WRITTEN: Written = { done: false, wrote: false };

/** What a queued write is handed as it begins: the vault's notes as they stand, and the ports to write through. */
interface WriteGiven {
  readonly notePaths: readonly VaultPath[];
  readonly ports: ArchivePorts;
}

/**
 * The clarifications being written behind the page (#217): one after another,
 * in the order asked for, as Proposals writes its answers (#166) — and held
 * to by the window's close. Which rows have left the list before the index
 * says so, and the moves the tree has not caught up with, are kept here.
 *
 * A written row is the index's to show again only once a refresh asked for
 * after it was written has landed: a sync already under way when it was
 * written may have read the Inbox before it moved (#217).
 */
function useClarifyWrites({
  held,
  onSettled,
  closing,
  vaultKey,
  notePaths,
  indexKey,
}: {
  held: InboxWrites;
  onSettled: InboxOptions['onSettled'];
  closing: WindowClosingPort;
  vaultKey: string | null;
  notePaths: readonly VaultPath[];
  indexKey: string;
}) {
  const { store, queue, held: kept } = held;
  const caughtUp = useStore(store, (state) => state.caughtUp);
  const leaving = useStore(store, (state) => state.leaving);
  // Read when a write begins or ends, not when it was asked for: the latest the page knows.
  useEffect(() => {
    kept.latest = { vaultKey, notePaths, indexKey };
  }, [kept, vaultKey, notePaths, indexKey]);

  const setRow = useCallback(
    (vaultKey: string | null, path: VaultPath, row: LeavingRow | null) => {
      store.setState(({ leaving: before }) => {
        const rows = (before.vaultKey === vaultKey ? before.rows : []).filter(
          (each) => each.path !== path,
        );
        return { leaving: { vaultKey, rows: row === null ? rows : [...rows, row] } };
      });
    },
    [store],
  );

  /** A refresh asked for once `rows` were written has landed: a read begun since, past `askedAt`, answers for them. */
  const refreshed = useCallback(
    (rows: readonly LeavingRow[], askedAt: string, back: readonly ReturningRow[]) => {
      kept.moment.current += 1;
      const settled = { at: kept.moment.current, indexKey: askedAt };
      for (const row of back) row.settled = settled;
      const answered = new Set(rows);
      store.setState(({ leaving: before, caughtUp: count }) => ({
        leaving: {
          ...before,
          rows: before.rows.map((row) => (answered.has(row) ? { ...row, settled } : row)),
        },
        caughtUp: count + 1,
      }));
    },
    [kept, store],
  );

  // What the queue does as it drains, as the tab drawing now would: the latest `onSettled`.
  useEffect(() => {
    kept.onDrained = () => {
      if (!kept.wroteSinceDrained) return;
      kept.wroteSinceDrained = false;
      const rows = kept.unrefreshed;
      const back = kept.returning;
      kept.unrefreshed = [];
      kept.returning = [];
      const askedAt = kept.latest.indexKey;
      // Not held: the rows wait for the next refresh asked for after a write.
      const waitAgain = () => {
        kept.unrefreshed = [...rows, ...kept.unrefreshed];
        kept.returning = [...back, ...kept.returning];
      };
      void Promise.resolve(onSettled()).then(
        (held) => (held === false ? waitAgain() : refreshed(rows, askedAt, back)),
        (cause: unknown) => {
          console.error('The index could not be refreshed after the Inbox was written:', cause);
          waitAgain();
        },
      );
    };
  }, [kept, onSettled, refreshed]);
  useAnswersWrittenBeforeClose(queue, closing);

  const enqueue = useCallback(
    (ports: ArchivePorts, asked: string | null, write: (given: WriteGiven) => Promise<Written>) => {
      let done = false;
      // The vault's notes as they were when asked, for a write that begins once another vault is open.
      const askedIn = kept.latest.notePaths;
      queue.enqueue(ports, async () => {
        const tree = kept.latest.vaultKey === asked ? kept.latest.notePaths : askedIn;
        const own = kept.ownMoves.vaultKey === asked ? kept.ownMoves.moves : [];
        const known = notesAfterOwnMoves(tree, own);
        const moving = keepingMoves(ports);
        try {
          const result = await write({ notePaths: known.notes, ports: moving.ports });
          if (result.wrote) kept.wroteSinceDrained = true;
          done = result.done;
        } finally {
          // A move made before the write failed is as real as one made by a write that was done.
          const moved = moving.moved();
          kept.ownMoves = { vaultKey: asked, moves: [...known.unseen, ...moved] };
          if (moved.length > 0) kept.wroteSinceDrained = true;
        }
      });
      // Settles once this write — and the re-read, when it was the last — is done.
      return queue.drained().then(() => done);
    },
    [kept, queue],
  );

  const actions = useMemo(
    () => ({
      enqueue,
      moment: kept.moment,
      drained: queue.drained,
      /** Takes a row off the list while it is written. */
      leave: (vaultKey: string | null, path: VaultPath) =>
        setRow(vaultKey, path, { path, settled: null }),
      /** Its write is done: off the list until a refresh asked for since has landed, and a read after it. */
      written: (vaultKey: string | null, path: VaultPath) => {
        const row = { path, settled: null };
        kept.unrefreshed.push(row);
        setRow(vaultKey, path, row);
      },
      /** Its write was refused or failed: the row is back. */
      stay: (vaultKey: string | null, path: VaultPath) => setRow(vaultKey, path, null),
      undone: (undo: ClarifyUndo) => kept.undone.has(undo),
      markUndone: (undo: ClarifyUndo) => void kept.undone.add(undo),
    }),
    [enqueue, kept, queue.drained, setRow],
  );
  // Apart from the actions, so a row leaving does not make every row's actions new.
  return { actions, leaving, caughtUp };
}

/** `ports`, keeping every move a write makes through them — one made before the write then failed included. */
function keepingMoves(ports: ArchivePorts): {
  readonly ports: ArchivePorts;
  readonly moved: () => readonly EntryMove[];
} {
  const moved: EntryMove[] = [];
  const moveEntry: ArchivePorts['fs']['moveEntry'] = async (move) => {
    await ports.fs.moveEntry(move);
    moved.push({ from: move.from, to: move.to });
  };
  return { ports: { ...ports, fs: { ...ports.fs, moveEntry } }, moved: () => moved };
}

const NO_ROWS: readonly LeavingRow[] = [];

const NONE: readonly RelationChoice[] = [];

/** A read of the Inbox, and the vault it was read from. */
interface Listing {
  readonly vaultKey: string | null;
  readonly contents: InboxListing | null;
  readonly error: string | null;
  /** When the read began, so a row that left since is kept off what it found. */
  readonly read: ReadMoment;
}

/** What a row can be filed under and who it can wait on, and the vault they are in. */
interface Choices {
  readonly vaultKey: string | null;
  readonly filing: readonly RelationChoice[];
  readonly people: readonly RelationChoice[];
  readonly error: string | null;
}

/** One row's reason said again; `was` is where the note was, when it has moved, cleared too. */
interface SaidRow {
  readonly path: VaultPath;
  readonly was?: VaultPath;
  readonly reason: string | null;
}

/**
 * What an action leaves to say: `row` says again what one row's clarification
 * left — why it was refused, or nothing — and every other row keeps what it
 * was told; `kept` leaves the last clarification to take back as it was.
 */
interface Result {
  readonly problem: string | null;
  readonly row?: SaidRow;
  readonly last: InboxSaid['last'] | 'kept';
}

const NO_REFUSALS: readonly InboxRefusal[] = [];

/** Only what clarifying would accept: never a project still in the Inbox, or an archived person. */
async function readChoices(
  index: ArchivePorts['index'],
): Promise<Pick<Choices, 'filing' | 'people'>> {
  const [projects, people] = await Promise.all([
    notesInUseOfTypes({ index, types: FILED_UNDER_TYPES }),
    notesInUseOfTypes({ index, types: [PERSON_TYPE] }),
  ]);
  const at = (note: { path: string }) => createVaultPath(note.path);
  return {
    filing: projects.filter((note) => filingRefusal({ path: at(note), type: note.type }) === null),
    people: people.filter((note) => waitingOnRefusal({ path: at(note), type: note.type }) === null),
  };
}

/**
 * What waits, as the page lists it: the first page, and a page more each
 * time more are asked for (#167) — each read on from the last note listed,
 * never by position and never from the top again, so no read is larger than
 * a page and filing between pages skips nothing. Read again when the index
 * changes, it reads up to the last note shown, a page at a time; another
 * vault starts at its first page.
 */
function useInboxListing({
  index,
  vaultKey,
  indexKey,
  fresh,
  tasksStartInInbox,
  moment,
  caughtUp,
}: {
  index: InboxOptions['ports']['index'];
  vaultKey: string | null;
  indexKey: string;
  fresh: boolean;
  tasksStartInInbox: boolean;
  /** The page's clock of reads and writes, which each read is stamped from as it begins. */
  moment: { current: number };
  /** Changes once a refresh asked for after the page's writes lands: read again, to show what it answers. */
  caughtUp: number;
}) {
  const [listing, setListing] = useState<Listing | null>(null);
  // How far down the page has been shown, by the last note listed; nothing past the first page until asked.
  const reach = useRef<{ vaultKey: string | null; through: InboxKey } | null>(null);
  // One more each time a read lands in the list, so a page knows whether the list it extends is still up.
  const landed = useRef(0);
  const [readAgain, setReadAgain] = useState(0);
  const land = useCallback((next: Listing) => {
    landed.current += 1;
    setListing((before) => ({ ...next, contents: keptRows(before, next) }));
  }, []);

  useEffect(() => {
    if (!fresh) return;
    let cancelled = false;
    const begunFrom = reach.current;
    const through = begunFrom?.vaultKey === vaultKey ? begunFrom.through : null;
    moment.current += 1;
    const begun = { at: moment.current, indexKey };
    const read =
      through === null
        ? listInbox({ index, tasksStartInInbox })
        : listInboxThrough({ index, through, tasksStartInInbox });
    // Shown further down while this read ran: what it found stops short of that, so read again that far.
    const reachedPast = () => reach.current !== begunFrom && reach.current?.vaultKey === vaultKey;
    const settle = (next: Listing) => {
      if (cancelled) return;
      if (reachedPast()) setReadAgain((count) => count + 1);
      else land(next);
    };
    read
      .then((contents) => settle({ vaultKey, contents, error: null, read: begun }))
      .catch((cause: unknown) =>
        settle({ vaultKey, contents: null, error: errorMessage(cause), read: begun }),
      );
    return () => {
      cancelled = true;
    };
  }, [index, indexKey, fresh, vaultKey, tasksStartInInbox, readAgain, land, moment, caughtUp]);

  const showMore = useCallback(() => {
    const shown = listing?.vaultKey === vaultKey ? listing.contents : null;
    // The list is as old as its first page: a row that left since that read stays off it.
    const read = listing?.read ?? { at: 0, indexKey: '' };
    const after = shown?.last ?? null;
    if (shown === null || !shown.truncated || after === null) return;
    const begun = landed.current;
    listInbox({ index, after, tasksStartInInbox })
      .then((page) => {
        reach.current = { vaultKey, through: page.last ?? after };
        // Another read landed meanwhile, so the list is newer than this page: read it again, this far down.
        if (landed.current !== begun) setReadAgain((count) => count + 1);
        else land({ vaultKey, contents: followedBy(shown, page), error: null, read });
      })
      .catch((cause: unknown) => {
        if (landed.current === begun)
          land({ vaultKey, contents: shown, error: errorMessage(cause), read });
      });
  }, [listing, vaultKey, index, tasksStartInInbox, land]);

  return { listing, showMore };
}

const byPath = (each: { readonly path: string }) => each.path;

/** What a read found, keeping the rows the list already shows unchanged, for the same vault. */
function keptRows(before: Listing | null, next: Listing): InboxListing | null {
  const shown = before?.vaultKey === next.vaultKey ? (before.contents?.items ?? null) : null;
  if (next.contents === null || shown === null) return next.contents;
  return { ...next.contents, items: keptWhereSame(shown, next.contents.items, byPath) };
}

/** The list as shown, with the page read on from its last note after it. */
function followedBy(shown: InboxListing, page: InboxListing): InboxListing {
  return {
    items: [...shown.items, ...page.items],
    truncated: page.truncated,
    total: page.total,
    last: page.last ?? shown.last,
  };
}

/**
 * Whether the index has moved on to the vault that is open. On the render a
 * vault opens, the key already says `building` (#238), unless the store still
 * holds that very vault — a switch back before the other vault's sync began —
 * when it says that vault's last `ready:N`, with rows the index may no longer
 * hold. Either way the key the switch was made under is remembered, and
 * nothing is read, shown or written until it has changed. Once it has, every
 * later key is this vault's — a rebuild says `building` again, which may be
 * the very key the switch was made under — so it stays moved on.
 */
function useIndexMovedOn({
  vaultKey,
  indexKey,
}: {
  vaultKey: string | null;
  indexKey: string;
}): boolean {
  const [opened, setOpened] = useState({
    vaultKey,
    staleIndexKey: null as string | null,
    movedOn: false,
  });
  if (opened.vaultKey !== vaultKey) {
    setOpened({ vaultKey, staleIndexKey: indexKey, movedOn: false });
    return false;
  }
  if (opened.movedOn) return true;
  if (indexKey === opened.staleIndexKey) return false;
  setOpened({ ...opened, movedOn: true });
  return true;
}
