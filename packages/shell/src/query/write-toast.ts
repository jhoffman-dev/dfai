import { noteTitle, type WriteRecord } from '@dfai/domain';
import {
  ChangedSinceError,
  UnsavedTypingError,
  undoLastWrite,
  type UndoPanes,
  type VaultFsPort,
} from '@dfai/application';
import type { Toasts } from '../toasts/toasts.ts';
import { errorMessage } from './error-message.ts';

/** What a view's change needs to be said with its Undo, and taken back. */
export interface ViewUndo {
  readonly fs: Pick<VaultFsPort, 'readTextFile' | 'writeTextFile'>;
  readonly toasts: Pick<Toasts, 'show' | 'vaultNow'>;
  /** The panes: a note with unsaved typing is never written under, and one shown is read again. */
  readonly panes: UndoPanes;
  /** Has the view read the note again once it is back as it was. */
  readonly onUndone: () => void;
}

/** An undo refused rather than failed: the note moved on, or holds typing — a warning, not a fault. */
const REFUSED = [ChangedSinceError, UnsavedTypingError] as const;

/**
 * Says a view's change in the window's toasts (#320), with an Undo that is
 * a real write of the bytes the note held before (`undoLastWrite`): refused
 * — and said as a warning — once the note has moved on; said as an error
 * when the write back fails. Either lands in Activity with the toast. An
 * Undo pressed once another vault has opened writes nothing: the toast is
 * of the vault it was made in.
 */
export function sayWritten({
  record,
  words,
  undo,
}: {
  record: WriteRecord;
  /** What happened, in the view's words; "Changed “Title”." when there are none. */
  words?: string;
  undo: ViewUndo;
}): void {
  const { toasts, fs, panes, onUndone } = undo;
  const madeIn = toasts.vaultNow();
  toasts.show({
    message: words ?? `Changed “${noteTitle(record.path)}”.`,
    tone: 'change',
    onUndo: () => {
      if (toasts.vaultNow() !== madeIn) return;
      undoLastWrite({ fs, panes, record }).then(onUndone, (cause: unknown) =>
        toasts.show({
          message: errorMessage(cause),
          tone: REFUSED.some((refusal) => cause instanceof refusal) ? 'warning' : 'error',
        }),
      );
    },
  });
}
