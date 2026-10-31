/**
 * The local API's contract for queries: filters, SQL and DFAI queries.
 *
 * One area of `../contract.ts`, which composes every area's routes and
 * answers. Everything here is data. No behaviour belongs in this file.
 */

import type { FilterOperator } from '@dfai/domain';

/** Rows, as the index returned them. */
export interface ApiRows {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
  /**
   * True when more rows matched than came back: for a query or a view, its
   * limit or the host's row cap cut it short; for SQL, the row cap.
   */
  readonly truncated: boolean;
  /** The SQL that ran, so a caller can read what it asked for. */
  readonly sql: string;
}

/**
 * A group of a DFAI query's rows, as the app groups a list or a table: a
 * select's groups in the type's order, a relation's named for the note, the
 * rows with no value last. A group no row is in is left out.
 */
export interface ApiQueryGroup {
  readonly label: string;
  /** The value its rows hold, or null for the rows with none. */
  readonly value: string | null;
  /** Its rows, as indexes into the answer's `rows`. */
  readonly rows: readonly number[];
  /** The sub-groups (`GROUP BY a THEN b`); empty at the last level. */
  readonly groups: readonly ApiQueryGroup[];
}

/** A DFAI query's answer: its rows, and its groups when it has `GROUP BY`. */
export interface ApiAtlasQueryRows extends ApiRows {
  readonly groups?: readonly ApiQueryGroup[];
}

export interface ApiQueryBody {
  readonly type: string;
  readonly columns?: readonly string[];
  readonly filters?: readonly {
    readonly key: string;
    readonly operator: FilterOperator;
    readonly value?: string | number | boolean | null;
  }[];
  readonly sorts?: readonly { readonly key: string; readonly direction: 'asc' | 'desc' }[];
  readonly limit?: number;
  /** Lists archived notes too. Default false: the Archive is out of the way unless asked for. */
  readonly includeArchived?: boolean;
  /**
   * For a query of tasks: adds a `schedule` column, each task's
   * {@link ApiTaskSchedule} (P31-01). Default false.
   */
  readonly schedule?: boolean;
}

/**
 * A task's schedule, in minutes (P31-01): its estimate (null when it has
 * none), the time its blocks set aside — a one-task block all of itself, a
 * block of several shared by what each has left — what is done (all of the
 * estimate once finished; null with no estimate), and how far the time
 * scheduled runs past the estimate.
 */
export interface ApiTaskSchedule {
  readonly estimate: number | null;
  readonly scheduled: number;
  readonly done: number | null;
  readonly overBy: number;
}

/** A DFAI query (ADR-0019), run read-only against the vault's types and notes. */
export interface ApiAtlasQueryBody {
  /** The query's text, e.g. `FROM task WHERE status != done SORT BY due`. */
  readonly query: string;
  /**
   * At most this many rows, 1 to 5000. The text's own `LIMIT` wins when it is
   * smaller; with neither, 500.
   */
  readonly limit?: number;
  /**
   * The note the query is shown on, as a vault path (`people/Mara Quill.md`):
   * what `this` in the query names. Without it, a query that says `this` is
   * `invalid`; a note the vault does not have is `not_found`.
   */
  readonly context?: string;
}

export interface ApiSqlBody {
  /** Run on the index's read-only connection, under its row cap and step budget. */
  readonly sql: string;
  readonly params?: readonly (string | number | null)[];
}

/** What the routes for queries: filters, SQL and DFAI queries answer with. */
export type ApiQuerySuccessBody = ApiRows | ApiAtlasQueryRows;

/** The routes for queries: filters, SQL and DFAI queries. */
export const QUERY_ROUTES = [
  { method: 'POST', path: '/v1/query', summary: 'Query notes of a type with filters and sorts.' },
  { method: 'POST', path: '/v1/sql', summary: 'Read-only SQL against the index.' },
  {
    method: 'POST',
    path: '/v1/atlas-query',
    summary:
      'Run a DFAI query across types: rows, and its groups and sub-groups. `context` names the note `this` means.',
  },
] as const;
