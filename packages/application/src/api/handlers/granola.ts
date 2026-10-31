import type { GRANOLA_ROUTES } from '../contract/granola.ts';
import { granolaStatusRoute, pullGranolaRoute } from '../granola.ts';
import { type HandlerTable, vaultRoute } from './route-handler.ts';

/** What answers each route for pulling meetings from Granola. */
export const GRANOLA_HANDLERS: HandlerTable<typeof GRANOLA_ROUTES> = {
  'GET /v1/granola': vaultRoute(granolaStatusRoute),
  // The puller says what it wrote in the vault's Activity itself, as a source refresh does.
  'POST /v1/granola/pull': vaultRoute(pullGranolaRoute),
};
