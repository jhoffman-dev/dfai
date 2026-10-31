/**
 * The local API's contract for the vault owner's profile.
 *
 * One area of `../contract.ts`, which composes every area's routes and
 * answers. Everything here is data. No behaviour belongs in this file.
 */

/** Who uses the vault, as Settings → Profile says. */
export interface ApiProfile {
  /** The full name; null when none is set — then write `placeholder`, never a guess. */
  readonly name: string | null;
  /** What the person goes by; null when none is set. */
  readonly preferredName: string | null;
  /** What to write where the person's name belongs and none is set: `[Your name]`. */
  readonly placeholder: string;
}

/** What the routes for the vault owner's profile answer with. */
export type ApiProfileSuccessBody = { readonly profile: ApiProfile };

/** The routes for the vault owner's profile. */
export const PROFILE_ROUTES = [
  {
    method: 'GET',
    path: '/v1/profile',
    summary: "The person's name, as Settings → Profile holds it. Read only.",
  },
] as const;
