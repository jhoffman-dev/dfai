import type { PaletteCommand } from '@dfai/domain';

const CONNECT_KINDLE = 'connect-kindle';
const SYNC_KINDLE_NOW = 'sync-kindle-now';
const DISCONNECT_KINDLE = 'disconnect-kindle';

/** What ⌘K's Kindle commands do: the window's Kindle controller. */
export interface KindleCommands {
  readonly connect: () => void;
  readonly syncNow: () => void;
  readonly disconnect: () => void;
}

/** ⌘K's Kindle commands (#508): Connect while it is not connected, Sync now and Disconnect once it is. */
export function paletteKindleCommands(connected: boolean): PaletteCommand[] {
  const keywords = ['amazon', 'highlights'];
  if (!connected) return [{ id: CONNECT_KINDLE, label: 'Connect Kindle', keywords }];
  return [
    { id: SYNC_KINDLE_NOW, label: 'Sync Kindle now', keywords },
    { id: DISCONNECT_KINDLE, label: 'Disconnect Kindle', keywords },
  ];
}

/** Runs one; false when `id` is none of them. */
export function runPaletteKindleCommand(id: string, commands: KindleCommands): boolean {
  if (id === CONNECT_KINDLE) commands.connect();
  else if (id === SYNC_KINDLE_NOW) commands.syncNow();
  else if (id === DISCONNECT_KINDLE) commands.disconnect();
  else return false;
  return true;
}
