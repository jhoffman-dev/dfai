import type { PROPOSAL_ROUTES } from '../contract/proposals.ts';
import { acceptProposalRoute, proposalsRoute, rejectProposalRoute } from '../proposals.ts';
import { type HandlerTable, vaultRoute, vaultWrite } from './route-handler.ts';

/** What answers each route for proposals waiting in the Inbox. */
export const PROPOSAL_HANDLERS: HandlerTable<typeof PROPOSAL_ROUTES> = {
  'GET /v1/proposals': vaultRoute(proposalsRoute),
  'POST /v1/proposals/{path}/accept': vaultWrite(acceptProposalRoute),
  'POST /v1/proposals/{path}/reject': vaultWrite(rejectProposalRoute),
};
