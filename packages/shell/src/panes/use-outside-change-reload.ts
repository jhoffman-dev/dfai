import { useEffect, type RefObject } from 'react';
import { digestOf, type VaultPath } from '@dfai/domain';
import type { NoteChanges, OpenNote } from '@dfai/application';

/** What of an editor the re-read reads, as it stands now. */
export interface ReloadableNote {
  readonly open: OpenNote | null;
  readonly dirty: boolean;
  readonly reload: () => void;
}

/**
 * A note changed outside — a different digest from what the editor read or
 * last wrote, so its own write's echo is not a change — is read again while
 * the editor is clean, behind another tab or shown; a dirty one keeps its
 * edits and the save's own conflict rules apply. For the whole of the tab's
 * life rather than while hidden: the news of a change made while the tab
 * waited can land just after it shows. News of another vault is not this
 * note's, whatever path it names.
 */
export function useOutsideChangeReload({
  changes,
  vault,
  path,
  live,
}: {
  changes: NoteChanges;
  vault: string | null;
  path: VaultPath | null;
  /** The editor as it stands now, read when news lands rather than when it was subscribed. */
  live: RefObject<ReloadableNote>;
}): void {
  useEffect(() => {
    if (path === null || vault === null) return;
    return changes.subscribe((news) => {
      if (news.vault !== vault) return;
      const held = live.current.open;
      if (held === null || live.current.dirty) return;
      const mine = news.changes.find(
        (change) => change.kind === 'changed' && change.path === held.path,
      );
      if (mine !== undefined && mine.digest !== digestOf(held.onDisk)) live.current.reload();
    });
  }, [changes, vault, path, live]);
}
