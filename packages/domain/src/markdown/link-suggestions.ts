import { foldedLinkName } from './resolve-wikilink.ts';

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

/** How strong a match is: larger is better, and the empty query's is the least. */
export function linkMatchStrength(match: LinkMatch): number {
  return STRENGTH[match];
}

/** A note a link field may offer: what it is, and what it is called. */
export interface LinkCandidate {
  readonly path: string;
  readonly title: string;
}

/** How often, and how lately, notes link a note through a relation. */
export interface LinkUse {
  readonly count: number;
  /**
   * When the latest note linking it last changed, as the index stores it:
   * larger is later. Null when the index can date none of them (ADR-0053),
   * which ranks after every dated use.
   */
  readonly last: number | null;
}

/** What a ranking knows beyond titles, by note path: the note's aliases, and its use. */
export interface LinkHints {
  readonly aliases: ReadonlyMap<string, readonly string[]>;
  readonly uses: ReadonlyMap<string, LinkUse>;
}

export const NO_LINK_HINTS: LinkHints = { aliases: new Map(), uses: new Map() };

/** One note offered, how it met the query, and the alias it met it by — null when its title did. */
export interface LinkSuggestion<Choice extends LinkCandidate> {
  readonly choice: Choice;
  readonly match: LinkMatch;
  readonly alias: string | null;
}

const DEFAULT_LIMIT = 50;

/** The fewest letters a fuzzy match is offered for. */
const FUZZY_FROM = 3;

/** Anything that is not a letter or a digit ends a word. */
const WORD_BREAK = /[^\p{L}\p{N}]+/u;

/** A combining mark: what an accent is, once a name is decomposed. */
const MARKS = /\p{M}/gu;

/**
 * A name as a suggestion compares it: folded the way links fold names
 * (`foldedLinkName` — accents composed one way, case folded), then with its
 * accents taken off, so `zoe` finds "Zoë" whichever way the file spells it.
 */
export function foldedForSuggestion(name: string): string {
  return foldedLinkName(name).normalize('NFD').replace(MARKS, '');
}

/** How `query` meets `name`, or null when it does not. */
export function linkMatchOf(name: string, query: string): LinkMatch | null {
  return matchFolded(foldedForSuggestion(name), foldedForSuggestion(query));
}

function matchFolded(name: string, query: string): LinkMatch | null {
  if (query === '') return 'any';
  if (name === query) return 'exact';
  if (name.startsWith(query)) return 'prefix';
  if (name.split(WORD_BREAK).some((word) => word !== '' && word.startsWith(query))) return 'word';
  if (name.includes(query)) return 'contains';
  const letters = query.replace(/\s+/g, '');
  // Two letters in order are in most names: a fuzzy match is only worth offering from three.
  return letters.length >= FUZZY_FROM && inOrder(name, letters) ? 'fuzzy' : null;
}

/** Whether every character of `query` is in `name`, in the same order. */
function inOrder(name: string, query: string): boolean {
  let at = 0;
  for (const character of name) {
    if (character === query[at]) at += 1;
    if (at === query.length) return true;
  }
  return query.length === 0;
}

interface Scored<Choice extends LinkCandidate> extends LinkSuggestion<Choice> {
  /** The name that met the query, folded: the title, or the alias. */
  readonly met: string;
  readonly use: LinkUse | undefined;
}

/**
 * The notes a link field suggests for what has been typed (#465), best
 * first: by how well the title or an alias meets the query; among equal
 * matches, the note linked most lately, then most often; then the shorter
 * name, so "Garden" comes before "Garden shed"; then by name and path, so
 * the order is total and never reshuffles for a reason nobody can see.
 *
 * Which notes may be offered — those of the relation's types, none archived
 * — is decided before this, by whoever gathered `choices`.
 */
export function rankLinkChoices<Choice extends LinkCandidate>({
  query,
  choices,
  hints = NO_LINK_HINTS,
  limit = DEFAULT_LIMIT,
}: {
  query: string;
  choices: readonly Choice[];
  hints?: LinkHints;
  limit?: number;
}): LinkSuggestion<Choice>[] {
  const wanted = foldedForSuggestion(query);
  const scored = choices.flatMap((choice) => {
    const best = bestMatch(choice, wanted, hints);
    return best === null ? [] : [{ ...best, use: hints.uses.get(choice.path) }];
  });
  scored.sort((left, right) => compare(left, right, wanted === ''));
  return scored.slice(0, limit).map(({ choice, match, alias }) => ({ choice, match, alias }));
}

/** The better of a note's title and its aliases at meeting the query; the title on a tie. */
function bestMatch<Choice extends LinkCandidate>(
  choice: Choice,
  wanted: string,
  hints: LinkHints,
): Omit<Scored<Choice>, 'use'> | null {
  const title = foldedForSuggestion(choice.title);
  const byTitle = matchFolded(title, wanted);
  let best =
    byTitle === null ? null : { choice, match: byTitle, alias: null as string | null, met: title };
  for (const alias of hints.aliases.get(choice.path) ?? []) {
    const folded = foldedForSuggestion(alias);
    const byAlias = matchFolded(folded, wanted);
    if (byAlias !== null && (best === null || STRENGTH[byAlias] > STRENGTH[best.match])) {
      best = { choice, match: byAlias, alias, met: folded };
    }
  }
  return best;
}

function compare<Choice extends LinkCandidate>(
  left: Scored<Choice>,
  right: Scored<Choice>,
  nothingTyped: boolean,
): number {
  return (
    STRENGTH[right.match] - STRENGTH[left.match] ||
    (right.use?.last ?? -Infinity) - (left.use?.last ?? -Infinity) ||
    (right.use?.count ?? 0) - (left.use?.count ?? 0) ||
    // With nothing typed, no name is closer to it than another.
    (nothingTyped ? 0 : left.met.length - right.met.length) ||
    byText(left.met, right.met) ||
    byText(left.choice.path, right.choice.path)
  );
}

/** Code-unit order: the same on every machine, unlike a locale's. */
function byText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** A half-typed `[[link` in a text field: where its `[[` starts, and what follows it to the caret. */
export interface OpenLinkInText {
  readonly start: number;
  readonly query: string;
}

/**
 * The `[[link` being typed at `caret` in a plain text field, or null: the
 * last `[[` before the caret, with no `]]`, line break or second `[[`
 * between them.
 */
export function openLinkInText(text: string, caret: number): OpenLinkInText | null {
  const before = text.slice(0, caret);
  const opened = before.lastIndexOf('[[');
  if (opened < 0) return null;
  const query = before.slice(opened + 2);
  if (query.includes(']]') || /[\r\n]/.test(query)) return null;
  // A `[` typed once too often (`[[[Gar`) goes with the link it would break.
  let start = opened;
  while (start > 0 && before[start - 1] === '[') start -= 1;
  return { start, query };
}

/**
 * The text with the half-typed link at `caret` replaced by `link` — any
 * `]]` already closing it taken in, rather than doubled — and where the
 * caret goes: just after the link. The text as it was when there is none.
 */
export function withLinkInText({
  text,
  caret,
  link,
}: {
  text: string;
  caret: number;
  link: string;
}): { text: string; caret: number } {
  const open = openLinkInText(text, caret);
  if (open === null) return { text, caret };
  const rest = text.slice(caret);
  // A `]]` already closing it — or the one `]` typed so far — is taken in, never doubled.
  const closing = /^[^\]\r\n[]*\]{1,2}/.exec(rest)?.[0].length ?? 0;
  const next = `${text.slice(0, open.start)}${link}${rest.slice(closing)}`;
  return { text: next, caret: open.start + link.length };
}
