import type { CAPTURE_ROUTES } from '../contract/capture.ts';
import { captureRoute, dailyRoute } from '../daily.ts';
import { quickAddRoute, quickAddTypesRoute } from '../quick-add.ts';
import { type HandlerTable, vaultRoute, vaultWrite, created } from './route-handler.ts';

/** What answers each route for capturing in the app: the daily note and quick add. */
export const CAPTURE_HANDLERS: HandlerTable<typeof CAPTURE_ROUTES> = {
  'POST /v1/daily': vaultWrite(dailyRoute, created),
  'POST /v1/capture': vaultWrite(captureRoute),
  'GET /v1/quick-add': vaultRoute(quickAddTypesRoute),
  'POST /v1/quick-add': vaultWrite(quickAddRoute),
};
