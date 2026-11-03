/**
 * Signing out of the web build (#667): the session ends, then everything
 * this device kept of the vault is forgotten — the read cache, the index's
 * file — so the next person on the iPad finds nothing of it. Each is
 * forgotten even when another fails or the sign-out itself does (the
 * device is being let go of either way); what failed is then thrown. Saves
 * still waiting to reach GitHub are only forgotten once the person agrees:
 * by default nothing is signed out while any wait.
 */
export async function signOutAndForget({
  signOut,
  forget,
  unsent = async () => 0,
  confirmLosing = async () => false,
}: {
  signOut: () => Promise<void>;
  /** What the device kept, each forgotten in its own step. */
  forget: readonly (() => Promise<void>)[];
  /** How many saves wait on the device, not yet on GitHub (#667). */
  unsent?: () => Promise<number>;
  /** Asks the person whether to sign out anyway, losing `count` saves; no means stay signed in. */
  confirmLosing?: (count: number) => Promise<boolean>;
}): Promise<'signed-out' | 'kept'> {
  // Saves not on GitHub are lost with the device's copy: never without the person saying so.
  const waiting = await unsent();
  if (waiting > 0 && !(await confirmLosing(waiting))) return 'kept';
  const settled = await Promise.allSettled([signOut()]);
  settled.push(...(await Promise.allSettled(forget.map((step) => step()))));
  const failures = settled.flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : [],
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'signing out left something behind');
  return 'signed-out';
}
