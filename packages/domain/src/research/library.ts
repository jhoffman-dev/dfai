import { SOURCE_KINDS, type SourceKind } from '../highlights/anchor.ts';
import type { PillHue } from '../page/pill-colour.ts';
import type { VaultPath } from '../vault/vault-path.ts';
import {
  byName,
  countBy,
  foldedWords,
  matchesEvery,
  usesTag,
  withParentTags,
  type ResearchChoice,
} from './research-text.ts';

/** A project a source is filed under: the note its link resolves to, or none, and what it is called. */
export interface LibraryProject {
  readonly path: VaultPath | null;
  readonly name: string;
}

/** One literature note (ADR-0043) as the Library lists it (#507). */
export interface LibraryEntry {
  readonly path: VaultPath;
  readonly title: string;
  readonly author: string | null;
  /** Null for a kind this build does not know, which is still listed. */
  readonly kind: SourceKind | null;
  readonly highlights: number;
  /**
   * When the note last changed: the latest a highlight was taken or a comment
   * written. Null when the index cannot date it (ADR-0053).
   */
  readonly modified: number | null;
  /** Its tags, by key, each once. */
  readonly tags: readonly string[];
  readonly projects: readonly LibraryProject[];
  /** A picture in the vault that fronts it, as written; null for none, and for one off the vault. */
  readonly cover: string | null;
}

export type LibrarySortKey = 'title' | 'author' | 'modified' | 'highlights';

export interface LibrarySort {
  readonly key: LibrarySortKey;
  readonly descending: boolean;
}

/** Newest first: the source last read is the one most likely wanted again. */
export const DEFAULT_LIBRARY_SORT: LibrarySort = { key: 'modified', descending: true };

/** Which sources the Library shows: every one of `kinds` (all, when empty), with the tag and project, matching the words. */
export interface LibraryFilter {
  readonly kinds: readonly SourceKind[];
  readonly tag: string | null;
  /** A project by {@link projectKey}. */
  readonly project: string | null;
  readonly search: string;
}

export const NO_LIBRARY_FILTER: LibraryFilter = { kinds: [], tag: null, project: null, search: '' };

/** What each kind is called on its chip. */
export const SOURCE_KIND_LABELS: Readonly<Record<SourceKind, string>> = {
  pdf: 'PDF',
  epub: 'EPUB',
  kindle: 'Kindle',
};

/**
 * Each kind's muted pastel (#413): fixed, so a kind is the same colour in every list.
 * Mirrors the highlight chip's SOURCE_KIND_HUES (#506, reader/highlight-opening.ts); once both
 * have merged, these become one table.
 */
export const LIBRARY_KIND_HUES: Readonly<Record<SourceKind, PillHue>> = {
  pdf: 'red',
  epub: 'green',
  kindle: 'orange',
};

/** A project as a filter names it: the note it resolves to, or its name folded when it resolves to none. */
export function projectKey(project: LibraryProject): string {
  return project.path ?? `name:${foldedWords(project.name).join(' ')}`;
}

/** The sources `filter` lets through, in the order given. */
export function filterLibrary(
  entries: readonly LibraryEntry[],
  filter: LibraryFilter,
): LibraryEntry[] {
  const words = foldedWords(filter.search);
  return entries.filter(
    (entry) =>
      (filter.kinds.length === 0 || (entry.kind !== null && filter.kinds.includes(entry.kind))) &&
      (filter.tag === null || usesTag(entry.tags, filter.tag)) &&
      (filter.project === null ||
        entry.projects.some((project) => projectKey(project) === filter.project)) &&
      matchesEvery(words, [entry.title, entry.author ?? '']),
  );
}

/**
 * The sources in `sort`'s order. A tie — and a source with no author, which
 * always comes after those with one — falls back to the title, then the path,
 * so the order is the same on every read.
 */
export function sortLibrary(entries: readonly LibraryEntry[], sort: LibrarySort): LibraryEntry[] {
  const sign = sort.descending ? -1 : 1;
  const byTitle = (left: LibraryEntry, right: LibraryEntry) =>
    byName(left.title, right.title) || byName(left.path, right.path);
  /** A time the note never had (NaN) is the epoch, so the order stays a total one. */
  const timeOf = ({ modified }: LibraryEntry) =>
    modified !== null && Number.isFinite(modified) ? modified : 0;
  return [...entries].sort((left, right) => {
    if (sort.key === 'author') {
      if ((left.author === null) !== (right.author === null)) return left.author === null ? 1 : -1;
      return sign * byName(left.author ?? '', right.author ?? '') || byTitle(left, right);
    }
    // Unknown is no time at all: after every dated note, whichever way the sort runs.
    if (sort.key === 'modified' && isDated(left) !== isDated(right)) return isDated(left) ? -1 : 1;
    const order =
      sort.key === 'title'
        ? byTitle(left, right)
        : sort.key === 'modified'
          ? timeOf(left) - timeOf(right)
          : left.highlights - right.highlights;
    return sign * order || byTitle(left, right);
  });
}

/** Whether the index could date the note (ADR-0053). */
const isDated = (entry: LibraryEntry) => entry.modified !== null;

/** The Library as shown: filtered, then sorted. */
export function libraryShown(
  entries: readonly LibraryEntry[],
  { filter, sort }: { filter: LibraryFilter; sort: LibrarySort },
): LibraryEntry[] {
  return sortLibrary(filterLibrary(entries, filter), sort);
}

/** What the Library's filters offer: each kind, tag and project its sources have, with how many. */
export interface LibraryChoices {
  readonly kinds: readonly ResearchChoice<SourceKind>[];
  readonly tags: readonly ResearchChoice<string>[];
  readonly projects: readonly ResearchChoice<string>[];
}

/** The choices the Library's filters offer, each with how many sources it would show; kinds in their own order, the rest by name. */
export function libraryChoices(entries: readonly LibraryEntry[]): LibraryChoices {
  const kinds = countBy(entries, (entry) => (entry.kind === null ? [] : [entry.kind]));
  const tags = countBy(entries, (entry) => withParentTags(entry.tags));
  const names = new Map<string, string>();
  const projects = countBy(entries, (entry) =>
    entry.projects.map((project) => {
      const key = projectKey(project);
      if (!names.has(key)) names.set(key, project.name);
      return key;
    }),
  );
  return {
    kinds: SOURCE_KINDS.flatMap((kind) => {
      const count = kinds.get(kind);
      return count === undefined ? [] : [{ value: kind, label: SOURCE_KIND_LABELS[kind], count }];
    }),
    tags: [...tags]
      .map(([value, count]) => ({ value, label: `#${value}`, count }))
      .sort((left, right) => byName(left.value, right.value)),
    projects: [...projects]
      .map(([value, count]) => ({ value, label: names.get(value) ?? value, count }))
      .sort((left, right) => byName(left.label, right.label) || byName(left.value, right.value)),
  };
}

/**
 * `filter` without the values `choices` no longer offer (a tag since taken off
 * its last note, a project since renamed): a filter nobody can see or press
 * off must not keep hiding sources. The search words stay: they are typed.
 */
export function settleLibraryFilter(filter: LibraryFilter, choices: LibraryChoices): LibraryFilter {
  const offered = <Value extends string>(value: Value, among: readonly ResearchChoice<Value>[]) =>
    among.some((choice) => choice.value === value);
  const kinds = filter.kinds.filter((kind) => offered(kind, choices.kinds));
  const tag = filter.tag !== null && offered(filter.tag, choices.tags) ? filter.tag : null;
  const project =
    filter.project !== null && offered(filter.project, choices.projects) ? filter.project : null;
  const unchanged =
    kinds.length === filter.kinds.length && tag === filter.tag && project === filter.project;
  return unchanged ? filter : { ...filter, kinds, tag, project };
}

/** Whether any of the Library's filters, or its search, is on. */
export function isLibraryFiltered(filter: LibraryFilter): boolean {
  return (
    filter.kinds.length > 0 ||
    filter.tag !== null ||
    filter.project !== null ||
    filter.search.trim() !== ''
  );
}

/** A URL's scheme, which a cover in the vault never has: a picture off the vault is never fetched. */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * The picture a source's `cover:` names in the vault, as the vault's image
 * loader reads it: an embed (`![[cover.jpg]]`), a link (`[[cover.jpg|Cover]]`)
 * or a markdown image (`![Cover](cover.jpg)`) becomes its path, a bare path stays. Null for none, and for a URL — the
 * Library shows only what is already in the vault, and fetches nothing.
 */
export function libraryCover(value: string | null): string | null {
  if (value === null) return null;
  const written = value.trim();
  const linked = /^!?\[\[([^\]|#]*)[^\]]*\]\]$/.exec(written);
  const pictured = /^!\[[^\]]*\]\(\s*<?([^)\s>]*)>?[^)]*\)$/.exec(written);
  const path = (linked?.[1] ?? pictured?.[1] ?? written).trim();
  return path === '' || SCHEME.test(path) || path.startsWith('//') ? null : path;
}
