/**
 * The local API's contract for the weekly review.
 *
 * One area of `../contract.ts`, which composes every area's routes and
 * answers. Everything here is data. No behaviour belongs in this file.
 */

/** A task as the weekly review lists it. */
export interface ApiReviewTask {
  readonly path: string;
  readonly title: string;
  /** One of GTD's eight statuses, or null when it holds none of them. */
  readonly status: string | null;
  /** `YYYY-MM-DD`, or null. */
  readonly due: string | null;
  /** `YYYY-MM-DD`: the day it comes back into play, or null. */
  readonly defer: string | null;
  /** How it repeats, as its `recurrence` says, or null when it does not (#260). Always read by the API. */
  readonly recurrence?: string | null;
  /** The day it was chosen for (`focus`, #108), `YYYY-MM-DD`, or null. Always read by the API. */
  readonly focus?: string | null;
  /** Whether its `focus` holds something other than one day: the person's own, which no choice writes over. */
  readonly focusIsOwn?: boolean;
  /** Who it waits on — a link by what it shows, a plain name as written — joined with ", "; '' for nobody. */
  readonly waitingOn: string;
  /** Its `contexts`, as written, in order. */
  readonly contexts: readonly string[];
  /** The note its `project` links, or null. */
  readonly project: string | null;
  /** That note's title, or null. */
  readonly projectTitle: string | null;
  /** When its file last changed, in milliseconds since the epoch; null where the vault cannot tell (ADR-0053). */
  readonly modified: number | null;
}

/** A project as the weekly review lists it. */
export interface ApiReviewProject {
  readonly path: string;
  readonly title: string;
  /** Its `status:` as written, or null. */
  readonly status: string | null;
  /** Whether a task in use filed under it is Next Action or In Progress, as the index says. */
  readonly moving: boolean;
}

/** `GET /v1/review/weekly`: the weekly review, as its page shows it. */
export interface ApiWeeklyReview {
  /** The day it was taken, `YYYY-MM-DD`, where the app is. */
  readonly today: string;
  /** Waiting, and untouched for more than 7 days; the longest untouched first. */
  readonly staleWaiting: readonly ApiReviewTask[];
  /** Active, with no Next Action or In Progress task filed under it; by title. */
  readonly projectsWithoutNextAction: readonly ApiReviewProject[];
  /** Due before today and still open (not Someday, Longterm or Archive); the earliest first. */
  readonly overdue: readonly ApiReviewTask[];
  /** Someday or Longterm, and untouched for more than 30 days; the longest untouched first. */
  readonly untouchedSomeday: readonly ApiReviewTask[];
  /**
   * What waits in the one Inbox, as the sidebar counts it: `count` is the notes
   * to file (`toFile`) plus the proposals to answer (`toAnswer`); `more` when
   * there are more notes than it counts.
   */
  readonly inbox: {
    readonly count: number;
    readonly toFile: number;
    readonly toAnswer: number;
    readonly more: boolean;
  };
  /** The index held tasks back, so a task section may be missing items. */
  readonly truncated: boolean;
}

/** What the routes for the weekly review answer with. */
export type ApiReviewSuccessBody = { readonly review: ApiWeeklyReview };

/** The routes for the weekly review. */
export const REVIEW_ROUTES = [
  {
    method: 'GET',
    path: '/v1/review/weekly',
    summary:
      'The weekly review: stale waiting-fors, projects with nothing next, overdue, old ideas.',
  },
] as const;
