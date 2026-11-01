import type { VaultPath } from '@dfai/domain';
import type { Toasts } from '../toasts/toasts.ts';

/** What an answer to a proposal, or an undo of one, leaves to say. */
export interface ProposalNotice {
  readonly text: string;
  /** The note an accept made or changed, to open from the toast. */
  readonly opens: VaultPath | null;
  /** Whether the answer can be taken back from the toast. */
  readonly undoable: boolean;
  /** Whether it says something failed. */
  readonly failed: boolean;
}

/** The Proposals' one place in the window's toasts: a newer answer takes the place of the one before. */
export const PROPOSALS_TOAST = 'proposals';

/**
 * A failure with nothing to take back: said on the section, where it stays
 * until it is read and dismissed, rather than in a toast that goes by itself.
 */
export const staysOnPage = (notice: ProposalNotice): boolean => notice.failed && !notice.undoable;

/**
 * Says an answer in the window's toasts (UI v2, slice 15): Open for the note
 * an accept made, and the Undo when the answer can be taken back. `slot`
 * keeps one answer's Undo up at a time; an undo's own outcome takes no slot,
 * so it never takes a later answer's Undo away.
 */
export function toastProposal({
  toasts,
  notice,
  onOpen,
  onUndo,
  slot,
}: {
  toasts: Pick<Toasts, 'show'>;
  notice: ProposalNotice;
  onOpen: (path: VaultPath) => void;
  /** Takes the answer back; left out for what has nothing to take back, an undo's own outcome. */
  onUndo?: () => void;
  slot?: string;
}): void {
  const { opens } = notice;
  // "Open", not "Open <title>": the words already name the note, and a long
  // title beside them would squeeze them to nothing in a 340px toast.
  toasts.show({
    message: notice.text,
    tone: notice.failed ? 'warning' : 'change',
    ...(notice.undoable && onUndo !== undefined && { onUndo }),
    ...(opens !== null && {
      action: { label: 'Open', onClick: () => onOpen(opens) },
    }),
    ...(slot !== undefined && { slot }),
  });
}
