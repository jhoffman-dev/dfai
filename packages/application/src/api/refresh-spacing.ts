/** The least time between two refreshes of one source asked for through the API. */
export const API_REFRESH_SPACING_MS = 30_000;

/**
 * How often the API may refresh each source.
 *
 * A refresh fetches a feed, perhaps with the user's secret, and writes notes;
 * a local caller looping on the route would hammer the feed's site in the
 * user's name. So a source refreshed through the API waits a while before the
 * API may refresh it again. The pane's own timer and button are not spaced.
 * A pull of Granola through the API is spaced the same way, per vault, counted
 * from when the pull ends (P28-13), so one full listing never follows another.
 */
export interface RefreshSpacing {
  /** Milliseconds until `key` may be refreshed again; 0 when now, which is then recorded. */
  claim(args: { key: string; now: number }): number;
  /** Starts `key`'s wait again from `now`: what it ran for has just ended. */
  restart(args: { key: string; now: number }): void;
}

export function createRefreshSpacing(spacingMs: number = API_REFRESH_SPACING_MS): RefreshSpacing {
  const last = new Map<string, number>();
  return {
    claim({ key, now }) {
      const previous = last.get(key);
      const wait = previous === undefined ? 0 : previous + spacingMs - now;
      if (wait > 0) return wait;
      last.set(key, now);
      return 0;
    },
    restart({ key, now }) {
      last.set(key, now);
    },
  };
}
