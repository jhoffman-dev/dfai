import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { VaultPath } from '../../domain/vault/index.ts';
import { useApp } from '../services.ts';

/** Where focus goes when a note next opens: straight into the text, or its title to rename it. */
export interface PendingFocus {
  readonly path: VaultPath;
  readonly target: 'editor' | 'title';
}

/** How the window is arranged right now. Nothing here is a vault fact. */
export interface UiState {
  readonly paletteOpen: boolean;
  readonly settingsOpen: boolean;
  /** The sidebar, on a phone-width screen where it is a drawer. */
  readonly drawerOpen: boolean;
  /** Rendered view (true) or the editor (false). */
  readonly preview: boolean;
  readonly pendingFocus: PendingFocus | null;
  /** A short message for the person: a refused rename, a failed save. */
  readonly notice: string | null;
}

export type UiStore = StoreApi<UiState>;

export function createUiStore({ preview }: { preview: boolean }): UiStore {
  return createStore<UiState>(() => ({
    paletteOpen: false,
    settingsOpen: false,
    drawerOpen: false,
    preview,
    pendingFocus: null,
    notice: null,
  }));
}

export function useUi<T>(select: (state: UiState) => T): T {
  return useStore(useApp().ui, select);
}
