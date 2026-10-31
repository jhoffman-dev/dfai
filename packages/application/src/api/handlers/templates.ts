import type { TEMPLATE_ROUTES } from '../contract/templates.ts';
import { templateRoute, templatesRoute } from '../templates.ts';
import { type HandlerTable, vaultRoute } from './route-handler.ts';

/** What answers each route for templates. */
export const TEMPLATE_HANDLERS: HandlerTable<typeof TEMPLATE_ROUTES> = {
  'GET /v1/templates': vaultRoute(templatesRoute),
  'GET /v1/templates/{name}': vaultRoute(templateRoute),
};
