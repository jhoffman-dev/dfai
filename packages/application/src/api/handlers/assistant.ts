import type { ASSISTANT_ROUTES } from '../contract/assistant.ts';
import { makeDashboardRoute, proposeTasksRoute } from '../assistant-proposals.ts';
import { assistantMeetingsRoute, briefRoute, openLoopsRoute } from '../assistant.ts';
import { type HandlerTable, vaultRoute, vaultWrite } from './route-handler.ts';

/** What answers each route for the assistant's briefs, open loops and proposals. */
export const ASSISTANT_HANDLERS: HandlerTable<typeof ASSISTANT_ROUTES> = {
  'GET /v1/assistant/brief': vaultRoute(briefRoute),
  'GET /v1/assistant/open-loops': vaultRoute(openLoopsRoute),
  'GET /v1/assistant/meetings': vaultRoute(assistantMeetingsRoute),
  'POST /v1/assistant/propose-tasks': vaultWrite(proposeTasksRoute),
  'POST /v1/assistant/make-dashboard': vaultWrite(makeDashboardRoute, (answer) =>
    'proposedSpec' in answer.body ? answer.body.proposedSpec.proposal !== null : false,
  ),
};
