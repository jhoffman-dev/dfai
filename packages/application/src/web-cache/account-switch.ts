/** Another account signed in while the last one's saves still wait, and the person kept them. */
export class AccountSwitchRefusedError extends Error {
  constructor(previous: string) {
    super(
      `Saves made as ${previous} have not reached GitHub yet. Sign in as ${previous} to send them, or sign out to delete them.`,
    );
    this.name = 'AccountSwitchRefusedError';
  }
}

/**
 * Who this device's kept data belongs to, once someone signs in (#667).
 * The same account, or the first, takes it as it is. A different one opens
 * nothing until the previous account's data is forgotten — its notes, its
 * index, the vault it found — so one person's notes never reach another's
 * screen, even when the last session ended on GitHub and no sign-out ran.
 * Saves the previous account left waiting are only forgotten once the
 * person agrees; otherwise the switch is refused and nothing opens.
 */
export async function adoptAccount({
  previous,
  signedInAs,
  forgetPrevious,
  unsent = async () => 0,
  confirmLosing = async () => false,
}: {
  /** The login this device's data was kept for; null when it holds none. */
  previous: string | null;
  signedInAs: string;
  forgetPrevious: () => Promise<void>;
  unsent?: () => Promise<number>;
  confirmLosing?: (count: number) => Promise<boolean>;
}): Promise<'same' | 'switched'> {
  if (previous === null || previous === signedInAs) return 'same';
  const waiting = await unsent();
  if (waiting > 0 && !(await confirmLosing(waiting))) throw new AccountSwitchRefusedError(previous);
  await forgetPrevious();
  return 'switched';
}
