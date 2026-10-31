import type { INBOX_ROUTES } from '../contract/inbox.ts';
import { clarifyInboxRoute } from '../inbox-clarify.ts';
import { inboxRoute, processInboxRoute } from '../inbox.ts';
import { type HandlerTable, vaultRoute, vaultWrite } from './route-handler.ts';

/** What answers each route for the Inbox and clarifying it. */
export const INBOX_HANDLERS: HandlerTable<typeof INBOX_ROUTES> = {
  'GET /v1/inbox': vaultRoute(inboxRoute),
  'POST /v1/inbox/process': vaultWrite(processInboxRoute),
  'POST /v1/inbox/clarify': vaultWrite(clarifyInboxRoute),
};
