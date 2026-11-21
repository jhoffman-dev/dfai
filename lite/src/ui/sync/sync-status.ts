/**
 * Where sync stands, as the sidebar's chip shows it. The composition root
 * turns the sync scheduler's state into this; the UI only draws it.
 */
export type SyncStatus =
  | { readonly kind: 'idle'; readonly lastSyncedAt: Date | null }
  | { readonly kind: 'syncing' }
  | { readonly kind: 'offline' }
  /** The token is missing, wrong, or lacks access to the repository. */
  | { readonly kind: 'needs-sign-in' }
  | { readonly kind: 'conflicts'; readonly count: number; readonly lastSyncedAt: Date | null };

/**
 * What the UI needs from sync: the status now, a way to hear it change, and
 * a button's worth of "sync now". Null in `AppServices` until a repository
 * is connected and the scheduler is wired.
 */
export interface SyncControls {
  /** The same object until the status changes, as `useSyncExternalStore` needs. */
  getStatus(): SyncStatus;
  subscribe(listener: () => void): () => void;
  /** Starts a sync now; the status reports how it goes. */
  syncNow(): void;
}
