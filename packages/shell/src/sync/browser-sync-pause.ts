const PREFIX = 'atlas.sync-paused:';

/** Whether sync is paused, per vault, on this Mac. */
export interface SyncPauseStore {
  read(vault: string): boolean;
  write(vault: string, paused: boolean): void;
}

/**
 * The pause switch, kept in the app's own storage (A29-01): it is this Mac's,
 * not the vault's — pausing on the laptop must not pause the studio Mac, as
 * a setting in the synced settings note would.
 *
 * Every access is guarded: the accessor throws where site data is blocked.
 * Sync then simply runs, unpaused, as on a first run.
 */
export const browserSyncPause: SyncPauseStore = {
  read: (vault) => {
    try {
      return window.localStorage.getItem(`${PREFIX}${vault}`) === 'true';
    } catch {
      return false;
    }
  },
  write: (vault, paused) => {
    try {
      if (paused) window.localStorage.setItem(`${PREFIX}${vault}`, 'true');
      else window.localStorage.removeItem(`${PREFIX}${vault}`);
    } catch {
      // Safe to ignore: the switch holds for this session, as the hook keeps it too.
    }
  },
};
