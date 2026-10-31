/**
 * Whether the clock and a note may set off this vault's rules on this Mac:
 * the Mac named for its automations (U-29), and only once that is known, and
 * once the owner's name and addresses are read (#173) — a Claude step
 * decides whose a meeting's tasks are by them, so a run on a stand-in would
 * make the owner's tasks someone else's. Null while either is not known:
 * nothing runs, and what a note sets off is held until it is.
 */
export function automationsScheduled({
  automationsHere,
  macKnown,
  ownerKnown,
}: {
  /** Whether this Mac is the one named for the vault's automations. */
  automationsHere: boolean;
  /** Whether this Mac and the vault's sync settings are known yet. */
  macKnown: boolean;
  /** Whether the vault's settings have answered for the owner's name and addresses. */
  ownerKnown: boolean;
}): boolean | null {
  return macKnown && ownerKnown ? automationsHere : null;
}
