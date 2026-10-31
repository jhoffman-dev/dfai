import type { Trail } from '@dfai/domain';

/**
 * The trail each tab is walking, for the session (P32-03). Held outside React
 * so stepping to a note — which opens it in the tab — keeps the walk, and a
 * tab hears only of its own trail changing.
 */
export interface TrailMemory {
  get(tab: string): Trail | null;
  set(tab: string, trail: Trail | null): void;
  subscribe(listener: () => void): () => void;
}

export function createTrailMemory(): TrailMemory {
  const trails = new Map<string, Trail>();
  const listeners = new Set<() => void>();
  return {
    get: (tab) => trails.get(tab) ?? null,
    set(tab, trail) {
      if (trail === null) trails.delete(tab);
      else trails.set(tab, trail);
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
