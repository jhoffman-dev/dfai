import { useSyncExternalStore } from 'react';
import type { SyncControls, SyncStatus } from './sync-status.ts';
import './sync.css';

const timeOf = (moment: Date) =>
  moment.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** The words and the pastel a status is shown in. */
export function describeSyncStatus(status: SyncStatus): { label: string; tone: string } {
  switch (status.kind) {
    case 'idle':
      return status.lastSyncedAt === null
        ? { label: 'Not synced yet', tone: 'gray' }
        : { label: `Synced ${timeOf(status.lastSyncedAt)}`, tone: 'green' };
    case 'syncing':
      return { label: 'Syncing…', tone: 'blue' };
    case 'offline':
      return { label: 'Offline', tone: 'gray' };
    case 'needs-sign-in':
      return { label: 'Needs sign-in', tone: 'red' };
    case 'conflicts':
      return {
        label: status.count === 1 ? '1 conflict' : `${status.count} conflicts`,
        tone: 'orange',
      };
  }
}

/** The sidebar footer's chip: where sync stands. Clicking it syncs now. */
export function SyncChip({ sync }: { sync: SyncControls }) {
  const status = useSyncExternalStore(sync.subscribe, sync.getStatus);
  const { label, tone } = describeSyncStatus(status);
  return (
    <button
      type="button"
      className={`sync-chip tone-${tone}`}
      aria-label={`Sync status: ${label}. Sync now`}
      disabled={status.kind === 'syncing'}
      onClick={() => sync.syncNow()}
    >
      {label}
    </button>
  );
}
