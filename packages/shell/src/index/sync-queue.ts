/** One ask of the index: a refresh, or a rebuild from nothing. */
export interface SyncRequest {
  readonly fromScratch: boolean;
  /**
   * A refresh the watcher asked for: it moves the index's revision only when
   * it found something. A write of the app's own asks for a loud one, which
   * moves it regardless, for readers that re-read on every write.
   */
  readonly quiet: boolean;
  /**
   * Notes another program was seen to change, read again even when their
   * time and size stand (#245). Left out when there are none.
   */
  readonly recheck?: readonly string[];
}

/** A sync the queue starts, and what it can ask of the queue while it runs. */
export interface QueuedSync {
  readonly vault: string;
  readonly request: SyncRequest;
  /** Whether nothing is queued behind this sync of the vault, and no other vault was asked for since. */
  readonly last: () => boolean;
  /** Whether no other vault was asked for since. */
  readonly current: () => boolean;
}

/** The asks of one vault: the sync running, and at most one waiting behind it. */
interface Lane {
  readonly vault: string;
  running: boolean;
  waiting: { request: SyncRequest; held: Promise<boolean>; begin: () => void } | null;
}

const merged = (a: SyncRequest, b: SyncRequest): SyncRequest => {
  const recheck = [...new Set([...(a.recheck ?? []), ...(b.recheck ?? [])])];
  return {
    fromScratch: a.fromScratch || b.fromScratch,
    quiet: a.quiet && b.quiet,
    ...(recheck.length > 0 && { recheck }),
  };
};

/**
 * At most one sync of a vault runs, and one waits behind it (#238). A sync
 * reads the whole vault as it then is, so every ask made while one runs is
 * answered by the one sync after it: the asks join it, and settle with it.
 * Ten saves during a build cost one refresh, not ten.
 *
 * Asking for another vault starts a new lane at once, beside the old one
 * rather than behind it: each vault gets its own syncer, since its ports are
 * its own. The old vault's sync sees its vault is no longer open, stops at its
 * next batch, and publishes nothing; any write it still sends names its vault,
 * which the host refuses once another vault is open (#135). What waited in
 * the old lane runs only to find the same, and settles false.
 */
export function createSyncQueue(run: (sync: QueuedSync) => Promise<boolean>): {
  ask(vault: string, request: SyncRequest): Promise<boolean>;
} {
  let lane: Lane | null = null;

  const start = (of: Lane, request: SyncRequest): Promise<boolean> => {
    of.running = true;
    const held = run({
      vault: of.vault,
      request,
      last: () => of.waiting === null && lane === of,
      current: () => lane === of,
    });
    const next = () => {
      of.running = false;
      const behind = of.waiting;
      of.waiting = null;
      behind?.begin();
    };
    void held.then(next, next);
    return held;
  };

  const queueBehind = (of: Lane, request: SyncRequest): Promise<boolean> => {
    let settleWith: (outcome: Promise<boolean>) => void = () => {};
    const held = new Promise<boolean>((resolve) => (settleWith = resolve));
    // Started with the request as it stands then: asks that joined it have merged theirs in.
    const waiting = { request, held, begin: () => settleWith(start(of, waiting.request)) };
    of.waiting = waiting;
    return held;
  };

  return {
    ask(vault, request) {
      if (lane?.vault !== vault) lane = { vault, running: false, waiting: null };
      if (!lane.running) return start(lane, request);
      if (lane.waiting !== null) {
        lane.waiting.request = merged(lane.waiting.request, request);
        return lane.waiting.held;
      }
      return queueBehind(lane, request);
    },
  };
}
