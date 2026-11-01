import { useCallback, useMemo, useState } from 'react';
import { createVaultPath, movedPath, type EntryMove, type ViewEdits } from '@dfai/domain';

/** Unsaved toolbar changes, by view path, held above the panes. */
export interface ViewDrafts {
  editsFor(path: string): ViewEdits;
  setEdits(path: string, edits: ViewEdits): void;
  /** Carries a view's unsaved edits along when it, or a folder holding it, moves. */
  follow(move: EntryMove): void;
  /** Drops the edits of views deleted, or in a folder deleted, so a new view there starts clean. */
  forget(paths: readonly string[]): void;
}

const NONE: ViewEdits = {};

/** The drafts, and the vault they were made in. */
interface Held {
  readonly vault: string | null;
  readonly drafts: ReadonlyMap<string, ViewEdits>;
}

/**
 * The edits made to each view and not yet saved, kept for as long as the app
 * is open — so switching to another tab and back finds a filter where it was
 * left, as Notion does. They are never written anywhere until the person saves.
 * They belong to the vault open when they were made: another vault opened
 * starts with none, even for a view at the same path.
 */
export function useViewDrafts(vault: string | null): ViewDrafts {
  const [held, setHeld] = useState<Held>({ vault, drafts: new Map() });
  const drafts = held.vault === vault ? held.drafts : null;

  const editsFor = useCallback((path: string) => drafts?.get(path) ?? NONE, [drafts]);

  const setEdits = useCallback(
    (path: string, edits: ViewEdits) => {
      setHeld((was) => {
        const next = new Map(was.vault === vault ? was.drafts : []);
        next.set(path, edits);
        return { vault, drafts: next };
      });
    },
    [vault],
  );

  const follow = useCallback(
    (move: EntryMove) => {
      setHeld((was) => {
        if (was.vault !== vault) return was;
        const next = new Map<string, ViewEdits>();
        for (const [path, edits] of was.drafts) {
          next.set(movedPath(createVaultPath(path), move) ?? path, edits);
        }
        return { vault, drafts: next };
      });
    },
    [vault],
  );

  const forget = useCallback(
    (paths: readonly string[]) => {
      const gone = (path: string) =>
        paths.some((deleted) => path === deleted || path.startsWith(`${deleted}/`));
      setHeld((was) => {
        if (was.vault !== vault || ![...was.drafts.keys()].some(gone)) return was;
        return { vault, drafts: new Map([...was.drafts].filter(([path]) => !gone(path))) };
      });
    },
    [vault],
  );

  return useMemo(
    () => ({ editsFor, setEdits, follow, forget }),
    [editsFor, setEdits, follow, forget],
  );
}
