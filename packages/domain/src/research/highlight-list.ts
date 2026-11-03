import { HIGHLIGHT_COLORS, type HighlightColor } from '../highlights/anchor.ts';
import type { PillHue } from '../page/pill-colour.ts';
import type { VaultPath } from '../vault/vault-path.ts';
import type { LibraryEntry } from './library.ts';
import { byName, usesTag, withParentTags, type ResearchChoice } from './research-text.ts';

/** One highlight (ADR-0043) as All highlights lists it (#507). */
export interface HighlightEntry {
  /** The literature note it is in. */
  readonly path: VaultPath;
  /** That note's title. */
  readonly source: string;
  /**
   * When that note last changed: a highlight keeps no day of its own
   * (ADR-0043). Null when the index cannot date it (ADR-0053).
   */
  readonly modified: number | null;
  /** Its place among its note's highlights, from 0: what tells it from another with the same id. */
  readonly index: number;
  /** Its block id, `^id`, which a link or an embed names it by. */
  readonly id: string;
  /** `pdf`, `epub` or `kindle` as the marker says it. */
  readonly kind: string;
  /** The start of its quote's words. */
  readonly quote: string;
  /** The start of its comment's markdown; empty for none. */
  readonly comment: string;
  readonly mark: string;
  readonly color: string;
  readonly page: number | null;
  readonly location: number | null;
  /** Its note's tags, by key. */
  readonly tags: readonly string[];
}

/** A literature note in use, with the highlights it holds in the order it holds them. */
export interface SourceHighlights {
  readonly source: LibraryEntry;
  readonly highlights: readonly HighlightEntry[];
}

/** Paths in the index's order: by code unit, as SQLite's `ORDER BY path` sorts them. */
const inPathOrder = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/** A time the note never had (NaN), or one the index cannot tell, is the epoch: the order stays a total one. */
const timeOf = ({ modified }: LibraryEntry) =>
  modified !== null && Number.isFinite(modified) ? modified : 0;

/**
 * `groups` as All highlights lists them: the most recently changed sources
 * first, then by path. Each source's highlights stay in the order it holds
 * them. Sorting the sources, not the highlights, is what keeps 150,000
 * highlights from costing 150,000 comparisons.
 */
export function inDisplayOrder(groups: Iterable<SourceHighlights>): SourceHighlights[] {
  return [...groups].sort(
    (left, right) =>
      timeOf(right.source) - timeOf(left.source) ||
      inPathOrder(left.source.path, right.source.path),
  );
}

/** Every highlight of `groups`, in their order. */
export function flattenHighlights(groups: readonly SourceHighlights[]): HighlightEntry[] {
  return groups.flatMap((group) => group.highlights);
}

/** Whether a highlight's comment is asked for: either way, only with one, or only without. */
export type CommentFilter = 'any' | 'with' | 'without';

/** How recently a highlight's note changed: the only day a highlight can be told by. */
export type ChangedWithin = 'any' | 'week' | 'month' | 'year';

export interface HighlightFilter {
  /** One source by its note, or every one. */
  readonly source: VaultPath | null;
  /** Any of these colours (as {@link highlightColor} reads it); every colour when empty. */
  readonly colors: readonly HighlightColor[];
  readonly tag: string | null;
  readonly comment: CommentFilter;
  readonly changed: ChangedWithin;
}

export const NO_HIGHLIGHT_FILTER: HighlightFilter = {
  source: null,
  colors: [],
  tag: null,
  comment: 'any',
  changed: 'any',
};

const DAY_MS = 86_400_000;

/** How far back each choice of {@link ChangedWithin} reaches. */
export const CHANGED_WITHIN_MS: Readonly<Record<Exclude<ChangedWithin, 'any'>, number>> = {
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
  year: 365 * DAY_MS,
};

/** A highlight's colour as it is drawn: one this build does not know is yellow (ADR-0043 §3). */
export function highlightColor(color: string): HighlightColor {
  return HIGHLIGHT_COLORS.find((known) => known === color) ?? 'yellow';
}

/** Each colour's muted pastel: the same-named hue, so a yellow highlight reads yellow. */
export const HIGHLIGHT_HUES: Readonly<Record<HighlightColor, PillHue>> = {
  yellow: 'yellow',
  green: 'green',
  blue: 'blue',
  pink: 'pink',
  purple: 'purple',
  orange: 'orange',
};

/** Whether a highlight has a comment: one of only spaces is none. */
export function hasComment(entry: Pick<HighlightEntry, 'comment'>): boolean {
  return entry.comment.trim() !== '';
}

/**
 * The highlights `filter` lets through, in the order given. "Changed within"
 * counts back from `now`, the clock's, and keeps a note changed in the future
 * (another Mac's clock ahead of this one) rather than hiding it.
 */
export function filterHighlights(
  entries: readonly HighlightEntry[],
  filter: HighlightFilter,
  now: number,
): HighlightEntry[] {
  const since = filter.changed === 'any' ? null : now - CHANGED_WITHIN_MS[filter.changed];
  return entries.filter(
    (entry) =>
      (filter.source === null || entry.path === filter.source) &&
      (filter.colors.length === 0 || filter.colors.includes(highlightColor(entry.color))) &&
      (filter.tag === null || usesTag(entry.tags, filter.tag)) &&
      (filter.comment === 'any' || hasComment(entry) === (filter.comment === 'with')) &&
      // A note that cannot be dated was never changed since anything (ADR-0053).
      (since === null || (entry.modified !== null && entry.modified >= since)),
  );
}

/**
 * Where a highlight is in its source, as a row says it: a PDF's or a
 * Kindle book's page, a Kindle location, or nothing — an EPUB's place is a
 * CFI, which means nothing read.
 */
export function highlightPlace(entry: Pick<HighlightEntry, 'page' | 'location'>): string | null {
  if (entry.location !== null) return `Location ${entry.location}`;
  if (entry.page !== null) return `Page ${entry.page}`;
  return null;
}

/** The embed a highlight is pulled into another note with: `![[Source#^id]]` (ADR-0022). */
export function highlightEmbed({ target, id }: { target: string; id: string }): string {
  return `![[${target}#^${id}]]`;
}

/** What All highlights' filters offer: each source, colour and tag its highlights have, with how many. */
export interface HighlightChoices {
  readonly sources: readonly ResearchChoice<VaultPath>[];
  readonly colors: readonly ResearchChoice<HighlightColor>[];
  readonly tags: readonly ResearchChoice<string>[];
}

/**
 * The choices All highlights' filters offer; sources and tags by name, colours
 * in their own order. One pass over the highlights, and each source's tags
 * (shared by its highlights) are widened to their parents once, not once per
 * highlight.
 */
export function highlightChoices(entries: readonly HighlightEntry[]): HighlightChoices {
  const titles = new Map<VaultPath, string>();
  const sources = new Map<VaultPath, number>();
  const colors = new Map<HighlightColor, number>();
  const tags = new Map<string, number>();
  const parents = new Map<readonly string[], readonly string[]>();
  const bump = <Key>(counts: Map<Key, number>, key: Key) =>
    counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const entry of entries) {
    if (!titles.has(entry.path)) titles.set(entry.path, entry.source);
    bump(sources, entry.path);
    bump(colors, highlightColor(entry.color));
    let widened = parents.get(entry.tags);
    if (widened === undefined) {
      widened = withParentTags(entry.tags);
      parents.set(entry.tags, widened);
    }
    for (const tag of widened) bump(tags, tag);
  }
  return {
    sources: [...sources]
      .map(([value, count]) => ({ value, label: titles.get(value) ?? value, count }))
      .sort((left, right) => byName(left.label, right.label) || byName(left.value, right.value)),
    colors: HIGHLIGHT_COLORS.flatMap((color) => {
      const count = colors.get(color);
      return count === undefined ? [] : [{ value: color, label: capitalised(color), count }];
    }),
    tags: [...tags]
      .map(([value, count]) => ({ value, label: `#${value}`, count }))
      .sort((left, right) => byName(left.value, right.value)),
  };
}

const capitalised = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** `filter` without the values `choices` no longer offer (a source deleted, a colour recoloured away): see `settleLibraryFilter`. */
export function settleHighlightFilter(
  filter: HighlightFilter,
  choices: HighlightChoices,
): HighlightFilter {
  const source =
    filter.source !== null && choices.sources.some((choice) => choice.value === filter.source)
      ? filter.source
      : null;
  const colors = filter.colors.filter((color) =>
    choices.colors.some((choice) => choice.value === color),
  );
  const tag =
    filter.tag !== null && choices.tags.some((choice) => choice.value === filter.tag)
      ? filter.tag
      : null;
  const unchanged =
    source === filter.source && colors.length === filter.colors.length && tag === filter.tag;
  return unchanged ? filter : { ...filter, source, colors, tag };
}

/** Whether any of All highlights' filters is on. */
export function isHighlightFiltered(filter: HighlightFilter): boolean {
  return (
    filter.source !== null ||
    filter.colors.length > 0 ||
    filter.tag !== null ||
    filter.comment !== 'any' ||
    filter.changed !== 'any'
  );
}
