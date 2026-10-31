import type { TASK_ROUTES } from '../contract/tasks.ts';
import { scheduleTaskRoute } from '../schedule-task.ts';
import { type HandlerTable, vaultWrite } from './route-handler.ts';

/** What answers each route for scheduling a task on the calendar. */
export const TASK_HANDLERS: HandlerTable<typeof TASK_ROUTES> = {
  'POST /v1/tasks/schedule': vaultWrite(scheduleTaskRoute),
};
