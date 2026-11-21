import { noteTitle, pathDepth, type VaultPath } from '../vault/index.ts';
import { foldedLinkName, wikiLinkTargetFor } from './resolve.ts';

/**
 * How a typed query meets a name, best first: the whole name, its start, the
 * start of one of its words, somewhere inside it, or its letters in order
 * with others between (`lkpr` in "Larkspur Payroll"). `any` is the empty
 * query, which every name meets.
 */
export type LinkMatch = 'exact' | 'prefix' | 'word' | 'contains' | 'fuzzy' | 'any';

const STRENGTH: Readonly<Record<LinkMatch, number>> = {
  exact: 5,
  prefix: 4,
  word: 3,
  contains: 2,
  fuzzy: 1,
  any: 0,
};

/** The fewest letters a fuzzy match is offered for: two letters in order are in most names. */
const FUZZY_FROM = 3;
const WORD_BREAK = /[^\p{L}\p{N}]+/u;
const MARKS = /\p{M}/gu;

/** A name as a suggestion compares it: folded as links fold, then accents off, so `zoe` finds "Zoë". */
export function foldedForSuggestion(name: string): string {
  return foldedLinkName(name).normalize('NFD').replace(MARKS, '');
}

/** How `query` meets `name`, or null when it does not. */
export function linkMatchOf(name: string, query: string): LinkMatch | null {
  const folded = foldedForSuggestion(name);
  const wanted = foldedForSuggestion(query);
  if (wanted === '') return 'any';
  if (folded === wanted) return 'exact';
  if (folded.startsWith(wanted)) return 'prefix';
  if (folded.split(WORD_BREAK).some((word) => word !== '' && word.startsWith(wanted))) {
    return 'word';
  }
  if (folded.includes(wanted)) return 'contains';
  const letters = wanted.replace(/\s+/g, '');
  return letters.length >= FUZZY_FROM && inOrder(folded, letters) ? 'fuzzy' : null;
}

function inOrder(name: string, query: string): boolean {
  let at = 0;
  for (const character of name) {
    if (character === query[at]) at += 1;
    if (at === query.length) return true;
  }
  return false;
}

export interface NoteSuggestion {
  readonly path: VaultPath;
  readonly title: string;
  readonly match: LinkMatch;
  /** What the link would be written as: the name, or the path when the name opens another note. */
  readonly target: string;
}

/**
 * Notes to offer for a half-typed `[[link`: by how well the name meets the
 * query, then the shorter name ("Garden" before "Garden shed"), then the note
 * nearest the root, then by path — a total order, so the list never
 * reshuffles between keystrokes for a reason nobody can see.
 */
export function rankNoteSuggestions({
  query,
  notes,
  resolve,
  limit = 12,
}: {
  query: string;
  notes: readonly VaultPath[];
  /** The vault's resolver, so each suggestion's link opens the note picked. */
  resolve: (target: string) => VaultPath | null;
  limit?: number;
}): NoteSuggestion[] {
  const scored = notes.flatMap((path) => {
    const title = noteTitle(path);
    const match = linkMatchOf(title, query);
    return match === null ? [] : [{ path, title, match }];
  });
  scored.sort(
    (left, right) =>
      STRENGTH[right.match] - STRENGTH[left.match] ||
      left.title.length - right.title.length ||
      pathDepth(left.path) - pathDepth(right.path) ||
      (left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
  );
  return scored
    .slice(0, limit)
    .map((note) => ({ ...note, target: wikiLinkTargetFor(note.path, resolve) }));
}

/** A half-typed `[[link` in text: where its `[[` starts, and what follows it to the caret. */
export interface OpenLinkInText {
  readonly start: number;
  readonly query: string;
}

/**
 * The `[[link` being typed at `caret`, or null: the last `[[` before the
 * caret, with no `]]`, line break or second `[[` between them.
 */
export function openLinkInText(text: string, caret: number): OpenLinkInText | null {
  const before = text.slice(0, caret);
  const opened = before.lastIndexOf('[[');
  if (opened < 0) return null;
  const query = before.slice(opened + 2);
  if (query.includes(']]') || /[\r\n]/.test(query)) return null;
  return { start: opened, query };
}
