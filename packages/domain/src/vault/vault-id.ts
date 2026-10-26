/**
 * The vault's own id (`vault_id` in `.atlas/settings.md`): the same on every
 * Mac, since the settings travel with the vault, and different from any other
 * vault's. Made once, when something first needs it, from an injected source
 * of randomness; never rewritten after.
 */

/** The settings key the vault's id is kept under. */
export const VAULT_ID_KEY = 'vault_id';

/** Google's base32hex alphabet, so the id can sit in anything drawn from it. */
const ALPHABET = '0123456789abcdefghijklmnopqrstuv';

/** 16 characters of 32: 80 bits, plenty to tell one person's vaults apart. */
const LENGTH = 16;

/** What the settings say of the vault's id: one there, none yet, or a value that is not one. */
export type VaultIdReading =
  | { readonly kind: 'id'; readonly id: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'unreadable' };

/**
 * The id the settings hold. Any text is taken as it is written; a value that
 * is not text is unreadable, so it is never overwritten by a new id.
 */
export function vaultIdOf(settings: Readonly<Record<string, unknown>>): VaultIdReading {
  const value = settings[VAULT_ID_KEY];
  if (value === undefined || value === null) return { kind: 'none' };
  if (typeof value !== 'string') return { kind: 'unreadable' };
  const id = value.trim();
  return id === '' ? { kind: 'none' } : { kind: 'id', id };
}

/** A new vault id, one draw of `next` (a number in [0, 1)) per character. */
export function newVaultId(next: () => number): string {
  let id = '';
  for (let at = 0; at < LENGTH; at += 1) {
    const draw = Math.min(Math.max(next(), 0), 1 - Number.EPSILON);
    id += ALPHABET[Math.floor(draw * ALPHABET.length)];
  }
  return id;
}
