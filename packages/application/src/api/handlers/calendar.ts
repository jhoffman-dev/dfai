import type { CALENDAR_ROUTES } from '../contract/calendar.ts';
import { dayMeetingsRoute } from '../day-meetings.ts';
import { type HandlerTable, vaultRoute } from './route-handler.ts';

/** What answers each route for a day's meetings from Google Calendar. */
export const CALENDAR_HANDLERS: HandlerTable<typeof CALENDAR_ROUTES> = {
  'GET /v1/calendar/meetings': vaultRoute(dayMeetingsRoute),
};
