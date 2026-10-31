import type { IndexNewsFeed } from './use-scoped-index-news.ts';

/** A feed of the index's news that a test tells by hand. Test support. */
export function toldNews(): { feed: IndexNewsFeed; tell: () => void } {
  const listeners = new Set<() => void>();
  return {
    feed: {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    tell: () => {
      for (const listener of [...listeners]) listener();
    },
  };
}
