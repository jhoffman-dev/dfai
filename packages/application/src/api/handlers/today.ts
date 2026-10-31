import type { TODAY_ROUTES } from '../contract/today.ts';
import { todayRoute } from '../review.ts';
import { taskDoneRoute } from '../task-done.ts';
import { chooseForTodayRoute } from '../today-choose.ts';
import { type HandlerTable, vaultRoute, vaultWrite } from './route-handler.ts';

/** What answers each route for the Today page: its tasks, ticking one done, and choosing for today. */
export const TODAY_HANDLERS: HandlerTable<typeof TODAY_ROUTES> = {
  'GET /v1/today': vaultRoute(todayRoute),
  'POST /v1/tasks/done': vaultWrite(taskDoneRoute),
  'POST /v1/today/choose': vaultWrite(chooseForTodayRoute),
};
