/**
 * Whether a vault's blocks sync with its Google calendar (#30). Kept in the
 * vault's settings, so both Macs agree; only the Mac that runs the vault's
 * automations does the syncing.
 */

/** `true` once the person has turned on two-way sync of blocks for this vault. */
export const GOOGLE_BLOCKS_KEY = 'google_blocks';

/** Whether the vault's settings turn block sync on; anything but `true` is off. */
export function blockSyncEnabled(settings: Readonly<Record<string, unknown>>): boolean {
  return settings[GOOGLE_BLOCKS_KEY] === true;
}
