/**
 * Saves made on the web with no network (#667): each waits on the device,
 * one per note, and is sent once back online, held to the version the edit
 * started from, so GitHub refuses it if the note moved meanwhile, as it
 * refuses any web write. A refused save waits too, until the person keeps
 * it as a copy or discards it: a queued save is never dropped by the queue.
 *
 * The editor is handed a provisional version for a queued save, below zero
 * where no blob version is (`versionOfBlob` is never negative), so its next
 * save is known as the same edit going on.
 */

export interface QueuedSave {
  /** The note's vault and path, which a save is queued by. */
  readonly key: string;
  readonly vault: string;
  readonly path: string;
  /** The newest text saved. */
  readonly contents: string;
  /** The version the edit started from, as GitHub had it: what the save is held to when sent. */
  readonly expectedModified: number | null;
  readonly expectedText?: string;
  /** When it was first queued, among the others: the order saves are sent in. */
  readonly order: number;
  /** The version the editor was handed for it. */
  readonly provisional: number;
  /** Why GitHub refused it once sent; null while it waits to be sent. */
  readonly refused: string | null;
}

/** A save asked for, as the vault is asked it. */
export interface SaveAsked {
  readonly vault: string;
  readonly path: string;
  readonly contents: string;
  readonly expectedModified: number | null;
  readonly expectedText?: string;
}

export type QueueDecision =
  | { readonly kind: 'queued'; readonly save: QueuedSave }
  /** The edit did not start from what is queued or on GitHub: refused as stale, as the host refuses it. */
  | { readonly kind: 'stale' };

export const queuedSaveKey = (vault: string, path: string): string => `${vault}\u0000${path}`;

export const isProvisionalVersion = (version: number | null): boolean =>
  version !== null && version < 0;

/**
 * Where a save goes in the queue. A save that carries on from the one
 * queued for its note (it names that save's provisional version) takes its
 * place, keeping the version it started from and its turn; a refused one
 * stays refused. Any other save of a note with one queued started from
 * something older, and is stale. A save naming a provisional version with
 * nothing queued is stale too: what it carried on from was discarded.
 */
export function queueSave(
  queued: QueuedSave | undefined,
  asked: SaveAsked,
  next: { order: number; provisional: number },
): QueueDecision {
  if (queued !== undefined) {
    if (asked.expectedModified !== queued.provisional) return { kind: 'stale' };
    return {
      kind: 'queued',
      save: { ...queued, contents: asked.contents, provisional: next.provisional },
    };
  }
  if (isProvisionalVersion(asked.expectedModified)) return { kind: 'stale' };
  return {
    kind: 'queued',
    save: {
      key: queuedSaveKey(asked.vault, asked.path),
      vault: asked.vault,
      path: asked.path,
      contents: asked.contents,
      expectedModified: asked.expectedModified,
      ...(asked.expectedText !== undefined && { expectedText: asked.expectedText }),
      order: next.order,
      provisional: next.provisional,
      refused: null,
    },
  };
}

/** The saves still to send, in the order they were first queued. Refused ones wait for the person. */
export function savesToSend(queued: Iterable<QueuedSave>): readonly QueuedSave[] {
  return [...queued]
    .filter((save) => save.refused === null)
    .sort((a, b) => a.order - b.order || (a.key < b.key ? -1 : 1));
}

/** The turn and provisional version the next new save takes, past every one queued. */
export function nextInQueue(queued: Iterable<QueuedSave>): { order: number; provisional: number } {
  let order = 0;
  let provisional = -1;
  for (const save of queued) {
    order = Math.max(order, save.order + 1);
    provisional = Math.min(provisional, save.provisional - 1);
  }
  return { order, provisional };
}
