import type { QUERY_ROUTES } from '../contract/query.ts';
import { atlasQueryRoute } from '../atlas-query.ts';
import { queryRoute, sqlRoute } from '../query.ts';
import { type HandlerTable, vaultRoute } from './route-handler.ts';

/** What answers each route for queries: filters, SQL and DFAI queries. */
export const QUERY_HANDLERS: HandlerTable<typeof QUERY_ROUTES> = {
  'POST /v1/query': vaultRoute(queryRoute),
  'POST /v1/sql': vaultRoute(sqlRoute),
  'POST /v1/atlas-query': vaultRoute(atlasQueryRoute),
};
