import type { IndexPort } from '@dfai/application';
import type { IndexHostCalls } from './index-channel.ts';

const NO_VAULT = 'no vault is open';

/**
 * The browser's index as the app asks it (#666): what `tauriIndex` is on the
 * desktop, over the index worker's host. The host is told which vault to
 * open, as the Rust host reads it from the vault it has open.
 */
export function webIndexPort({
  host,
  openVault,
}: {
  /** The worker's host, asked for on each call, so it can be started on the first. */
  host: () => IndexHostCalls;
  /** The vault open now, whose index is opened; null when none is. */
  openVault: () => string | null;
}): IndexPort {
  return {
    open() {
      const vault = openVault();
      return vault === null ? Promise.reject(new Error(NO_VAULT)) : host().open(vault);
    },
    clear: () => host().clear(),
    manifest: () => host().manifest(),
    put: (notes, scope) => host().put(scope?.vault ?? null, notes),
    remove: (paths, scope) => host().remove(scope?.vault ?? null, paths),
    search: (query, limit, scope = {}) => host().search(query, limit, scope),
    notesOfType: (type) => host().notesOfType(type),
    rebuildViews: (types) => host().rebuildViews(types),
    query: (sql, parameters) => host().query(sql, parameters),
    backlinks: (path) => host().backlinks(path),
    stats: () => host().stats(),
  };
}
