import { createStore, type StoreApi } from 'zustand';
import type { ToastShown } from '@dfai/ui';

/**
 * How many toasts show at once; one more lets the oldest go — an error
 * among them, which otherwise stays until dismissed: Activity keeps it.
 */
export const MAX_TOASTS = 3;

/** A toast asked for: what it says, and what it can take back. */
export interface ToastRequest extends Omit<ToastShown, 'id'> {
  /**
   * A surface's one place in the queue: a new toast for the slot takes the
   * place of the one before it, as the Today page has one last change to
   * take back, not a list of them.
   */
  readonly slot?: string;
  /** Told once when the toast goes — by its time, its ×, its Undo, or a newer one in its place. */
  readonly onGone?: () => void;
}

interface QueuedToast extends ToastShown {
  readonly slot?: string;
  readonly onGone?: () => void;
}

export interface ToastsState {
  /** Oldest first. */
  readonly toasts: readonly QueuedToast[];
  /**
   * Where they are drawn while a modal layer is up — the peek's place for
   * them, inside its focus trap, so Tab reaches their Undo (#468); null: in
   * the window, under every layer.
   */
  readonly place: HTMLElement | null;
}

/**
 * The window's toasts (#320): one queue, held outside `App` and the pages
 * (ADR-0040), so showing one draws only what draws the toasts — never the
 * row or the page whose change it tells of.
 */
export interface Toasts {
  readonly store: StoreApi<ToastsState>;
  /** Shows a toast and answers with its id. */
  show(request: ToastRequest): number;
  dismiss(id: number): void;
  /**
   * Says which vault is open. Another one opening lets every toast go, since
   * each toast's Undo belongs to the vault it was made in; nothing happens
   * when none is up, or the vault is the same.
   */
  openVault(vault: string | null): void;
  /** The vault open now, as last said: an Undo made in another writes nothing. */
  vaultNow(): string | null;
  /** Draws the toasts in `place` from now on, or back in the window for null. */
  placeIn(place: HTMLElement | null): void;
}

export function createToasts(): Toasts {
  const store = createStore<ToastsState>()(() => ({ toasts: [], place: null }));
  let shown = 0;
  let open: string | null = null;
  /** Takes the toasts `going` picks out of the queue, and tells each it has gone. */
  const letGo = (going: (toast: QueuedToast, at: number) => boolean, adding?: QueuedToast) => {
    const { toasts } = store.getState();
    const kept = toasts.filter((toast, at) => !going(toast, at));
    const gone = toasts.filter((toast, at) => going(toast, at));
    store.setState({ toasts: adding === undefined ? kept : [...kept, adding] });
    for (const toast of gone) toast.onGone?.();
  };
  return {
    store,
    show: (request) => {
      shown += 1;
      const toast: QueuedToast = { ...request, id: shown };
      const { toasts } = store.getState();
      const sameSlot = (each: QueuedToast) =>
        request.slot !== undefined && each.slot === request.slot;
      const overflow = toasts.filter((each) => !sameSlot(each)).length - (MAX_TOASTS - 1);
      const oldest = new Set(
        toasts.filter((each) => !sameSlot(each)).slice(0, Math.max(0, overflow)),
      );
      letGo((each) => sameSlot(each) || oldest.has(each), toast);
      return toast.id;
    },
    dismiss: (id) => letGo((toast) => toast.id === id),
    openVault: (vault) => {
      if (vault === open) return;
      open = vault;
      if (store.getState().toasts.length > 0) letGo(() => true);
    },
    vaultNow: () => open,
    placeIn: (place) => {
      if (store.getState().place !== place) store.setState({ place });
    },
  };
}
