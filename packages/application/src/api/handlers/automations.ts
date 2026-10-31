import type { AUTOMATION_ROUTES } from '../contract/automations.ts';
import { automationDryRunRoute, automationLogRoute, automationsRoute } from '../automations.ts';
import { type HandlerTable, vaultRoute } from './route-handler.ts';

/** What answers each route for automations. */
export const AUTOMATION_HANDLERS: HandlerTable<typeof AUTOMATION_ROUTES> = {
  'GET /v1/automations': vaultRoute(automationsRoute),
  'GET /v1/automations/{id}/log': vaultRoute(automationLogRoute),
  'POST /v1/automations/{id}/dry-run': vaultRoute(automationDryRunRoute),
};
