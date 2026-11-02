import { formatPropertyDate } from '../page/property-date.ts';

/** One option a research list's filter offers: what it filters on, what it is called, and how many it would show. */
export interface ResearchChoice<Value extends string> {
  readonly value: Value;
  readonly label: string;
  readonly count: number;
}

/** A combining mark: what an accent is, once text is decomposed. */
const MARKS = /\p{M}/gu;

/**
 * Letters with no combining mark to take off, and the plain letters a person
 * types for them: "soren" for Søren, "lodz" for Łódź.
 */
const TRANSLITERATED: Readonly<Record<string, string>> = {
  ø: 'o',
  ł: 'l',
  đ: 'd',
  ð: 'd',
  ħ: 'h',
  ı: 'i',
  ŧ: 't',
  æ: 'ae',
  œ: 'oe',
  ß: 'ss',
  þ: 'th',
};

const TRANSLITERABLE = new RegExp(`[${Object.keys(TRANSLITERATED).join('')}]`, 'g');

/** Text as a filter compares it: accents off, case folded, cut into words. */
export function foldedWords(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(MARKS, '')
    .toLowerCase()
    .replace(TRANSLITERABLE, (letter) => TRANSLITERATED[letter] ?? letter)
    .split(/\s+/)
    .filter((word) => word !== '');
}

/** Whether every one of `words` (already folded) is in one of `fields`; no words match anything. */
export function matchesEvery(words: readonly string[], fields: readonly string[]): boolean {
  if (words.length === 0) return true;
  const haystack = foldedWords(fields.join(' ')).join(' ');
  return words.every((word) => haystack.includes(word));
}

const COLLATOR = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/**
 * Names in reading order: case and accents aside, numbers by value ("Part 2"
 * before "Part 10"). Two names the collator reads as one ("Resume",
 * "Résumé") are told apart by their code units, so no two differ in order by
 * the order they were read in.
 */
export function byName(left: string, right: string): number {
  return COLLATOR.compare(left, right) || (left < right ? -1 : left > right ? 1 : 0);
}

/** Whether `tags` holds `key`, or a tag nested under it: `reading/fiction` is under `reading`. */
export function usesTag(tags: readonly string[], key: string): boolean {
  const nested = `${key}/`;
  return tags.some((tag) => tag === key || tag.startsWith(nested));
}

/** `tags`, and every parent a nested tag sits under, each once: what a tag filter can offer. */
export function withParentTags(tags: readonly string[]): string[] {
  const all = new Set<string>();
  for (const tag of tags) {
    for (let cut = tag.indexOf('/'); cut > 0; cut = tag.indexOf('/', cut + 1)) {
      all.add(tag.slice(0, cut));
    }
    all.add(tag);
  }
  return [...all];
}

/** How many items hold each value `valuesOf` gives, an item counted once per value. */
export function countBy<Item, Value>(
  items: readonly Item[],
  valuesOf: (item: Item) => readonly Value[],
): Map<Value, number> {
  const counts = new Map<Value, number>();
  for (const item of items) {
    const values = valuesOf(item);
    if (values.length === 1) {
      const only = values[0] as Value;
      counts.set(only, (counts.get(only) ?? 0) + 1);
      continue;
    }
    for (const value of new Set(values)) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

/** `values` with `value` taken out when it is in, or put in at the end when it is not: a toggle of a filter's chips. */
export function withToggled<Value>(values: readonly Value[], value: Value): Value[] {
  return values.includes(value) ? values.filter((each) => each !== value) : [...values, value];
}

/**
 * The day a note last changed, as a list says it: "Tue, Sep 22, 2026". Read
 * in UTC, as every date the domain shows, so it never depends on the zone.
 * Empty when the index cannot date the note (ADR-0053): unknown, not 1970.
 */
export function changedOn(modified: number | null): string {
  if (modified === null) return '';
  const day = new Date(Number.isFinite(modified) ? modified : 0).toISOString().slice(0, 10);
  return formatPropertyDate(day) ?? day;
}
