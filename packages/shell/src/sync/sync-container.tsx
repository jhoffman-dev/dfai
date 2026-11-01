import { memo, useLayoutEffect, type ReactNode } from 'react';
import { SyncIndicator } from '@dfai/ui';
import { useSync, type SyncController, type SyncOptions } from './use-sync.ts';
import { publishSync, useSyncBadge, useSyncController, type SyncStore } from './sync-store.ts';

/**
 * Runs the open vault's sync (U-29) outside the window (#326): its pulls,
 * its pushes and its schedule draw this, which draws nothing, and say where
 * sync stands in `store`. The window reads from there only what it acts on.
 */
export const SyncRunner = memo(function SyncRunner({
  store,
  ...options
}: SyncOptions & { store: SyncStore }) {
  const sync = useSync(options);
  // Before paint, so nothing shows a sync a step behind the runner's.
  const vault = options.vaultKey;
  useLayoutEffect(() => publishSync(store, vault, sync), [store, vault, sync]);
  useLayoutEffect(() => () => publishSync(store, null, null), [store]);
  return null;
});

/**
 * The sidebar's sync light, for a vault that syncs: drawn from the store, not
 * with the window — with `memo` and a steady `onOpen`, only when it changes.
 */
export const SyncLight = memo(function SyncLight({
  store,
  onOpen,
}: {
  store: SyncStore;
  onOpen: () => void;
}) {
  const badge = useSyncBadge(store);
  return badge === null ? null : <SyncIndicator badge={badge} onOpen={onOpen} />;
});

/**
 * Settings → Sync, once the runner has said where sync stands. The card is
 * the caller's to draw, so the window keeps it in its own later-loaded part.
 */
export function SyncSettingsSlot({
  store,
  children,
}: {
  store: SyncStore;
  children: (sync: SyncController) => ReactNode;
}) {
  const sync = useSyncController(store);
  return sync === null ? null : children(sync);
}
