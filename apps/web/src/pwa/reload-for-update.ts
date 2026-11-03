/**
 * Reloading into a newer build without losing a save (#668). What the panes
 * hold in their autosave is written into the queue first — the queue is on
 * disk and outlives the reload (#667). Then, under the queue's lock and
 * holding it until the page goes, the newest worker is asked to take over
 * and the page reloads under it: no tab's send starts in between, since a
 * send needs the lock. A worker that does not take over in time gives the
 * lock back, and the bar stays up for another try.
 */

/** How long the worker gets to take over before the lock is given back. */
export const TAKE_OVER_WAIT_MS = 10_000;

export async function reloadForUpdate({
  writeAutosave,
  lock,
  takeOver,
  reloadPage,
  wait,
  report,
}: {
  /** The shell's panes writing what they hold into the queue; hands back what failed. */
  writeAutosave: () => Promise<readonly unknown[]>;
  /** The save queue's lock: held for each turn of sending. */
  lock: (task: () => Promise<void>) => Promise<void>;
  /** Done once the newest worker controls the page (register.ts). */
  takeOver: () => Promise<void>;
  reloadPage: () => void;
  /** Resolves after `ms`: the page's timer, injected so the wait is the test's to settle. */
  wait: (ms: number) => Promise<void>;
  report: (error: unknown) => void;
}): Promise<'reloaded' | 'timed-out'> {
  // A pane that could not write is reported, never a reason to stay: the queue has the rest.
  for (const failed of await writeAutosave()) report(failed);
  let outcome: 'reloaded' | 'timed-out' = 'timed-out';
  await lock(async () => {
    outcome = await Promise.race([
      takeOver().then((): 'reloaded' => 'reloaded'),
      wait(TAKE_OVER_WAIT_MS).then((): 'timed-out' => 'timed-out'),
    ]);
    if (outcome === 'reloaded') reloadPage();
  });
  return outcome;
}
