import type { STATUS_ROUTES } from '../contract/status.ts';
import { statusRoute } from '../status.ts';
import { type HandlerTable } from './route-handler.ts';

/** What answers each route for what DFAI has open. */
export const STATUS_HANDLERS: HandlerTable<typeof STATUS_ROUTES> = {
  'GET /v1/status': { needsVault: false, handle: statusRoute },
};
