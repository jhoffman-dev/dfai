/**
 * The local API's contract for object types and their views.
 *
 * One area of `../contract.ts`, which composes every area's routes and
 * answers. Everything here is data. No behaviour belongs in this file.
 */

export interface ApiTypeProperty {
  readonly key: string;
  readonly kind: string;
  readonly label: string;
  readonly required: boolean;
  readonly options: readonly string[];
  /** For a relation: the type it points at — the first, when it may point at several. */
  readonly target: string | null;
  /** For a relation: every type it may point at, `[project, area]`; empty when it names none. */
  readonly targets: readonly string[];
  readonly many: boolean;
}

export interface ApiType {
  readonly name: string;
  readonly label: string;
  readonly properties: readonly ApiTypeProperty[];
}

/** One of a type's view tabs, as the type's page shows them (ADR-0023). */
export interface ApiTypeView {
  /** The view's own path, for `/v1/views/{path}/run`; for the virtual default, where it would be written. */
  readonly path: string;
  /** The tab's name: the view's `title:`, else its file name. */
  readonly title: string;
  /** table, board, list, gallery, feed, calendar or timeline. */
  readonly layout: string;
  /** Its `order:`; null when it was never placed (it reads after the placed ones), or virtual. */
  readonly order: number | null;
  /**
   * True for the default table a type with no views shows: not a file yet, so
   * it cannot be run by its path. Run `/v1/query` with the type for its rows.
   */
  readonly virtual: boolean;
}

/** What the routes for object types and their views answer with. */
export type ApiTypeSuccessBody =
  | { readonly types: readonly ApiType[] }
  | {
      readonly type: string;
      readonly views: readonly ApiTypeView[];
      /** How many views the type has, across every page. */
      readonly total: number;
      /** The `offset` of the next page, or null on the last. */
      readonly next: number | null;
    };

/** The routes for object types and their views. */
export const TYPE_ROUTES = [
  { method: 'GET', path: '/v1/types', summary: 'Object types and their properties.' },
  {
    method: 'GET',
    path: '/v1/types/{name}/views',
    summary: "A type's views, in the order its tabs read. Query: limit, offset.",
  },
] as const;
