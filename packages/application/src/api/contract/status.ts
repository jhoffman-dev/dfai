/**
 * The local API's contract for what DFAI has open.
 *
 * One area of `../contract.ts`, which composes every area's routes and
 * answers. Everything here is data. No behaviour belongs in this file.
 */

export interface ApiStatus {
  readonly app: 'atlas';
  readonly version: string;
  /** The commit the running app was built from, as a short SHA; null when its build did not know. */
  readonly build: string | null;
  /** Null when no vault is open; every other route then answers `no_vault`. */
  readonly vault: { readonly name: string } | null;
  readonly index: { readonly ready: boolean; readonly notes: number };
  /**
   * Whether Google Calendar is connected for the open vault on this Mac;
   * null when no vault is open. Status only: the API never hands out a
   * Google token and makes no calendar call (ADR-0030).
   */
  readonly googleCalendar: { readonly connected: boolean } | null;
}

/** What the routes for what DFAI has open answer with. */
export type ApiStatusSuccessBody = ApiStatus;

/** The routes for what DFAI has open. */
export const STATUS_ROUTES = [
  {
    method: 'GET',
    path: '/v1/status',
    summary:
      'What DFAI has open, whether its index is ready, and whether Google Calendar is connected.',
  },
] as const;
