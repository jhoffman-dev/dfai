import type { IndexPort } from '@dfai/application';
import { indexHostOver, type IndexHostCalls } from './index-channel.ts';
import { webIndexPort } from './web-index-port.ts';

/**
 * The browser's index (#666): SQLite in a worker of its own, its files in
 * OPFS, made on the first call so a page that never asks the index never
 * loads SQLite.
 */
export function webIndex({ openVault }: { openVault: () => string | null }): WebIndex {
  let host: IndexHostCalls | null = null;
  const started = () => {
    if (host !== null) return host;
    const worker = new Worker(new URL('./web-index.worker.ts', import.meta.url), {
      type: 'module',
      name: 'dfai-index',
    });
    // The calls waiting are refused by the channel; the next call starts a worker afresh.
    worker.addEventListener('error', () => {
      worker.terminate();
      host = null;
    });
    host = indexHostOver(worker);
    return host;
  };
  return {
    ...webIndexPort({ host: started, openVault }),
    forget: (vault) => started().forget(vault),
  };
}

/** The index, and how a vault's file is thrown away when the person signs out (#667). */
export type WebIndex = IndexPort & { forget(vault: string): Promise<void> };
