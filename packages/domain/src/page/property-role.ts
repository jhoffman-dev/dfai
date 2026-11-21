/**
 * What a property is about, guessed from its key where its kind cannot say.
 *
 * A type declares `source` and `estimate` as text, but one names who a thing
 * came from and the other how long it takes — and a card or a column heading
 * reads better for knowing that. A vault names its own properties, so this can
 * only be a guess from the name, and a key it does not recognise is simply a
 * value, which is never wrong, only plain.
 */
export type PropertyRole = 'person' | 'duration';

const ROLE_WORDS: readonly (readonly [PropertyRole, readonly string[]])[] = [
  ['person', ['source', 'owner', 'assignee', 'author', 'by', 'from', 'person', 'people']],
  ['duration', ['estimate', 'effort', 'duration', 'time']],
];

export function propertyRole(key: string): PropertyRole | null {
  const word = key.trim().toLowerCase();
  return ROLE_WORDS.find(([, words]) => words.includes(word))?.[0] ?? null;
}

/** The value that means "the person using this vault", in a person property. */
export const YOU = 'you';

/** Whether a person property's value names the person using the vault. */
export function isYou(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === YOU;
}
