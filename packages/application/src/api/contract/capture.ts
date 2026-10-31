/**
 * The local API's contract for capturing in the app: the daily note and quick
 * add.
 *
 * One area of `../contract.ts`, which composes every area's routes and
 * answers. Everything here is data. No behaviour belongs in this file.
 */

export interface ApiCaptureBody {
  /** The task's name, as typed into quick capture. */
  readonly text: string;
}

/** A type the add button offers, and the fields it asks for beside the name. */
export interface ApiQuickAddType {
  readonly name: string;
  readonly label: string;
  /** Property keys, in the order the add button asks for them (at most three). */
  readonly fields: readonly string[];
}

export interface ApiQuickAddBody {
  /** The type's name, as `/v1/types` gives it. */
  readonly type: string;
  /** The new note's name. Numbered, never refused, when it is taken. */
  readonly name: string;
  /** Properties by key, as typed into the add button's fields: text, stored as each kind does. */
  readonly values?: Readonly<Record<string, string>>;
}

/** What the routes for capturing in the app: the daily note and quick add answer with. */
export type ApiCaptureSuccessBody = { readonly types: readonly ApiQuickAddType[] };

/** The routes for capturing in the app: the daily note and quick add. */
export const CAPTURE_ROUTES = [
  {
    method: 'POST',
    path: '/v1/daily',
    summary: "Today's daily note, created from its template if it does not exist yet.",
  },
  { method: 'POST', path: '/v1/capture', summary: 'Capture a task, as quick capture does.' },
  { method: 'GET', path: '/v1/quick-add', summary: 'The types the add button offers.' },
  {
    method: 'POST',
    path: '/v1/quick-add',
    summary: 'Add a note of a type as the add button does: a name and a few fields.',
  },
] as const;
