import { createContext, useContext } from 'react';
import type {
  Clock,
  NoteStore,
  SearchEngine,
  SettingsStore,
  VaultDeps,
  VaultSession,
} from '../application/index.ts';
import type { NoteActions } from './state/note-actions.ts';
import type { SyncControls } from './sync/sync-status.ts';
import type { UiStore } from './state/ui-store.ts';
import type { VaultStore } from './state/vault-store.ts';

/** What the composition root hands the UI: the open session and the ports it reads and writes. */
export interface AppServices {
  readonly noteStore: NoteStore;
  readonly session: VaultSession;
  readonly settings: SettingsStore;
  readonly clock: Clock;
  readonly search: SearchEngine;
  /** Null until a repository is connected and the sync scheduler is wired. */
  readonly sync: SyncControls | null;
  /** Starts again on the settings just saved: another repository is another vault. */
  readonly reconnect: () => void;
}

/** The services plus the stores the components read slices of. */
export interface AppContextValue {
  readonly services: AppServices;
  readonly deps: VaultDeps;
  readonly vault: VaultStore;
  readonly ui: UiStore;
  readonly actions: NoteActions;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (value === null) throw new Error('A component that needs the app was rendered outside <App>.');
  return value;
}
