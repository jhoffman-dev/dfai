import {
  openVault,
  VaultSession,
  type Clock,
  type NoteStore,
  type SettingsStore,
} from '../application/index.ts';
import { MemorySettingsStore } from '../application/testing/index.ts';
import { sampleNoteStore } from '../adapters/memory/index.ts';
import { createMiniSearchEngine } from '../adapters/search/index.ts';
import type { AppServices } from '../ui/services.ts';
import type { SyncControls } from '../ui/sync/sync-status.ts';
import { feedSearch } from './search-feed.ts';

/** The device-side adapters: where notes and settings are kept, and the time. */
export interface DeviceAdapters {
  readonly noteStore: NoteStore;
  readonly settings: SettingsStore;
  readonly clock: Clock;
  /** Null until a repository is connected and the sync scheduler is wired. */
  readonly sync: SyncControls | null;
}

const systemTime: Clock = { now: () => new Date() };

/** The fictional sample vault, in memory: what `pnpm dev` and the e2e smoke run on. */
export function sampleAdapters(): DeviceAdapters {
  return {
    noteStore: sampleNoteStore(),
    settings: new MemorySettingsStore(),
    clock: systemTime,
    sync: null,
  };
}

/**
 * The one place the real adapters plug in. Today every device runs on the
 * sample vault. When they land: `createLocalSettingsStore()` for settings,
 * then `openIdbNoteStore()` for notes, `systemClock` for the clock, and,
 * when `settings.load().repo` and a token are set, `createGitHubRemote` +
 * `createSyncNow` + `createSyncScheduler` adapted to `SyncControls`.
 */
export async function deviceAdapters(): Promise<DeviceAdapters> {
  return sampleAdapters();
}

/** Builds the services and opens the vault (no network), with search fed from the session. */
export async function composeApp(adapters: DeviceAdapters): Promise<AppServices> {
  const session = new VaultSession();
  const search = createMiniSearchEngine();
  feedSearch(session, search);
  await openVault({ store: adapters.noteStore, session });
  return { ...adapters, session, search };
}
