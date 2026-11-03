/**
 * Signing out of the web build (#667): the session ends, then everything
 * this device kept of the vault is forgotten — the read cache, the index's
 * file — so the next person on the iPad finds nothing of it. Each is
 * forgotten even when another fails or the sign-out itself does (the
 * device is being let go of either way); what failed is then thrown.
 */
export async function signOutAndForget({
  signOut,
  forget,
}: {
  signOut: () => Promise<void>;
  /** What the device kept, each forgotten in its own step. */
  forget: readonly (() => Promise<void>)[];
}): Promise<void> {
  const settled = await Promise.allSettled([signOut()]);
  settled.push(...(await Promise.allSettled(forget.map((step) => step()))));
  const failures = settled.flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : [],
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'signing out left something behind');
}
