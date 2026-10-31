import type { SOURCE_ROUTES } from '../contract/sources.ts';
import { refreshSourceRoute } from '../sources.ts';
import { type HandlerTable, vaultRoute } from './route-handler.ts';

/** What answers each route for refreshing a source note. */
export const SOURCE_HANDLERS: HandlerTable<typeof SOURCE_ROUTES> = {
  'POST /v1/sources/{path}/refresh': vaultRoute(refreshSourceRoute),
};
