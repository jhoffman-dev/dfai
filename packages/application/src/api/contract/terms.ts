/**
 * The local API's contract for terms and the vocabulary.
 *
 * One area of `../contract.ts`, which composes every area's routes and
 * answers. Everything here is data. No behaviour belongs in this file.
 */

/** A term (P28-05): a name's one right spelling, the ways it is misheard, and what it names. */
export interface ApiTerm {
  readonly path: string;
  /** The right spelling: the term's title. */
  readonly canonical: string;
  readonly variants: readonly string[];
  /** `product`, `person`, `company`, `acronym` or `other`; null when the note names none of these. */
  readonly kind: string | null;
}

/** A note's claim that a spelling means its own right spelling. */
export interface ApiVocabularyClaim {
  /** The spelling as that note writes it. */
  readonly form: string;
  /** What that note says it should be spelt as. */
  readonly canonical: string;
  readonly path: string;
  /** A term's variant, or a person's or a company's name or alias. */
  readonly source: 'term' | 'person' | 'company';
}

/** A spelling DFAI puts right, what to, and every note that says so. */
export interface ApiVocabularyEntry {
  readonly form: string;
  readonly canonical: string;
  readonly claims: readonly ApiVocabularyClaim[];
}

/** A spelling two notes claim for two different right spellings: not used until one lets it go. */
export interface ApiVocabularyConflict {
  readonly form: string;
  readonly claims: readonly ApiVocabularyClaim[];
}

/** The vocabulary, as the Terms page reads it. */
export interface ApiTerms {
  readonly terms: readonly ApiTerm[];
  /** Longest spelling first, matched however cased or spaced. */
  readonly vocabulary: readonly ApiVocabularyEntry[];
  readonly conflicts: readonly ApiVocabularyConflict[];
}

/** What the routes for terms and the vocabulary answer with. */
export type ApiTermSuccessBody = ApiTerms;

/** The routes for terms and the vocabulary. */
export const TERM_ROUTES = [
  {
    method: 'GET',
    path: '/v1/terms',
    summary: 'The vocabulary: every term, every spelling DFAI puts right, and the conflicts.',
  },
] as const;
