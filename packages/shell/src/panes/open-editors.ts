import { useCallback, useEffect, useMemo, useRef } from 'react';
import { movedPath, type EntryMove, type TabId, type VaultPath } from '@dfai/domain';
import type { OpenNoteState, PropertyChanges, WindowClosingPort } from '@dfai/application';

/**
 * One tab's live editor, as the rest of the app needs to reach it.
 *
 * The functions read the tab's current state when they are called rather than
 * closing over the render they were made in, so a registration survives every
 * keystroke in that tab.
 */
export interface OpenEditor {
  readonly path: VaultPath;
  /** Writes frontmatter through this editor's own save; settles when it lands. */
  readonly setProperties: (changes: PropertyChanges) => Promise<void>;
  readonly save: () => void;
  /** Writes any unsaved edits, settling once the write has landed or been refused. */
  readonly flush: () => Promise<void>;
  /** Re-reads the note from disk, discarding nothing: only called when clean. */
  readonly reload: () => void;
  readonly isDirty: () => boolean;
  /** Follows the note to where it was moved, keeping what is on screen. */
  readonly repoint: (to: VaultPath) => void;
  /** Drops the unsaved edits of a note that has been deleted. */
  readonly abandon: () => void;
}

export interface OpenEditors {
  /** `null` unregisters the tab, which is what a tab does as it goes away. */
  readonly register: (tabId: TabId, editor: OpenEditor | null) => void;
  /**
   * Writes properties through a pane that already holds the note, if one does.
   *
   * Writing the file directly instead would move it on while that pane's editor
   * still held the modification time it read, and the pane's next save would be
   * refused — from a board drag or a table edit, not only from a star. Answers
   * whether a pane took it, once its write has landed, so the caller can write
   * the file itself when no pane has the note open.
   */
  readonly setPropertiesIfOpen: (args: {
    path: VaultPath;
    values: PropertyChanges;
  }) => Promise<boolean>;
  /** Writes one tab's note now: ⌘S in the focused pane's shown tab. */
  readonly savePane: (tabId: TabId) => void;
  /**
   * Re-reads the same note in every other tab, after one tab has written it.
   *
   * The same note can be open in two tabs, and the tab that did not write is
   * left holding the modification time from before the write.
   */
  readonly reloadOthers: (args: { tabId: TabId; path: VaultPath }) => void;
}

/** What only the app that owns the panes does with them. */
export interface PaneEditors extends OpenEditors {
  /**
   * Writes every pane's unsaved edits and settles when all have landed or been
   * refused. Run before the vault is switched, while every pane's paths still
   * mean the vault it was typed in (R14-01).
   */
  readonly flushAll: () => Promise<void>;
  /** Whether any pane holds the note, and whether one holding it has unsaved edits. */
  readonly stateOf: (path: VaultPath) => OpenNoteState;
  /** Writes the unsaved edits of the panes holding these notes, as `flushAll` does for every pane. */
  readonly flushHolding: (paths: readonly VaultPath[]) => Promise<void>;
  /** Re-points every pane holding a note the move carried. */
  readonly follow: (move: EntryMove) => void;
  /** Drops the unsaved edits of every pane holding one of these notes, which are gone. */
  readonly abandon: (paths: readonly VaultPath[]) => void;
  /** Every note a pane holds unsaved typing in. */
  readonly dirtyPaths: () => readonly VaultPath[];
}

/** The tabs' editors, by tab, so one tab can reach the note another holds. */
export function useOpenEditors(): PaneEditors {
  const editors = useRef<Map<TabId, OpenEditor>>(new Map());

  const register = useCallback((tabId: TabId, editor: OpenEditor | null) => {
    if (editor === null) editors.current.delete(tabId);
    else editors.current.set(tabId, editor);
  }, []);

  const setPropertiesIfOpen = useCallback(
    async ({ path, values }: { path: VaultPath; values: PropertyChanges }) => {
      const holding = [...editors.current.values()].filter((editor) => editor.path === path);
      // A pane with unsaved edits writes them along with the properties. Through
      // a clean pane instead, the dirty one's next save would find the note
      // changed underneath and be refused.
      const writer = holding.find((editor) => editor.isDirty()) ?? holding[0];
      if (writer === undefined) return false;
      await writer.setProperties(values);
      // Any other pane holding the same note follows once that save lands,
      // through `reloadOthers`, so one write is enough here.
      return true;
    },
    [],
  );

  const savePane = useCallback((tabId: TabId) => {
    editors.current.get(tabId)?.save();
  }, []);

  const reloadOthers = useCallback(({ tabId, path }: { tabId: TabId; path: VaultPath }) => {
    for (const [id, editor] of editors.current) {
      if (id === tabId || editor.path !== path) continue;
      // A pane with unsaved edits is left alone: re-reading it would throw that
      // typing away. Its next save reports the conflict instead, which is the
      // honest outcome of editing one note in two places.
      if (!editor.isDirty()) editor.reload();
    }
  }, []);

  const flushAll = useCallback(async () => {
    await Promise.all([...editors.current.values()].map((editor) => editor.flush()));
  }, []);

  const holdingAny = useCallback((paths: readonly VaultPath[]) => {
    const wanted = new Set<string>(paths);
    return [...editors.current.values()].filter((editor) => wanted.has(editor.path));
  }, []);

  const flushHolding = useCallback(
    async (paths: readonly VaultPath[]) => {
      await Promise.all(holdingAny(paths).map((editor) => editor.flush()));
    },
    [holdingAny],
  );

  const follow = useCallback((move: EntryMove) => {
    for (const editor of editors.current.values()) {
      const to = movedPath(editor.path, move);
      if (to !== null) editor.repoint(to);
    }
  }, []);

  const abandon = useCallback(
    (paths: readonly VaultPath[]) => {
      for (const editor of holdingAny(paths)) editor.abandon();
    },
    [holdingAny],
  );

  const dirtyPaths = useCallback(
    () => [
      ...new Set(
        [...editors.current.values()]
          .filter((editor) => editor.isDirty())
          .map((editor) => editor.path),
      ),
    ],
    [],
  );

  const stateOf = useCallback((path: VaultPath): OpenNoteState => {
    const holding = [...editors.current.values()].filter((editor) => editor.path === path);
    if (holding.length === 0) return 'closed';
    return holding.some((editor) => editor.isDirty()) ? 'dirty' : 'clean';
  }, []);

  // One object for the life of the app: what it hands out reads the registry
  // when called, so nothing that holds it needs to be rebuilt when a pane changes.
  return useMemo(
    () => ({
      register,
      setPropertiesIfOpen,
      savePane,
      reloadOthers,
      flushAll,
      stateOf,
      flushHolding,
      follow,
      abandon,
      dirtyPaths,
    }),
    [
      register,
      setPropertiesIfOpen,
      savePane,
      reloadOthers,
      flushAll,
      stateOf,
      flushHolding,
      follow,
      abandon,
      dirtyPaths,
    ],
  );
}

/** The longest the window's close waits for the panes' writes: a hung disk must not keep it open. */
export const EDITORS_CLOSE_WAIT_MS = 10_000;

/** What the person is told when a sync stops waiting for the panes' writes: the panes are still open. */
export const PANES_WRITE_GAVE_UP =
  'Some open notes took more than 10 seconds to save, so DFAI went on without waiting. Their changes are still in their panes; check them before closing.';

/**
 * What the person is told when a vault switch stops waiting for the panes'
 * writes: the panes are gone, and what they could not write is kept.
 */
export const SWITCH_WRITE_GAVE_UP =
  'Some open notes took more than 10 seconds to save, so DFAI went on without waiting. Their saves carry on; whatever cannot be saved is kept, and offered back when its note is opened again.';

/**
 * Every pane's work written, waited for no longer than the window's close
 * waits: a hung write must not hold a vault switch or a sync forever (#534).
 * On giving up, `onGaveUp` is told; the panes keep their work, and their
 * writes carry on. A write that fails says so to whoever waited.
 */
export function writtenWithin({
  flushAll,
  onGaveUp,
}: {
  flushAll: () => Promise<void>;
  onGaveUp: () => void;
}): () => Promise<void> {
  return async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gaveUp = new Promise<'gave up'>((resolve) => {
      timer = setTimeout(() => resolve('gave up'), EDITORS_CLOSE_WAIT_MS);
    });
    try {
      const outcome = await Promise.race([flushAll().then(() => 'written' as const), gaveUp]);
      if (outcome === 'gave up') onGaveUp();
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Holds the window's close until every pane's work is written — its typing,
 * and the comments typed in a literature note's highlights (#534) — as
 * leaving a vault does, so what was typed just before closing is on disk.
 */
export function useEditorsWrittenBeforeClose(
  editors: Pick<PaneEditors, 'flushAll'>,
  closing: WindowClosingPort,
) {
  useEffect(() => {
    let stop: (() => void) | null = null;
    let live = true;
    void closing
      .beforeClose(() =>
        Promise.race([
          editors.flushAll(),
          new Promise<void>((resolve) => void window.setTimeout(resolve, EDITORS_CLOSE_WAIT_MS)),
        ]),
      )
      .then(
        (stopListening) => {
          if (live) stop = stopListening;
          else stopListening();
        },
        // Without the close watched, a pane's work typed just before closing may be cut short; say so.
        (cause: unknown) => console.error("The window's close cannot be watched:", cause),
      );
    return () => {
      live = false;
      stop?.();
    };
  }, [editors, closing]);
}
