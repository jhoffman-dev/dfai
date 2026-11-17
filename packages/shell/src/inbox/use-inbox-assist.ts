import { useCallback, useMemo, useRef, useState } from 'react';
import {
  assistMoreWords,
  assistReason,
  assistStepWords,
  assistTone,
  messageWithoutPaths,
  type AssistRow,
  type InboxItem,
} from '@dfai/domain';
import {
  previewInboxAssist,
  type ArchivePorts,
  type ClaudeStepPorts,
  type Clock,
  type InboxAssistOutcome,
  type InboxAssistPorts,
} from '@dfai/application';
import type { AssistRowView, AssistView, InboxAssistProps } from '@dfai/ui';

/**
 * When Suggest asked Claude, per vault, in this window: the preview writes
 * no log, so its asks are counted here against the hourly allowance (#900).
 * They are not kept past the window; the scheduled rule's log will be.
 */
export interface AssistAsks {
  asked(vault: string): readonly number[];
  record(vault: string, at: number): void;
}

export function assistAsks(): AssistAsks {
  const byVault = new Map<string, number[]>();
  return {
    asked: (vault) => byVault.get(vault) ?? [],
    record: (vault, at) => byVault.set(vault, [...(byVault.get(vault) ?? []), at]),
  };
}

/** What Suggest needs from the window: Claude as a rule's step reaches it, and the asks it made. */
export interface InboxAssistWiring {
  readonly claude: Pick<ClaudeStepPorts, 'provider' | 'deadline'>;
  readonly asks: AssistAsks;
}

/**
 * Suggest on the Inbox (#900): pressed, it asks Claude about the items in
 * view and shows what would be done; dismissed, it is put away. Until it is
 * pressed it does nothing at all, so opening the Inbox does the work it did.
 * Null where Claude is not offered.
 */
export function useInboxAssist({
  wiring,
  ports,
  clock,
  items,
  vaultKey,
}: {
  wiring: InboxAssistWiring | null;
  ports: ArchivePorts;
  clock: Pick<Clock, 'now' | 'today' | 'localNow'>;
  /** The items in view, in the Inbox's order; null while they are read. */
  items: readonly InboxItem[] | null;
  /** The vault the Inbox is of; its asks are counted under it. */
  vaultKey: string | null;
}): InboxAssistProps | null {
  const [view, setView] = useState<AssistView | null>(null);
  // Each press, and each dismissal, is a generation: an answer for an earlier one is not shown.
  const generation = useRef(0);
  // What a press reads, as it is at the press: Suggest's button keeps one handler, so the
  // bar drawn again as rows are decided does not draw it again.
  const latest = useRef({ wiring, ports, clock, items, vaultKey });
  latest.current = { wiring, ports, clock, items, vaultKey };
  const onSuggest = useCallback(() => {
    const given = latest.current;
    if (given.wiring === null) return;
    const { asks } = given.wiring;
    const vault = given.vaultKey ?? '';
    const mine = ++generation.current;
    const show = (shown: AssistView) => {
      if (generation.current === mine) setView(shown);
    };
    setView({ kind: 'asking' });
    previewInboxAssist(assistPorts(given.wiring, given.ports, given.clock), {
      items: given.items ?? [],
      previewed: asks.asked(vault),
    }).then(
      (outcome) => {
        if (outcome.asked !== null) asks.record(vault, outcome.asked);
        show(viewOf(outcome));
      },
      (error: unknown) =>
        show({
          kind: 'not-now',
          message: `Suggest could not finish: ${messageWithoutPaths(error)} Nothing changed.`,
        }),
    );
  }, []);
  const onDismiss = useCallback(() => {
    generation.current += 1;
    setView(null);
  }, []);
  return useMemo(
    () => (wiring === null ? null : { view, onSuggest, onDismiss }),
    [wiring, view, onSuggest, onDismiss],
  );
}

function assistPorts(
  wiring: InboxAssistWiring,
  ports: ArchivePorts,
  clock: Pick<Clock, 'now' | 'today' | 'localNow'>,
): InboxAssistPorts {
  return {
    ...wiring.claude,
    clock,
    fs: ports.fs,
    markdown: ports.markdown,
    index: ports.index,
    unsaved: (path) => ports.editors.state(path) === 'dirty',
  };
}

function viewOf(outcome: InboxAssistOutcome): AssistView {
  if (outcome.kind === 'not-now') return { kind: 'not-now', message: outcome.message };
  return {
    kind: 'plan',
    summary: outcome.summary,
    rows: outcome.rows.map(rowView),
    more: assistMoreWords(outcome.notConsidered),
  };
}

function rowView(row: AssistRow): AssistRowView {
  return {
    path: row.path,
    title: row.title,
    does: assistStepWords(row.step),
    why: assistReason(row),
    tone: assistTone(row.step),
  };
}
