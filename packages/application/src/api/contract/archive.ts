/**
 * The local API's contract for the Archive.
 *
 * One area of `../contract.ts`, which composes every area's routes and
 * answers. Everything here is data. No behaviour belongs in this file.
 */

/** Notes to put in the Archive, or take out of it. */
export interface ApiArchiveBody {
  /** Vault-relative note paths, as other routes answer them: 1 to 100 of them. */
  readonly paths: readonly string[];
}

/** What a batch of archiving, unarchiving or processing the Inbox did. */
export interface ApiArchiveOutcome {
  /** Every note that moved, in the order asked, from where it was to where it went. */
  readonly moves: readonly { readonly from: string; readonly to: string }[];
  /**
   * Each path that did not move, with why — or that moved and was then not
   * fully updated, under where it went — and each note whose links to them
   * could not be rewritten. The rest of the batch carries on. `code` is
   * `unsaved_in_app` for a note left alone because it is open in DFAI with
   * unsaved typing, which the API never saves.
   */
  readonly failed: readonly {
    readonly path: string;
    readonly reason: string;
    readonly code?: 'unsaved_in_app';
  }[];
  /** Links in other notes rewritten so they still open the notes that moved. */
  readonly linksUpdated: number;
}

/** A note in the Archive, as the Archive lists it. */
export interface ApiArchivedNote {
  readonly path: string;
  readonly title: string;
  /** Where unarchiving puts it back. */
  readonly from: string;
  /** The day it was archived, `YYYY-MM-DD`, or null when it does not say. */
  readonly archivedOn: string | null;
}

/** What the routes for the Archive answer with. */
export type ApiArchiveSuccessBody =
  | ApiArchiveOutcome
  | {
      readonly notes: readonly ApiArchivedNote[];
      readonly truncated: boolean;
      /** The `offset` for the next page, or null when this was the last. */
      readonly next: number | null;
    };

/** The routes for the Archive. */
export const ARCHIVE_ROUTES = [
  {
    method: 'GET',
    path: '/v1/archive',
    summary: 'List archived notes, newest first. Query: search, limit, offset.',
  },
  {
    method: 'POST',
    path: '/v1/archive',
    summary: 'Put notes in the Archive, as the app does, rewriting links to them.',
  },
  {
    method: 'POST',
    path: '/v1/unarchive',
    summary: 'Take notes out of the Archive, back where each came from.',
  },
] as const;
