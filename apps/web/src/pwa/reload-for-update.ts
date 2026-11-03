/**
 * Reloading into a newer build without losing a save (#668). What the panes
 * hold in their autosave is written into the queue first — the queue is on
 * disk and outlives the reload (#667) — and the waiting worker is told to
 * take over only under the queue's lock, so no tab is mid-send when the
 * page goes. The reload itself follows the worker taking control (register.ts).
 */
export async function reloadForUpdate({
  writeAutosave,
  lock,
  takeOver,
  report,
}: {
  /** The shell's panes writing what they hold into the queue; hands back what failed. */
  writeAutosave: () => Promise<readonly unknown[]>;
  /** The save queue's lock: held for each turn of sending. */
  lock: (task: () => Promise<void>) => Promise<void>;
  /** Tells the waiting worker to take over, which reloads the page. */
  takeOver: () => void;
  report: (error: unknown) => void;
}): Promise<void> {
  // A pane that could not write is reported, never a reason to stay: the queue has the rest.
  for (const failed of await writeAutosave()) report(failed);
  await lock(async () => takeOver());
}
