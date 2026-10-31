/**
 * The local API's contract for saved views, dashboards, boards and calendars.
 *
 * One area of `../contract.ts`, which composes every area's routes and
 * answers. Everything here is data. No behaviour belongs in this file.
 */

import type { ApiNote } from './notes.ts';

export interface ApiView {
  /** The view or dashboard note's own path, for `/v1/views/{path}/run`. */
  readonly path: string;
  readonly title: string;
  readonly kind: 'view' | 'dashboard';
  /** For a view: the type it lists. Null for a dashboard. */
  readonly type: string | null;
  /** For a view: table, board, list, gallery, feed, calendar or timeline. */
  readonly layout: string | null;
  /** For a view: the property it groups by — a board's columns, a table's groups. Null for none. */
  readonly groupBy: string | null;
  /** For a view: what each group is split by — a board's swimlanes, a table's sub-groups. */
  readonly subGroupBy: string | null;
  /**
   * For a view: its `order:`, its place among its type's tabs (ADR-0023); null
   * when it was never placed, or for a dashboard. `/v1/types/{name}/views`
   * answers a type's views already in tab order.
   */
  readonly order: number | null;
}

export interface ApiRunViewBody {
  /** Lists archived notes too, for a saved view. Default false; a dashboard ignores it. */
  readonly includeArchived?: boolean;
}

/**
 * A card moved on a board, as a drag moves it: to a column (`group`), a lane
 * (`subGroup`), or both. A value is a group's `value` as a run answers it;
 * null is "No value".
 */
export interface ApiMoveCardBody {
  /** The card's note, vault-relative, as other routes answer it. */
  readonly note: string;
  readonly group?: string | null;
  readonly subGroup?: string | null;
  /**
   * Refuse with `conflict` unless the note's `modified` still equals this.
   * Required for a move that finishes the task, so a retry cannot finish it twice.
   */
  readonly ifModified?: number;
}

/** A note added inside a view's group, as "+ New" in it adds one. */
export interface ApiAddViewNoteBody {
  /** Omitted or blank: `New <type>`, numbered past any taken. */
  readonly name?: string;
  /** The group it goes in, as a run answers its `value`; null is "No value". */
  readonly group?: string | null;
  /** The sub-group (a board's lane) it goes in. */
  readonly subGroup?: string | null;
}

/** The ranges a calendar view shows, as its switcher offers them. */
export type ApiCalendarRange = 'month' | 'week' | '3day' | 'day' | 'agenda';

export interface ApiCalendarBody {
  /** A day in the range, `YYYY-MM-DD`. Omitted: today. */
  readonly anchor?: string;
  /** Omitted: the range the view was saved with. */
  readonly range?: ApiCalendarRange;
  /** For `agenda` only: how many days it lists, 1 to 366. Omitted: 30. */
  readonly days?: number;
}

/** A note on a calendar. Times are wall-clock, as the note writes them. */
export interface ApiCalendarEvent {
  readonly path: string;
  readonly title: string;
  /** `YYYY-MM-DD`, or `YYYY-MM-DDTHH:mm` when the note is on the clock. */
  readonly start: string;
  /** The same, from the view's end property; null when it has none. */
  readonly end: string | null;
  readonly allDay: boolean;
  /** The days of the range the note is on, in order. */
  readonly on: readonly string[];
}

export interface ApiCalendar {
  readonly range: ApiCalendarRange;
  /** Every day the range shows, in order: a month's grid starts on a Monday. */
  readonly days: readonly string[];
  /** Notes on at least one of those days, all-day first, then by start. */
  readonly events: readonly ApiCalendarEvent[];
  /** Notes the view lists that have no readable date, so are on no day. */
  readonly unscheduled: number;
  /** True when the view's limit or the row cap left notes out. */
  readonly truncated: boolean;
}

/** What the routes for saved views, dashboards, boards and calendars answer with. */
export type ApiViewSuccessBody =
  | { readonly note: ApiNote; readonly moved: boolean }
  | { readonly views: readonly ApiView[] }
  | { readonly widgets: readonly unknown[] }
  | ApiCalendar;

/** The routes for saved views, dashboards, boards and calendars. */
export const VIEW_ROUTES = [
  { method: 'GET', path: '/v1/views', summary: 'Saved views and dashboards.' },
  {
    method: 'POST',
    path: '/v1/views/{path}/run',
    summary: "Run a saved view, or a dashboard's widgets.",
  },
  {
    method: 'POST',
    path: '/v1/views/{path}/calendar',
    summary: "A saved view's notes on a calendar: a month, week, 3 days, a day or an agenda.",
  },
  {
    method: 'POST',
    path: '/v1/views/{path}/move',
    summary:
      'Move a card on a board to another column, lane or both, as a drag does. Requires ifModified to finish a task.',
  },
  {
    method: 'POST',
    path: '/v1/views/{path}/notes',
    summary: "Add a note inside a view's group, given that group's values, as + New does.",
  },
] as const;
