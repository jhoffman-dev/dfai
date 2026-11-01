import { useEffect, useRef } from 'react';
import { readsTouchedByNoteChanges, type NoteChanges } from '@dfai/application';
import type { IndexStatusStore } from '../index/index-status-store.ts';
import type { ReadInvalidator } from './read-invalidator.ts';

/**
 * Keeps the window's whole-vault reads in step with the vault open: a type
 * definition a sync found changed is read again; what the index's writes
 * changed is read again when the index has news for its readers, and so is
 * each pane's read those notes touched (#325); and a vault
 * left behind has its reads dropped, so nothing of it is shown in the next.
 */
export function useVaultReads({
  reads,
  changes,
  index,
  vaultKey,
}: {
  reads: ReadInvalidator;
  /** What each sync of the index found added, changed or removed (P28-03). */
  changes: NoteChanges;
  /** Where the index says it has news: its revision moves, or it fails. */
  index: IndexStatusStore;
  vaultKey: string | null;
}): void {
  useEffect(
    () =>
      changes.subscribe((news) => {
        reads.invalidate(news.vault, readsTouchedByNoteChanges(news.changes));
        reads.noteChanges(news.vault, news.changes);
      }),
    [changes, reads],
  );

  useEffect(
    () =>
      index.subscribe((now, before) => {
        const news = now.revision !== before.revision || now.phase !== before.phase;
        const settled = now.phase === 'ready' || now.phase === 'failed';
        // Only a refresh of the vault already ready tells every note it found: a
        // build, a rebuild or a failure is news whose notes are not known.
        const known =
          now.phase === 'ready' && before.phase === 'ready' && now.vault === before.vault;
        if (news && settled && now.vault !== null) reads.indexMoved(now.vault, known);
      }),
    [index, reads],
  );

  // Dropped on the switch itself, not in a cleanup: a cleanup also runs when
  // React tries an effect twice, and would drop the open vault's reads.
  const previous = useRef(vaultKey);
  useEffect(() => {
    const left = previous.current;
    previous.current = vaultKey;
    if (left !== null && left !== vaultKey) reads.forget(left);
  }, [vaultKey, reads]);
}
