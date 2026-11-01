import type { IndexOpening, IndexPort } from '@dfai/application';

/**
 * The index, opened once for the vault it was made for (#238). Every sync
 * opens the index first, and the host answered each `index_open` by opening
 * the database again: once a refresh, so once a save. Make one of these per
 * vault, so a switch opens the next vault's index afresh.
 *
 * The opening is forgotten when it fails, and when any other call through
 * this port fails — the connection may be what broke, and the next sync
 * reopens it. A rebuild needs nothing: the host reopens the index itself
 * after `clear()`, and the syncer measures from what it remembers.
 *
 * Only the first caller hears `fresh` as the host said it: by the time the
 * opening is handed out again, that sync has written the vault into the
 * index, so it no longer holds nothing.
 */
export function openOnce(index: IndexPort): IndexPort {
  let opening: Promise<IndexOpening> | null = null;
  const forgetOnFailure = <T>(call: Promise<T>): Promise<T> =>
    call.catch((cause: unknown) => {
      opening = null;
      throw cause;
    });
  const open = (): Promise<IndexOpening> => {
    if (opening !== null) return opening.then((opened) => ({ ...opened, fresh: false }));
    opening = forgetOnFailure(index.open());
    return opening;
  };
  return {
    open,
    clear: () => forgetOnFailure(index.clear()),
    manifest: () => forgetOnFailure(index.manifest()),
    put: (notes, scope) => forgetOnFailure(index.put(notes, scope)),
    remove: (paths, scope) => forgetOnFailure(index.remove(paths, scope)),
    search: (query, limit, scope) => forgetOnFailure(index.search(query, limit, scope)),
    notesOfType: (type) => forgetOnFailure(index.notesOfType(type)),
    rebuildViews: (types) => forgetOnFailure(index.rebuildViews(types)),
    query: (sql, parameters) => forgetOnFailure(index.query(sql, parameters)),
    backlinks: (path) => forgetOnFailure(index.backlinks(path)),
    stats: () => forgetOnFailure(index.stats()),
  };
}
