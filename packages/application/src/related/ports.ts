/**
 * The related notes dismissed in one vault, per note (P32-03). Kept per Mac,
 * not in the vault: a dismissal is how this screen reads a note, not
 * knowledge in it, and a file of them written on every dismissal would be one
 * more thing for sync to merge between two Macs. A note dismissed on one Mac
 * may be offered again on the other, and dismissed there with one click.
 */
export interface DismissedRelatedStore {
  /** The notes dismissed for `note`. */
  dismissed(note: string): ReadonlySet<string>;
  dismiss(note: string, related: string): void;
}
