/**
 * The local API's contract for the Inbox and clarifying it.
 *
 * One area of `../contract.ts`, which composes every area's routes and
 * answers. Everything here is data. No behaviour belongs in this file.
 */

import type { ApiArchiveOutcome } from './archive.ts';

/** A note waiting in the Inbox to be filed, as the Inbox page lists it. */
export interface ApiInboxItem {
  readonly path: string;
  readonly title: string;
  /** Its `type:`, or null for a plain note. */
  readonly type: string | null;
  /** The folder of the Inbox it arrived in — `Meetings` — or '' for the Inbox itself. */
  readonly arrivedIn: string;
  /** What the meeting import made of it: its outcome, `pending` while it waits, null when not a meeting file. */
  readonly importOutcome: 'imported' | 'duplicate' | 'error' | 'pending' | null;
  /** Why it failed the meeting import, or null. */
  readonly importError: string | null;
  /** What it says as a task, which clarifying it starts from; null for a note that is not a task. */
  readonly task: {
    /** One of the eight GTD statuses, or null when it has none or holds something else. */
    readonly status: string | null;
    /** The path of the project or area it is filed under, or null. */
    readonly project: string | null;
    /** The path of the person it waits on, when `waiting_on` links one. */
    readonly waitingOn: string | null;
    /** Who it waits on as written; '' for nobody. */
    readonly waitingOnNames: string;
    /** `YYYY-MM-DD`, or null. */
    readonly defer: string | null;
    /** `YYYY-MM-DD`, or null. */
    readonly due: string | null;
  } | null;
}

/**
 * `POST /v1/inbox/clarify` (#112): one note waiting in the Inbox, and what is
 * decided about it. A key left out is left as the note has it; `null` takes
 * away what it held. Everything is written in one save. The note may be any
 * task the API reaches, not only one `GET /v1/inbox` lists, but never an
 * archived one; a status must be one the vault's Task type declares, and
 * `waitingOn` is written only when the task is, or is being made, `waiting`.
 */
export interface ApiClarifyInboxBody {
  /** The note to clarify: one `GET /v1/inbox` lists, or any other task in use. */
  readonly path: string;
  /** One of inbox, backlog, next-action, in-progress, waiting, someday, longterm, archive. */
  readonly status?: string;
  /** The path of a project or an area to file it under. */
  readonly project?: string;
  /** The path of the person it waits on, if anyone: Waiting never needs one (#202). */
  readonly waitingOn?: string | null;
  /** `YYYY-MM-DD`: the day it comes back into view. */
  readonly defer?: string | null;
  /** `YYYY-MM-DD`. */
  readonly due?: string | null;
  /** Where it can be done; an empty list takes them away. */
  readonly contexts?: readonly string[];
  /** Makes a plain note a task, starting in the Inbox unless `status` is given. */
  readonly asTask?: boolean;
}

/** What clarifying a note did. */
export interface ApiClarifyOutcome {
  /** Where the note is now. */
  readonly path: string;
  /** Where it was, when it was filed under a project; null when it stayed where it is. */
  readonly movedFrom: string | null;
  /** What could not be done once its properties were written: the filing, or a link left behind. */
  readonly failed: ApiArchiveOutcome['failed'];
  /** Links in other notes rewritten so they still open the note where it went. */
  readonly linksUpdated: number;
}

/** `POST /v1/inbox/process`: notes in the Inbox, and the project or area to file them under. */
export interface ApiProcessInboxBody {
  /** Vault-relative paths of notes in the Inbox: 1 to 100 of them. */
  readonly paths: readonly string[];
  /** The path of a project or an area. */
  readonly project: string;
}

/** What processing the Inbox did: what moved out of the `Inbox` folder, and what was filed where it is. */
export interface ApiProcessOutcome extends ApiArchiveOutcome {
  /** Notes filed by their `project` link alone, where they live: a meeting in its month's folder (#214). */
  readonly linked: readonly string[];
}

/** What the routes for the Inbox and clarifying it answer with. */
export type ApiInboxSuccessBody =
  | ApiProcessOutcome
  | ApiClarifyOutcome
  | { readonly items: readonly ApiInboxItem[]; readonly truncated: boolean };

/** The routes for the Inbox and clarifying it. */
export const INBOX_ROUTES = [
  {
    method: 'GET',
    path: '/v1/inbox',
    summary:
      'What waits in the Inbox, newest first: its folder, and every task still at Inbox; no proposals.',
  },
  {
    method: 'POST',
    path: '/v1/inbox/process',
    summary: "File notes from the Inbox under a project or an area, as the Inbox's Process does.",
  },
  {
    method: 'POST',
    path: '/v1/inbox/clarify',
    summary:
      'Clarify one Inbox note in one save: status, project, waiting on, defer, due, contexts.',
  },
] as const;
