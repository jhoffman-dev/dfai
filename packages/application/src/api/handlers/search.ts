import type { SEARCH_ROUTES } from '../contract/search.ts';
import { searchRoute } from '../search.ts';
import { type HandlerTable, vaultRoute } from './route-handler.ts';

/** What answers each route for search, by words and by meaning. */
export const SEARCH_HANDLERS: HandlerTable<typeof SEARCH_ROUTES> = {
  'GET /v1/search': vaultRoute(searchRoute),
};
