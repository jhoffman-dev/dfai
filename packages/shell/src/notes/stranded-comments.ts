import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  isStrandedEditExpired,
  noteLabelForNotice,
  redateStrandedEdit,
  type StrandedComment,
  type StrandedComments,
  type VaultPath,
} from '@dfai/domain';
import type { KeptWorkStore } from './stranded-edits.ts';

export type StrandedCommentStore = KeptWorkStore<StrandedComments>;

/** What a closing note hands over: the comments it could not write, and the vault they were typed in. */
export interface CommentStranding {
  readonly vault: string;
  readonly path: VaultPath;
  readonly comments: readonly StrandedComment[];
  readonly reason: string;
}

export interface KeptComments {
  /** Keeps what a closing note could not write, in place of what was kept for it before. */
  readonly keep: (stranding: CommentStranding) => void;
  /**
   * The comments kept for a note of the open vault, to put back in its fields.
   * They stay kept until `settle`: put back is not written, and a quit before
   * they are must not lose them.
   */
  readonly offered: (path: VaultPath) => readonly StrandedComment[];
  /**
   * Lets go of a note's kept comments once its fields have written them: only
   * `comments`, the ones `offered` handed those fields. Comments kept since
   * never reached a field, and stay kept.
   */
  readonly settle: (args: {
    vault: string;
    path: VaultPath;
    comments: readonly StrandedComment[];
  }) => void;
  /** Throws away what was kept for a note: for a note that is gone, or comments nobody wants. */
  readonly forget: (path: VaultPath) => void;
  /** The notes with comments waiting, in the order they were kept. */
  readonly waiting: readonly VaultPath[];
  /** What to tell the person while comments are waiting: whose, why, and the words. */
  readonly notice: string | null;
}

/**
 * The notice for what is kept: the words themselves, so they are never out of
 * sight. Those the store refused (`unstored`) are said to last only while DFAI runs.
 */
export function describeKeptComments(
  kept: readonly StrandedComments[],
  unstored: ReadonlySet<VaultPath> = new Set(),
): string | null {
  if (kept.length === 0) return null;
  return kept
    .map((each) => {
      const words = each.comments.map((one) => `“${one.comment}”`).join('; ');
      const back = unstored.has(each.path)
        ? 'They could not be stored either, so they are held only until DFAI quits: open the note again before then to get them back.'
        : 'Open the note again to get them back.';
      return `Comments on highlights in ${noteLabelForNotice(each.path)} could not be saved: ${each.reason} ${back} They read: ${words}`;
    })
    .join(' ');
}

interface Shown {
  readonly kept: readonly StrandedComments[];
  readonly notice: string | null;
}

const NOTHING_SHOWN: Shown = { kept: [], notice: null };

/**
 * The comments typed in highlights (#534) that a closing note could not write
 * — a conflict, a refused write, a write that did not finish in time — kept
 * as its typing is (`useStrandedEdits`): in the store, so they outlast a quit,
 * and in memory for any vault, so a store that refuses them loses nothing
 * while DFAI runs. Offered back to the note's fields when it is opened again.
 */
export function useStrandedComments({
  store,
  vaultKey,
  now,
}: {
  store: StrandedCommentStore;
  vaultKey: string | null;
  now: () => number;
}): KeptComments {
  /** Everything kept while DFAI runs, by vault: the store's copy, or the only one. */
  const held = useRef(new Map<string, Map<VaultPath, StrandedComments>>());
  /** The notes, by vault, whose kept comments the store refused: memory is their only copy. */
  const unstored = useRef(new Map<string, Set<VaultPath>>());
  /** The vaults whose store has been read into `held`, once each while DFAI runs. */
  const readVaults = useRef(new Set<string>());
  /**
   * The vault open as of this render. Set while rendering, not after: the
   * panes drawn in the same render — the tabs restored as the vault opens —
   * ask `offered` before any effect has run.
   */
  const openVault = useRef(vaultKey);
  openVault.current = vaultKey;
  const clock = useRef(now);
  clock.current = now;
  const [shown, setShown] = useState<Shown>(NOTHING_SHOWN);

  const heldIn = useCallback((vault: string) => {
    const found = held.current.get(vault) ?? new Map<VaultPath, StrandedComments>();
    held.current.set(vault, found);
    return found;
  }, []);

  const recordStored = useCallback(
    ({ vault, path, stored }: { vault: string; path: VaultPath; stored: boolean }) => {
      const refused = unstored.current.get(vault) ?? new Set<VaultPath>();
      unstored.current.set(vault, refused);
      if (stored) refused.delete(path);
      else refused.add(path);
    },
    [],
  );

  const refresh = useCallback(() => {
    const vault = openVault.current;
    const kept = vault === null ? [] : [...heldIn(vault).values()];
    const refused = vault === null ? undefined : unstored.current.get(vault);
    const notice = describeKeptComments(kept, refused);
    // Nothing kept before or now is no news: no commit for every note that closes cleanly.
    setShown((before) =>
      before.kept.length === 0 && kept.length === 0 ? before : { kept, notice },
    );
  }, [heldIn]);

  const readStored = useCallback(
    (vault: string) => {
      const at = clock.current();
      const kept = heldIn(vault);
      for (const read of store.read(vault)) {
        const each = redateStrandedEdit({ edit: read, now: at });
        if (isStrandedEditExpired({ edit: each, now: at })) {
          store.remove({ vaultKey: vault, path: each.path });
        } else if (!kept.has(each.path)) {
          kept.set(each.path, each);
          // Stored redated, or the next start would find it in the future again.
          if (each !== read) {
            const stored = store.put({ vaultKey: vault, edit: each });
            recordStored({ vault, path: each.path, stored });
          }
        }
      }
    },
    [store, heldIn, recordStored],
  );

  // Read as the vault opens, in this render: see `openVault`.
  if (vaultKey !== null && !readVaults.current.has(vaultKey)) {
    readVaults.current.add(vaultKey);
    readStored(vaultKey);
  }

  useEffect(() => {
    refresh();
  }, [vaultKey, refresh]);

  const keep = useCallback(
    ({ vault, ...work }: CommentStranding) => {
      const edit: StrandedComments = { ...work, keptAt: clock.current() };
      // A refused put still leaves them held here, for as long as DFAI runs.
      recordStored({ vault, path: edit.path, stored: store.put({ vaultKey: vault, edit }) });
      const kept = heldIn(vault);
      kept.delete(edit.path);
      kept.set(edit.path, edit);
      refresh();
    },
    [store, heldIn, recordStored, refresh],
  );

  const offered = useCallback(
    (path: VaultPath) => {
      const vault = openVault.current;
      return vault === null ? [] : (heldIn(vault).get(path)?.comments ?? []);
    },
    [heldIn],
  );

  const letGo = useCallback(
    ({ vault, path }: { vault: string; path: VaultPath }) => {
      if (!heldIn(vault).delete(path)) return;
      store.remove({ vaultKey: vault, path });
      unstored.current.get(vault)?.delete(path);
      refresh();
    },
    [store, heldIn, refresh],
  );

  const settle = useCallback(
    ({
      vault,
      path,
      comments,
    }: {
      vault: string;
      path: VaultPath;
      comments: readonly StrandedComment[];
    }) => {
      // The very list `offered` handed the fields, or comments kept since that no field ever held.
      if (heldIn(vault).get(path)?.comments !== comments) return;
      letGo({ vault, path });
    },
    [heldIn, letGo],
  );

  const forget = useCallback(
    (path: VaultPath) => {
      if (openVault.current !== null) letGo({ vault: openVault.current, path });
    },
    [letGo],
  );

  return useMemo(
    () => ({
      keep,
      offered,
      settle,
      forget,
      waiting: shown.kept.map((each) => each.path),
      notice: shown.notice,
    }),
    [keep, offered, settle, forget, shown],
  );
}
