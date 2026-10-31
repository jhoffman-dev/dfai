/**
 * The local API's contract for search, by words and by meaning.
 *
 * One area of `../contract.ts`, which composes every area's routes and
 * answers. Everything here is data. No behaviour belongs in this file.
 */

export interface ApiSearchHit {
  readonly path: string;
  readonly title: string;
  /** The matching text with `<<` and `>>` around the words that matched. */
  readonly snippet: string;
  /** Present, and true, on a hit in the Archive: only when the search asked for `includeArchived`. */
  readonly archived?: true;
}

/** A block found by meaning (`/v1/search?mode=semantic`, P32-02), with the link that cites it. */
export interface ApiSemanticHit {
  readonly path: string;
  readonly title: string;
  /** What the block says, cut to an excerpt. */
  readonly text: string;
  /** The heading the block sits under, or null. */
  readonly heading: string | null;
  /** The block's `^id` when it has one, or null. */
  readonly block: string | null;
  /** `[[Note#^id]]`, else `[[Note#Heading]]`, else `[[Note]]`: what to cite. */
  readonly link: string;
  /** Cosine similarity to the question, from -1 to 1; higher is closer. */
  readonly score: number;
  readonly archived?: true;
}

/** How far the embeddings cache is built: while `done < total`, notes not yet embedded cannot be found. */
export interface ApiSemanticProgress {
  readonly done: number;
  readonly total: number;
  /** Why the build stopped, when it did; the next search starts it again. */
  readonly failure: string | null;
}

/** What the routes for search, by words and by meaning answer with. */
export type ApiSearchSuccessBody =
  | { readonly hits: readonly ApiSearchHit[] }
  | { readonly hits: readonly ApiSemanticHit[]; readonly progress: ApiSemanticProgress };

/** The routes for search, by words and by meaning. */
export const SEARCH_ROUTES = [
  {
    method: 'GET',
    path: '/v1/search',
    summary: 'Full-text search. Query: q, limit, includeArchived.',
  },
] as const;
