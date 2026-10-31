/**
 * The local API's contract for refreshing a source note.
 *
 * One area of `../contract.ts`, which composes every area's routes and
 * answers. Everything here is data. No behaviour belongs in this file.
 */

/** What one refresh of a source did, as the source note's panel reports it. */
export interface ApiSourceReport {
  /** When it ran, in milliseconds since the epoch. */
  readonly ran: number;
  /** The URL or file it read, as the note names it — a secret by its name, never its value. */
  readonly from: string;
  readonly records: number;
  readonly created: number;
  readonly replaced: number;
  readonly updated: number;
  /** Notes whose record is no longer in the feed: marked, never deleted. */
  readonly missing: number;
  readonly unkeyed: number;
  readonly truncated: boolean;
  /** Why the refresh failed, or null. Counts of what landed first still stand. */
  readonly error: string | null;
}

/** What the routes for refreshing a source note answer with. */
export type ApiSourceSuccessBody = { readonly report: ApiSourceReport };

/** The routes for refreshing a source note. */
export const SOURCE_ROUTES = [
  {
    method: 'POST',
    path: '/v1/sources/{path}/refresh',
    summary: 'Refresh a source note now, as its Refresh button does.',
  },
] as const;
