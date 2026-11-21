import type { SearchEngine, VaultChange, VaultSession } from '../application/index.ts';

/**
 * Keeps the search engine in step with the session, one note at a time:
 * a save re-reads that note only. Only visible notes are indexed, as the
 * session's index decides. Returns the way to stop.
 */
export function feedSearch(session: VaultSession, search: SearchEngine): () => void {
  const reindexAll = () =>
    search.index(
      session.index.paths().map((path) => ({ path, text: session.file(path)?.text ?? '' })),
    );
  const reread = (path: string) => {
    const file = session.file(path);
    if (file !== null && session.index.has(path)) search.update(path, file.text);
    else search.remove(path);
  };
  const onChange = (change: VaultChange) => {
    switch (change.kind) {
      case 'loaded':
        reindexAll();
        return;
      case 'written':
        reread(change.path);
        return;
      case 'deleted':
        search.remove(change.path);
        return;
      case 'renamed':
        search.remove(change.from);
        reread(change.to);
        return;
    }
  };
  reindexAll();
  const stop = session.subscribe(onChange);
  return () => void stop();
}
