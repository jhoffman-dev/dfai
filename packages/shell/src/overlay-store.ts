import { createStore, useStore, type StoreApi } from 'zustand';
import type { EntryMove, VaultPath } from '@dfai/domain';
import {
  NO_OVERLAY,
  drawnByWindow,
  peekAfterMove,
  peekWithout,
  withClosed,
  withOpened,
  withPeekClosed,
  withPeekOpened,
  withPeekReplaced,
  withPeekStepped,
  type Overlay,
  type OverlayState,
  type PaletteInput,
  type Peek,
} from './overlay.ts';

/**
 * The window's overlays and the search palette's input, held outside `App`
 * (ADR-0040): what draws an overlay subscribes to it, so opening ⌘K and
 * typing into it draws only the palette (#261). The rules are `overlay.ts`'s.
 */
export type OverlayStore = StoreApi<OverlayState>;

export function createOverlayStore(): OverlayStore {
  return createStore<OverlayState>()(() => NO_OVERLAY);
}

export function showOverlay(store: OverlayStore, requested: Overlay): void {
  store.setState((state) => withOpened(state, requested));
}

export function hideOverlay(store: OverlayStore, closing: Overlay): void {
  store.setState((state) => withClosed(state, closing));
}

/** What is up now, read at the moment it is needed rather than subscribed to. */
export function overlayNow(store: OverlayStore): Overlay | null {
  return store.getState().overlay;
}

/** Changes the palette's input by `change`, leaving which overlay is up alone. */
export function changePalette(
  store: OverlayStore,
  change: (input: PaletteInput) => PaletteInput,
): void {
  store.setState((state) => ({ palette: change(state.palette) }));
}

/** The overlay the window draws itself: it does not change as ⌘K opens or closes. */
export function useWindowOverlay(store: OverlayStore): Overlay | null {
  return useStore(store, drawnByWindow);
}

export function useOverlayUp(store: OverlayStore, overlay: Overlay): boolean {
  return useStore(store, (state) => state.overlay === overlay);
}

export function usePaletteInput(store: OverlayStore): PaletteInput {
  // The palette's input is replaced whole on each change, so it is its own selector.
  return useStore(store, (state) => state.palette);
}

// ---- The peek, the layer under the overlays (slice 6b) ----------------------

/** How many times each store's peek has been opened: which opening a peek that is up is. */
const peekOpenings = new WeakMap<OverlayStore, number>();

/** Opens the peek on a note, by `withPeekOpened`'s rule: never above an overlay. */
export function openPeek(store: OverlayStore, peek: Peek): void {
  const was = store.getState().peek;
  store.setState((state) => withPeekOpened(state, peek));
  if (store.getState().peek !== was) peekOpenings.set(store, peekOpening(store) + 1);
}

/**
 * Which opening of the peek this is: a peek closed and opened again on the
 * same note is another opening, so what was asked in the first is not the
 * second's (#506).
 */
export function peekOpening(store: OverlayStore): number {
  return peekOpenings.get(store) ?? 0;
}

/** Shows another note in the peek that is up: a link followed or a result picked in it. */
export function replacePeek(store: OverlayStore, path: VaultPath): void {
  store.setState((state) => withPeekReplaced(state, path));
}

/** Steps the peek to row `index`, past rows whose notes are no longer `listed`. */
export function stepPeek(
  store: OverlayStore,
  index: number,
  listed?: (path: VaultPath) => boolean,
): void {
  store.setState((state) => withPeekStepped(state, index, listed));
}

export function closePeek(store: OverlayStore): void {
  store.setState(withPeekClosed);
}

/** The peek follows a move or rename, as the tabs do. */
export function followPeekMove(store: OverlayStore, move: EntryMove): void {
  store.setState((state) => ({ peek: peekAfterMove(state.peek, move) }));
}

/** The peek closes on a deleted note, and steps past deleted rows. */
export function forgetPeeked(store: OverlayStore, gone: readonly VaultPath[]): void {
  store.setState((state) => ({ peek: peekWithout(state.peek, gone) }));
}

/** The peek as it stands, read at the moment it is needed rather than subscribed to. */
export function peekNow(store: OverlayStore): Peek | null {
  return store.getState().peek;
}

/** The peek, for what draws it: nothing else is drawn as it opens or steps. */
export function usePeek(store: OverlayStore): Peek | null {
  return useStore(store, (state) => state.peek);
}
