import { notesAfterMoves, type EntryMove, type VaultPath } from '@dfai/domain';

/**
 * The vault's notes as the page's own filings have left them (#217), and
 * the moves the tree does not show yet.
 *
 * Filings are written one after another without waiting for the tree to be
 * read again between them, so the notes a filing is handed can still list
 * where an earlier one moved a note from. The moves are taken in the order
 * they were made — one that carries a note on from where an earlier one left
 * it continues that move, and a filing taken back cancels it — and each the
 * tree does not show yet — its note still at `from`, nothing at `to` — is
 * applied; one the tree shows already, or that something has since
 * overtaken, is dropped.
 */
export function notesAfterOwnMoves(
  notes: readonly VaultPath[],
  moves: readonly EntryMove[],
): { readonly notes: readonly VaultPath[]; readonly unseen: readonly EntryMove[] } {
  const present = new Set(notes);
  const unseen = inOrder(moves).filter((move) => present.has(move.from) && !present.has(move.to));
  return {
    notes: unseen.length === 0 ? notes : notesAfterMoves(unseen, notes).after,
    unseen,
  };
}

/** Where each note has gone, from where it was before the first move: a note moved back to where it was has not moved. */
function inOrder(moves: readonly EntryMove[]): readonly EntryMove[] {
  const kept: EntryMove[] = [];
  for (const move of moves) {
    const earlier = kept.findIndex((each) => each.to === move.from);
    if (earlier === -1) {
      kept.push(move);
      continue;
    }
    const from = kept[earlier]?.from ?? move.from;
    if (from === move.to) kept.splice(earlier, 1);
    else kept[earlier] = { from, to: move.to };
  }
  return kept;
}
