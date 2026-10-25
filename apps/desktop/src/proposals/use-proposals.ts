import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { noteTitle, type VaultPath } from '@dfai/domain';
import {
  acceptProposalNote,
  listProposals,
  ProposalRefused,
  rejectProposalNote,
  TaskRuleRefusedError,
  undoAcceptedProposal,
  undoRejectedProposal,
  type AcceptedProposal,
  type ActivityLog,
  type Clock,
  type ProposalArchived,
  type ProposalListing,
  type ProposalPorts,
  type RejectedProposal,
  type WindowClosingPort,
} from '@dfai/application';
import type { ProposalsContents, ProposalsSectionProps, RowSelection } from '@dfai/ui';
import { withGiveUpRecorded } from '../activity/with-give-up-recorded.ts';
import { useRowSelection } from '../archive/use-row-selection.ts';
import { answeredNotice, inTurn, undoneNotice, type InTurn } from './answer-many.ts';
import { useAnswersWrittenBeforeClose } from './answer-queue.ts';
import {
  PROPOSALS_TOAST,
  staysOnPage,
  toastProposal,
  type ProposalNotice,
} from './proposal-notice.ts';
import { createProposalWrites, type ProposalWrites } from './proposal-writes.ts';
import type { Toasts } from '../toasts/toasts.ts';

export interface ProposalsOptions {
  readonly ports: ProposalPorts;
  readonly clock: Pick<Clock, 'today'>;
  /** Changes when the index does — a proposal synced in, say — so the list is read again. */
  readonly indexKey: string;
  /** Re-reads the tree and the index once an answer has written or moved notes. */
  readonly onSettled: () => void;
  /** Where an answer the section gives up on is recorded; a refusal is not. */
  readonly activity: Pick<ActivityLog, 'inOpenVault'>;
  /** The window's close, held until the answers still being written are written. */
  readonly closing: WindowClosingPort;
  /**
   * The answers in flight, held by the window for the vault so every tab on
   * the Inbox shares them (tab-model.md, PR B); the hook holds its own when
   * handed none.
   */
  readonly held?: ProposalWrites;
  /** The window's toasts, where an answer is said with its Open and its Undo (UI v2, slice 15). */
  readonly toasts: Pick<Toasts, 'show'>;
  /** Opens the note an accept made, from its toast. */
  readonly onOpen: (path: VaultPath) => void;
}

/** What an answer refuses so as not to write over or lose anything: shown on the card, no fault. */
const ANSWER_REFUSALS = [ProposalRefused, TaskRuleRefusedError];

/** What the Inbox's Proposals section takes from here: everything but where it opens notes. */
export type ProposalsSectionState = Omit<ProposalsSectionProps, 'onOpen' | 'onOpenSource'>;

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** Says where a decided proposal went, and only when it could not go to the Archive. */
function archivedNote(archived: ProposalArchived): string {
  return archived.archiveProblem === null
    ? ''
    : ` The proposal stayed in the Inbox: ${archived.archiveProblem}`;
}

function acceptedNotice(accepted: AcceptedProposal): ProposalNotice {
  const [made] = accepted.wrote;
  return {
    text: `Accepted: ${accepted.headline}.${archivedNote(accepted)}`,
    opens: made?.path ?? null,
    undoable: true,
    // Left in the Inbox, the proposal is a warning, though the accept itself can be taken back.
    failed: accepted.archiveProblem !== null,
  };
}

/** What an answer leaves to say, and the accept it can undo, when it was one. */
interface Answered {
  readonly notice: ProposalNotice;
  /** What the toast's Undo takes back: none, one, or a batch (#168). */
  readonly accepted: readonly AcceptedProposal[];
  /** The rejects that went with those accepts (a choice's other values): reopened once the accepts are undone. */
  readonly rejected?: readonly RejectedProposal[];
}

/**
 * The Activity log of the vault open now, kept for a write that may begin
 * later (#166): an answer queued behind others is recorded where it was
 * given, not in whatever vault is open by the time it is written.
 */
function logOfVaultOpenNow(
  activity: Pick<ActivityLog, 'inOpenVault'>,
): Pick<ActivityLog, 'inOpenVault'> {
  const recorder = activity.inOpenVault();
  return { inOpenVault: () => recorder };
}

/**
 * The proposals waiting in the Inbox, and the answers to them (P29-02). The
 * rules are the use-cases'; this holds what is on screen — the list, why an
 * answer was refused, and the last accept, for its Undo.
 *
 * An answer takes its proposal off the list at once and is written in the
 * background, after any still being written (#166), so the next card can be
 * answered straight away. One that fails puts its card back with why. The
 * proposals are read again once the answers are all written — not once for
 * each — and a read begun while any was being written is not shown, since it
 * may still list one as open. Several chosen together are answered in turn,
 * each as it would be alone, and one Undo takes back every accept (#168).
 */
export function useProposals(options: ProposalsOptions) {
  const { ports, clock, indexKey, onSettled, activity, closing, toasts, onOpen } = options;
  const [listing, setListing] = useState<ProposalsContents | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [undoing, setUndoing] = useState(false);
  // Answered here: the emptied section stays, to say there is nothing left (it was the bar's to hold up).
  const [answeredHere, setAnsweredHere] = useState(false);
  const [problems, setProblems] = useState<ReadonlyMap<VaultPath, string>>(new Map());
  const [own] = useState(createProposalWrites);
  const held = options.held ?? own;
  const { queue } = held;
  const reads = useStore(held.store, (state) => state.drained);
  const { notice, say } = useStayingNotice(held);
  const answered = useAnsweredPaths(held);
  const choosing = useRowSelection('');
  // What the queue does as it drains, as the tab drawing now would: the latest `onSettled`.
  useEffect(() => {
    held.held.onDrained = onSettled;
  }, [held, onSettled]);
  useAnswersWrittenBeforeClose(queue, closing);

  // What the page says about answers belongs to the vault they were given in:
  // another vault (its own files) gets none of it — above all not Undo, which
  // would run one vault's paths against another's — nor its list, nor why
  // that could not be read.
  const { fs } = ports;
  const openVault = useRef(fs);
  const { forget } = answered;
  const { clear: clearChosen, afterBatch } = choosing;
  useEffect(() => {
    openVault.current = fs;
    return () => {
      say(null);
      setAnsweredHere(false);
      setProblems(new Map());
      setListing(null);
      setError(null);
      forget();
      clearChosen();
    };
  }, [fs, forget, say, clearChosen]);

  useEffect(() => {
    let cancelled = false;
    // Only this vault's answers can leave a read of it behind; another's still being written cannot.
    const begun = queue.mark(ports.fs);
    listProposals(ports)
      .then((read) => {
        if (cancelled || !queue.quietSince(ports.fs, begun)) return;
        setListing(contentsOf(read));
        setError(null);
        forget();
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(messageOf(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [ports, indexKey, reads, queue, forget]);

  /**
   * Takes back the answer a toast offers to undo — that one, never
   * another's. Queued (#166), it may finish after a later answer has said
   * its own toast: that toast and its Undo stand, since the outcome takes
   * no slot. Pressed once another vault has opened, it writes nothing.
   */
  const undoAnswer = useCallback(
    (
      madeIn: typeof fs,
      accepted: readonly AcceptedProposal[],
      rejected: readonly RejectedProposal[],
    ) => {
      if (accepted.length === 0 || madeIn !== openVault.current) return;
      setUndoing(true);
      // Last accepted, first taken back, each checked on its own: one changed since stays, and says why.
      const undoOne = (one: AcceptedProposal) => undoAcceptedProposal({ ports, accepted: one });
      const undoReject = (one: RejectedProposal) => undoRejectedProposal({ ports, rejected: one });
      queue.enqueue(madeIn, async () => {
        const undone = await inTurn([...accepted].reverse(), undoOne);
        // The other values come back only with the accept: while it stands, they would be a second answer.
        const reopened =
          undone.failed.length > 0 ? null : await inTurn(rejected, (one) => undoReject(one));
        const outcome = withReopened(undoneNotice(accepted, undone), reopened);
        setUndoing(false);
        if (madeIn !== openVault.current) return;
        // Said where the person is, whether or not they are still on the Inbox: a
        // refusal as a warning toast, which the toasts keep in Activity, once.
        toastProposal({ toasts, notice: outcome, onOpen });
      });
    },
    [ports, queue, toasts, onOpen],
  );

  /** Says what an answer did: in a toast with its Undo, or on the page when it failed with nothing to undo. */
  const tell = useCallback(
    ({ notice: told, accepted, rejected = [] }: Answered) => {
      if (staysOnPage(told)) {
        say(told.text);
        return;
      }
      const madeIn = openVault.current;
      toastProposal({
        toasts,
        notice: told,
        onOpen,
        onUndo: () => undoAnswer(madeIn, accepted, rejected),
        slot: PROPOSALS_TOAST,
      });
    },
    [say, toasts, onOpen, undoAnswer],
  );

  const answer = useCallback(
    (path: VaultPath, run: () => Promise<Answered>) => {
      if (!answered.take(path)) return;
      setAnsweredHere(true);
      setProblems((was) => without(was, path));
      const vault = fs;
      const named = {
        activity: logOfVaultOpenNow(activity),
        write: 'proposal',
        path,
        refusal: ANSWER_REFUSALS,
      } as const;
      queue.enqueue(vault, async () => {
        try {
          const done = await withGiveUpRecorded(named, run);
          if (vault !== openVault.current) return;
          // Answered, it is chosen no more: back on the list after an Undo, it comes back unticked.
          afterBatch({ answered: [path], failed: [] });
          tell(done);
        } catch (cause) {
          if (vault !== openVault.current) return;
          answered.giveBack(path);
          setProblems((was) => new Map(was).set(path, messageOf(cause)));
        }
      });
    },
    [activity, afterBatch, answered, fs, queue, tell],
  );

  const onAccept = useCallback(
    (path: VaultPath, payload?: unknown) =>
      answer(path, async () => {
        const accepted = await acceptProposalNote({
          via: 'app',
          ports,
          path,
          today: clock.today(),
          ...(payload !== undefined && { payload }),
        });
        return { notice: acceptedNotice(accepted), accepted: [accepted] };
      }),
    [answer, ports, clock],
  );

  const onReject = useCallback(
    (path: VaultPath) =>
      answer(path, async () => {
        const rejected = await rejectProposalNote({
          via: 'app',
          ports,
          path,
          today: clock.today(),
        });
        return { notice: rejectedNotice(path, rejected), accepted: [] };
      }),
    [answer, ports, clock],
  );

  /**
   * Answers each of `paths` in turn, as Accept or Reject would each alone
   * (#168): those that fail come back to the list, still chosen, with why on
   * their cards; the notice counts both, and its Undo takes back every accept.
   * What the person chose while the batch was written stays chosen.
   */
  const answerMany = useCallback(
    (paths: readonly VaultPath[], verb: 'Accepted' | 'Rejected') => {
      const taken = paths.filter((path) => answered.take(path));
      if (taken.length === 0) return;
      setAnsweredHere(true);
      setProblems((was) => taken.reduce(without, was));
      const vault = fs;
      const today = clock.today();
      const log = logOfVaultOpenNow(activity);
      const recorded = <Done>(path: VaultPath, write: () => Promise<Done>) =>
        withGiveUpRecorded(
          { activity: log, write: 'proposal', path, refusal: ANSWER_REFUSALS } as const,
          write,
        );
      const settle = (
        outcome: InTurn<VaultPath, ProposalArchived>,
        accepted: readonly AcceptedProposal[],
      ) => {
        if (vault !== openVault.current) return;
        for (const { item } of outcome.failed) answered.giveBack(item);
        setProblems((was) => {
          const next = new Map(was);
          for (const { item, reason } of outcome.failed) next.set(item, reason);
          return next;
        });
        const failed = outcome.failed.map(({ item }) => item);
        afterBatch({ answered: taken.filter((path) => !failed.includes(path)), failed });
        tell({ notice: answeredNotice(verb, outcome), accepted });
      };
      queue.enqueue(vault, async () => {
        if (verb === 'Accepted') {
          const outcome = await inTurn(taken, (path) =>
            recorded(path, () => acceptProposalNote({ via: 'app', ports, path, today })),
          );
          settle(outcome, outcome.done);
        } else {
          const outcome = await inTurn(taken, (path) =>
            recorded(path, () => rejectProposalNote({ via: 'app', ports, path, today })),
          );
          settle(outcome, []);
        }
      });
    },
    [activity, answered, afterBatch, clock, fs, ports, queue, tell],
  );
  /**
   * Accepts the proposal picked and, only once that has been written, rejects
   * `rest` — the other values of its question and the copies of the one
   * picked. An accept that is refused rejects nothing: the question stands
   * as it was. One notice says the whole choice, and its Undo takes the
   * accept back and then opens the rejects again.
   */
  const onAcceptChoice = useCallback(
    (picked: VaultPath, rest: readonly VaultPath[]) => {
      if (!answered.take(picked)) return;
      setAnsweredHere(true);
      const others = rest.filter((path) => answered.take(path));
      const everyone = [picked, ...others];
      setProblems((was) => everyone.reduce(without, was));
      const vault = fs;
      const today = clock.today();
      const log = logOfVaultOpenNow(activity);
      const recorded = <Done>(path: VaultPath, write: () => Promise<Done>) =>
        withGiveUpRecorded(
          { activity: log, write: 'proposal', path, refusal: ANSWER_REFUSALS } as const,
          write,
        );
      queue.enqueue(vault, async () => {
        let accepted: AcceptedProposal;
        try {
          accepted = await recorded(picked, () =>
            acceptProposalNote({ via: 'app', ports, path: picked, today }),
          );
        } catch (cause) {
          if (vault !== openVault.current) return;
          for (const path of everyone) answered.giveBack(path);
          setProblems((was) => new Map(was).set(picked, messageOf(cause)));
          return;
        }
        const rejects = await inTurn(others, (path) =>
          recorded(path, () => rejectProposalNote({ via: 'app', ports, path, today })),
        );
        if (vault !== openVault.current) return;
        const failed = rejects.failed.map(({ item }) => item);
        for (const path of failed) answered.giveBack(path);
        setProblems((was) => {
          const next = new Map(was);
          for (const { item, reason } of rejects.failed) next.set(item, reason);
          return next;
        });
        afterBatch({ answered: [picked, ...others.filter((p) => !failed.includes(p))], failed });
        tell({
          notice: choiceNotice(accepted, rejects),
          accepted: [accepted],
          rejected: rejects.done,
        });
      });
    },
    [activity, afterBatch, answered, clock, fs, ports, queue, tell],
  );
  const onAcceptMany = useCallback(
    (paths: readonly VaultPath[]) => answerMany(paths, 'Accepted'),
    [answerMany],
  );
  const onRejectMany = useCallback(
    (paths: readonly VaultPath[]) => answerMany(paths, 'Rejected'),
    [answerMany],
  );

  const onDismissNotice = useCallback(() => say(null), [say]);

  const contents = useMemo(
    () => withoutAnswered(listing, answered.paths),
    [listing, answered.paths],
  );
  const busy = undoing ? 'undo' : null;
  const answering = answered.paths.size > 0;
  const selection = useShownSelection(choosing.selection, contents);
  const section = useMemo<ProposalsSectionState>(
    () => ({
      contents,
      error,
      notice,
      busy,
      problems,
      answering,
      answered: answeredHere,
      onAccept,
      onReject,
      selection,
      onClearSelection: clearChosen,
      onAcceptChoice,
      onAcceptMany,
      onRejectMany,
      onDismissNotice,
    }),
    [
      contents,
      error,
      notice,
      busy,
      problems,
      answering,
      answeredHere,
      onAccept,
      onReject,
      selection,
      clearChosen,
      onAcceptChoice,
      onAcceptMany,
      onRejectMany,
      onDismissNotice,
    ],
  );
  return {
    section,
    count: contents?.open.length ?? null,
    /** Settles once every answer given so far is written, or has failed. */
    written: queue.drained,
  };
}

/**
 * The failure the section says until it is dismissed, held by the window
 * (tab-model.md, PR B) so every Inbox tab says it.
 */
function useStayingNotice(held: ProposalWrites) {
  const notice = useStore(held.store, (state) => state.notice);
  const say = useCallback((next: string | null) => held.store.setState({ notice: next }), [held]);
  return { notice, say };
}

/**
 * The proposals answered since the list was last read: taken off it at once,
 * and given back should the answer fail. `take` is false for one already
 * being answered — two presses in one tick, before either has drawn.
 */
function useAnsweredPaths(held: ProposalWrites) {
  const paths = useStore(held.store, (state) => state.answered);
  const now = () => held.store.getState().answered;
  const set = useCallback(
    (next: ReadonlySet<VaultPath>) => held.store.setState({ answered: next }),
    [held],
  );
  const take = useCallback(
    (path: VaultPath) => {
      if (now().has(path)) return false;
      set(new Set(now()).add(path));
      return true;
    },
    [set],
  );
  const giveBack = useCallback(
    (path: VaultPath) => set(new Set([...now()].filter((kept) => kept !== path))),
    [set],
  );
  const forget = useCallback(() => {
    if (now().size > 0) set(new Set());
  }, [set]);
  return useMemo(() => ({ paths, take, giveBack, forget }), [paths, take, giveBack, forget]);
}

/** The choice as far as it reaches proposals still open on the list: an answered one is chosen no more. */
function useShownSelection(
  selection: RowSelection,
  contents: ProposalsContents | null,
): RowSelection {
  return useMemo(() => {
    const open = new Set<string>(contents?.open.map((proposal) => proposal.path) ?? []);
    const selected = new Set([...selection.selected].filter((path) => open.has(path)));
    return { ...selection, selected };
  }, [selection, contents]);
}

function contentsOf(read: ProposalListing): ProposalsContents {
  return {
    open: read.open.map((listed) => listed.proposal),
    reasons: new Map(read.open.map((listed) => [listed.proposal.path, listed.reason])),
    stranded: read.stranded.map((listed) => listed.proposal),
    unreadable: read.unreadable,
    manyValued: read.manyValued,
  };
}

/** The list as last read, less the proposals answered since. */
function withoutAnswered(
  listing: ProposalsContents | null,
  answered: ReadonlySet<VaultPath>,
): ProposalsContents | null {
  if (listing === null || answered.size === 0) return listing;
  return { ...listing, open: listing.open.filter((proposal) => !answered.has(proposal.path)) };
}

function rejectedNotice(path: VaultPath, rejected: ProposalArchived): ProposalNotice {
  return {
    text: `Rejected: ${noteTitle(path)}.${archivedNote(rejected)}`,
    opens: null,
    undoable: false,
    // Left in the Inbox, it has nothing to undo and must be read: it stays until dismissed.
    failed: rejected.archiveProblem !== null,
  };
}

/** What a choice says: the accept, and what became of the other values. */
function choiceNotice(
  accepted: AcceptedProposal,
  rejects: InTurn<VaultPath, RejectedProposal>,
): ProposalNotice {
  const base = acceptedNotice(accepted);
  const count = rejects.done.length;
  const rejected =
    count === 0 ? '' : ` Rejected ${count} other ${count === 1 ? 'proposal' : 'proposals'}.`;
  const left = rejects.failed.length;
  const notRejected =
    left === 0
      ? ''
      : ` ${left} could not be rejected: ${left === 1 ? 'its card says' : 'their cards say'} why.`;
  return {
    ...base,
    text: `${base.text}${rejected}${notRejected}`,
    failed: left > 0 || base.failed,
  };
}

/** The undo's notice, with the other values it opened again said beside it. */
function withReopened(
  undone: ProposalNotice,
  reopened: InTurn<RejectedProposal, unknown> | null,
): ProposalNotice {
  if (reopened === null || (reopened.done.length === 0 && reopened.failed.length === 0))
    return undone;
  const back =
    reopened.done.length === 0
      ? ''
      : ` ${reopened.done.length} other ${reopened.done.length === 1 ? 'proposal is' : 'proposals are'} open again.`;
  const [refused] = reopened.failed;
  const not = refused === undefined ? '' : ` ${refused.reason}`;
  return {
    ...undone,
    text: `${undone.text}${back}${not}`,
    failed: undone.failed || refused !== undefined,
  };
}

function without(problems: ReadonlyMap<VaultPath, string>, path: VaultPath) {
  if (!problems.has(path)) return problems;
  const next = new Map(problems);
  next.delete(path);
  return next;
}
