import type { TYPE_ROUTES } from '../contract/types.ts';
import { typeViewsRoute } from '../type-views.ts';
import { typesRoute } from '../types.ts';
import { type HandlerTable, vaultRoute } from './route-handler.ts';

/** What answers each route for object types and their views. */
export const TYPE_HANDLERS: HandlerTable<typeof TYPE_ROUTES> = {
  'GET /v1/types': vaultRoute(typesRoute),
  'GET /v1/types/{name}/views': vaultRoute(typeViewsRoute),
};
