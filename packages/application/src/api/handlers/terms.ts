import type { TERM_ROUTES } from '../contract/terms.ts';
import { termsRoute } from '../terms.ts';
import { type HandlerTable, vaultRoute } from './route-handler.ts';

/** What answers each route for terms and the vocabulary. */
export const TERM_HANDLERS: HandlerTable<typeof TERM_ROUTES> = {
  'GET /v1/terms': vaultRoute(termsRoute),
};
