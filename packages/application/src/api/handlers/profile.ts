import type { PROFILE_ROUTES } from '../contract/profile.ts';
import { profileRoute } from '../profile.ts';
import { type HandlerTable, vaultRoute } from './route-handler.ts';

/** What answers each route for the vault owner's profile. */
export const PROFILE_HANDLERS: HandlerTable<typeof PROFILE_ROUTES> = {
  'GET /v1/profile': vaultRoute(profileRoute),
};
