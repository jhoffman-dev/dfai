/**
 * The writes the Inbox and Proposals pages make in the background — a
 * clarification, an answer — as the window sees them, whatever tab the pages
 * are in (#217, #166). A page holds its queue here while it is mounted; a
 * vault switch and the window's close wait on `drained`. A page that unmounts
 * mid-write — its tab closed, or switched away from — is still waited for
 * once, for what it was writing as it went, so neither leaves a write behind.
 */
export interface PendingWrites {
  /**
   * Holds a page's writes: `written` settles once every write it has queued
   * so far is written, or has failed. The release lets the page go, keeping
   * what it was writing at that moment.
   */
  readonly hold: (written: () => Promise<void>) => () => void;
  /** Settles once every held page's writes so far are written, or have failed. */
  readonly drained: () => Promise<void>;
}

export function createPendingWrites(): PendingWrites {
  const held = new Set<() => Promise<void>>();
  return {
    hold(written) {
      held.add(written);
      return () => {
        held.delete(written);
        // Read as the page goes: the writes queued by then, and no more.
        const left = written();
        const waitOnce = () => left;
        held.add(waitOnce);
        void left.then(
          () => held.delete(waitOnce),
          () => held.delete(waitOnce),
        );
      };
    },
    drained: () => Promise.all([...held].map((written) => written())).then(() => undefined),
  };
}
