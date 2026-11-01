import { useEffect, useState } from 'react';
import type { VaultPath } from '@dfai/domain';
import { closePeek, peekNow, type OverlayStore } from '../overlay-store.ts';
import type { PaneEditors } from './open-editors.ts';

/** Peeks being left, by the window's overlay store: one way out at a time. */
const leaving = new WeakSet<OverlayStore>();

/**
 * Leaves the peek for something that must be seen: what was typed in it is
 * written first (`flush`), then the peek closes and `act` runs — opening the
 * note as a page, in a tab or a split, or another page. Asked again while a
 * write is still under way — a second ⌘↵, a step — it does nothing, so one
 * press opens one thing. With no peek up, `act` runs at once.
 */
export function leavePeek(
  overlays: OverlayStore,
  { flush, act }: { flush: () => Promise<void>; act: () => void },
): void {
  if (leaving.has(overlays)) return;
  if (peekNow(overlays) === null) {
    act();
    return;
  }
  leaving.add(overlays);
  // `flush` settles once the write landed or was refused (and said so); either way the peek goes.
  void flush()
    .then(() => {
      closePeek(overlays);
      act();
    })
    .finally(() => leaving.delete(overlays));
}

/** Whether a way out of the peek is under way: steps and edits wait for it. */
export function leavingPeek(overlays: OverlayStore): boolean {
  return leaving.has(overlays);
}

/**
 * Whether the peek may read `path`: once no pane holds it with unsaved typing.
 * A pane's typing still in its autosave delay is written first, so the peek
 * reads the file as it stands and its own saves are not refused as written
 * over (the mirror of `leavePeek`). Judged as the peek comes to the note —
 * the peek's own typing later is not a reason to wait — and ready at once
 * when nothing is unsaved.
 */
export function useHoldersFlushed(
  editors: Pick<PaneEditors, 'stateOf' | 'flushHolding'>,
  path: VaultPath,
): boolean {
  const judge = () => ({ path, ready: editors.stateOf(path) !== 'dirty' });
  const [gate, setGate] = useState(judge);
  // Judged again as the path changes, while rendering, so no frame reads the old answer.
  const current = gate.path === path ? gate : judge();
  if (current !== gate) setGate(current);
  useEffect(() => {
    if (current.ready) return;
    let live = true;
    // `flushHolding` settles once every write landed or was refused, each said where it belongs.
    void editors.flushHolding([current.path]).then(() => {
      if (live) setGate({ path: current.path, ready: true });
    });
    return () => {
      live = false;
    };
  }, [current.ready, current.path, editors]);
  return current.ready;
}
