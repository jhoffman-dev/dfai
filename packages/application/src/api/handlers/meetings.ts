import type { MEETING_ROUTES } from '../contract/meetings.ts';
import { meetingsRoute, receiveMeetingRoute } from '../meetings.ts';
import { type HandlerTable, vaultRoute, vaultWrite, created } from './route-handler.ts';

/** What answers each route for meeting notes, and meetings sent in. */
export const MEETING_HANDLERS: HandlerTable<typeof MEETING_ROUTES> = {
  'GET /v1/meetings': vaultRoute(meetingsRoute),
  'POST /v1/meetings': vaultWrite(receiveMeetingRoute, created),
};
