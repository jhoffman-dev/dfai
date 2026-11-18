import { useCallback, useMemo, useRef, useState } from 'react';
import {
  assistMoreWords,
  assistPeopleWords,
  assistReason,
  assistStepWords,
  assistCautionWords,
  assistTone,
  localTimeMs,
  messageWithoutPaths,
  type AssistRow,
  type InboxItem,
} from '@dfai/domain';
import {
  findUnfinishedAssist,
  previewInboxAssist,
  type AssistUnfinished,
  type ActivityLog,
  type ArchivePorts,
  type ClaudeStepPorts,
  type Clock,
  type InboxAssistOutcome,
  type InboxAssistPorts,
} from '@dfai/application';
import type { AssistRowAction, AssistRowView, AssistView, InboxAssistProps } from '@dfai/ui';
import type { AssistAsks } from './assist-asks-store.ts';
import { useAssistApply, type AssistPlanned, type InboxWrite } from './use-assist-apply.ts';

export { assistAsks, browserAssistAsks } from './assist-asks-store.ts';
export type { AssistAsks } from './assist-asks-store.ts';

/** What Suggest needs from the window: Claude as a rule's step reaches it, and the asks it made. */
export interface InboxAssistWiring {
  readonly claude: Pick<ClaudeStepPorts, 'provider' | 'deadline'>;
  readonly asks: AssistAsks;
}

/** What Suggest shows, before it is said: the preview's plan is kept whole, for Apply to re-check. */
type Shown =
  | { readonly kind: 'asking' }
  | { readonly kind: 'not-now'; readonly message: string }
  | (Extract<InboxAssistOutcome, { kind: 'plan' }> & AssistPlanned);

/**
 * Suggest on the Inbox (#900): pressed, it asks Claude about the items in
 * view and shows what would be done; dismissed, it is put away. Until it is
 * pressed it does nothing at all, so opening the Inbox does the work it did.
 * Each planned row can then be applied, and undone (#909). Null where Claude
 * is not offered.
 */
export function useInboxAssist({
  wiring,
  ports,
  clock,
  items,
  vaultKey,
  apply = null,
}: {
  wiring: InboxAssistWiring | null;
  ports: ArchivePorts;
  clock: Pick<Clock, 'now' | 'today' | 'localNow'>;
  /** The items in view, in the Inbox's order; null while they are read. */
  items: readonly InboxItem[] | null;
  /** The vault the Inbox is of; its asks are counted under it. */
  vaultKey: string | null;
  /**
   * The Inbox's own write queue, which Apply and Undo write through, and the
   * Activity log each says what it did in (#909); null where they are not offered.
   */
  apply?: { write: InboxWrite; activity: Pick<ActivityLog, 'inOpenVault'> } | null;
}): InboxAssistProps | null {
  const [shown, setView] = useState<Shown | null>(null);
  // Rows an earlier apply left unfinished (#911), read at each press: said, never repaired.
  const [unfinished, setUnfinished] = useState<readonly AssistUnfinished[]>(NO_UNFINISHED);
  // Each press, and each dismissal, is a generation: an answer for an earlier one is not shown.
  const generation = useRef(0);
  // What a press reads, as it is at the press: Suggest's button keeps one handler, so the
  // bar drawn again as rows are decided does not draw it again.
  const latest = useRef({ wiring, ports, clock, items, vaultKey });
  latest.current = { wiring, ports, clock, items, vaultKey };
  // The ask in flight, if any: Dismiss aborts it (it still counts), and a press meanwhile does nothing.
  const inFlight = useRef<AbortController | null>(null);
  const onSuggest = useCallback(() => {
    const given = latest.current;
    if (given.wiring === null || inFlight.current !== null) return;
    const controller = new AbortController();
    inFlight.current = controller;
    const mine = ++generation.current;
    const show = (next: Shown) => {
      if (inFlight.current === controller) inFlight.current = null;
      if (generation.current === mine) setView(next);
    };
    setView({ kind: 'asking' });
    findUnfinishedAssist({ fs: given.ports.fs }).then(
      (found) => generation.current === mine && setUnfinished(found),
      // A log that cannot be read says nothing left unfinished; the apply itself refuses to write without it.
      () => generation.current === mine && setUnfinished(NO_UNFINISHED),
    );
    const claim = claimAsk(given.wiring.asks, given.vaultKey ?? '', given.clock);
    previewInboxAssist(
      { ...assistPorts(given.wiring, given.ports, given.clock), recordAsk: claim.sent },
      { items: given.items ?? [], previewed: claim.before, signal: controller.signal },
    )
      .then(
        (outcome) => show(outcome),
        (error: unknown) =>
          show({
            kind: 'not-now',
            message: `Suggest could not finish: ${messageWithoutPaths(error)} Nothing changed.`,
          }),
      )
      .finally(claim.settle);
  }, []);
  const planned = shown?.kind === 'plan' ? shown : null;
  const applying = useAssistApply({ planned, apply, clock });
  const { stop } = applying;
  const onDismiss = useCallback(() => {
    generation.current += 1;
    inFlight.current?.abort();
    inFlight.current = null;
    // Apply all finishes the row it is on, and starts no other.
    stop();
    setView(null);
    setUnfinished(NO_UNFINISHED);
  }, [stop]);
  const view = useMemo(() => (shown === null ? null : viewOf(shown, applying)), [shown, applying]);
  return useMemo(
    () =>
      wiring === null
        ? null
        : { view, onSuggest, onDismiss, actions: applying.actions, unfinished },
    [wiring, view, onSuggest, onDismiss, applying.actions, unfinished],
  );
}

/**
 * An ask claimed at the press, before anything is read: kept at once, so
 * another window pressed a moment later counts it. It is taken back if no
 * ask was sent after all (nothing to ask about, the hour spent, Claude out of
 * reach); one that was sent counts however it ended.
 *
 * Two windows pressed at once with one ask left: the second reads the
 * first's claim and is refused. Where storage cannot be written (a private
 * window, a full store) each window counts its own alone, so the worst case
 * is 29 plus one per open window; accepted for a button a person presses.
 */
function claimAsk(
  asks: AssistAsks,
  vault: string,
  clock: Pick<Clock, 'now' | 'localNow'>,
): { before: readonly number[]; sent: () => void; settle: () => void } {
  const at = localTimeMs(clock.localNow()) ?? clock.now();
  const before = asks.asked(vault, at);
  asks.record(vault, at);
  let sent = false;
  return {
    before,
    sent: () => {
      sent = true;
    },
    settle: () => {
      if (!sent) asks.withdraw(vault, at);
    },
  };
}

function assistPorts(
  wiring: InboxAssistWiring,
  ports: ArchivePorts,
  clock: Pick<Clock, 'now' | 'today' | 'localNow'>,
): Omit<InboxAssistPorts, 'recordAsk'> {
  return {
    ...wiring.claude,
    clock,
    fs: ports.fs,
    markdown: ports.markdown,
    index: ports.index,
    unsaved: (path) => ports.editors.state(path) === 'dirty',
  };
}

function viewOf(shown: Shown, applying: ReturnType<typeof useAssistApply>): AssistView {
  if (shown.kind !== 'plan') return shown;
  return {
    kind: 'plan',
    summary: shown.summary,
    rows: shown.rows.map((row) => rowView(row, applying.actionOf(row))),
    more: assistMoreWords(shown.notConsidered),
    canApplyAll: applying.actions !== null && applying.canApplyAll,
    canUndoAll: applying.actions !== null && applying.canUndoAll,
    busy: applying.busy,
    said: applying.said,
  };
}

function rowView(row: AssistRow, action: AssistRowAction): AssistRowView {
  return {
    path: row.path,
    title: row.title,
    does: assistStepWords(row.step),
    why: assistReason(row),
    tone: assistTone(row.step),
    people: assistPeopleWords(row),
    action,
    caution: assistCautionWords(row),
  };
}

const NO_UNFINISHED: readonly AssistUnfinished[] = [];
