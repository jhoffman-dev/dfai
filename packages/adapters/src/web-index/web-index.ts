import type { IndexPort } from '@dfai/application';
import { indexHostOver, type IndexHostCalls } from './index-channel.ts';
import { webIndexPort } from './web-index-port.ts';

/**
 * The browser's index (#666): SQLite in a worker of its own, its files in
 * OPFS, made on the first call so a page that never asks the index never
 * loads SQLite.
 */
export function webIndex({ openVault }: { openVault: () => string | null }): IndexPort {
  let host: IndexHostCalls | null = null;
  const started = () =>
    (host ??= indexHostOver(
      new Worker(new URL('./web-index.worker.ts', import.meta.url), {
        type: 'module',
        name: 'dfai-index',
      }),
    ));
  return webIndexPort({ host: started, openVault });
}
