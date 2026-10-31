import type { VIEW_ROUTES } from '../contract/views.ts';
import { calendarRoute } from '../calendar.ts';
import { addViewNoteRoute, moveCardRoute } from '../view-cards.ts';
import { runViewRoute, viewsRoute } from '../views.ts';
import { type HandlerTable, vaultRoute, vaultWrite, moved } from './route-handler.ts';

/** What answers each route for saved views, dashboards, boards and calendars. */
export const VIEW_HANDLERS: HandlerTable<typeof VIEW_ROUTES> = {
  'GET /v1/views': vaultRoute(viewsRoute),
  'POST /v1/views/{path}/run': vaultRoute(runViewRoute),
  'POST /v1/views/{path}/calendar': vaultRoute(calendarRoute),
  'POST /v1/views/{path}/move': vaultWrite(moveCardRoute, moved),
  'POST /v1/views/{path}/notes': vaultWrite(addViewNoteRoute),
};
