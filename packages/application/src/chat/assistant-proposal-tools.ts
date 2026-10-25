import type { ModelToolSpec, ToolCall, ToolResult } from '@dfai/domain';
import { routeApiRequest, type ApiRouterDeps } from '../api/index.ts';
import { cappedJson } from './capped-json.ts';
import { TOOL_RESULT_CHARACTERS } from './read-tools.ts';

/**
 * The chat's two drafting tools (P32-05): `propose_tasks` and
 * `make_dashboard`. Each is one request to the local API's router, answered
 * in-process by the routes an MCP client reaches as `atlas_propose_tasks`
 * and `atlas_make_dashboard`. Both leave proposals in the Inbox and write
 * nothing else: the person accepts them there. Not on a rule's Claude step:
 * an unattended step reads only.
 */

const IN_THE_INBOX =
  'It leaves proposals in the Inbox, for the person to accept or reject there; nothing else ' +
  'is written, so do not say it was made.';

const SPEC_SCHEMA = {
  type: 'object',
  description:
    'Either { kind: "dashboard", name, description?, widgets: [...] } or { kind: "view", name, ' +
    'type, layout }. A widget is { kind, title?, type, groupBy?, filters?, span? } — kind one of ' +
    'number, hero, list, table, bar, donut, line, rank (counting notes of a type) or sql ' +
    '({ sql, show }) or query ({ query }, a DFAI query); bar, donut, line and rank need groupBy. ' +
    'A filter is { key, operator, value }. A view layout is table, board, list, gallery, feed, ' +
    'calendar or timeline.',
};

export const ASSISTANT_PROPOSAL_SPECS: readonly ModelToolSpec[] = [
  {
    name: 'propose_tasks',
    description:
      "Draft a meeting's action items — the person's own tasks, what they wait on from others, " +
      'decisions and follow-ups — each citing the transcript turn it came from. Asking again ' +
      `about the same meeting proposes nothing twice. ${IN_THE_INBOX}`,
    inputSchema: {
      type: 'object',
      properties: {
        meeting: { type: 'string', description: "The meeting note's vault path, with .md." },
      },
      required: ['meeting'],
      additionalProperties: false,
    },
  },
  {
    name: 'make_dashboard',
    description:
      'Propose a dashboard or a saved view. The spec is checked as the app checks one: a spec ' +
      'that does not pass comes back with each problem, where it is and why — fix them and ' +
      'try again. Read the types first (atlas_list_types) so every type and property named ' +
      `is one the vault has. ${IN_THE_INBOX}`,
    inputSchema: {
      type: 'object',
      properties: { spec: SPEC_SCHEMA },
      required: ['spec'],
      additionalProperties: false,
    },
  },
];

const ROUTES: Readonly<Record<string, string>> = {
  propose_tasks: '/v1/assistant/propose-tasks',
  make_dashboard: '/v1/assistant/make-dashboard',
};

export function isAssistantProposalTool(name: string): boolean {
  return name in ROUTES;
}

/**
 * Runs one of the two through the router, as the MCP server's call would. A
 * refusal is a result the model can read and act on — a spec's problems are
 * handed over whole, each where it is.
 */
export async function runAssistantProposalTool({
  call,
  api,
  requestId,
}: {
  call: ToolCall;
  api: ApiRouterDeps;
  requestId: string;
}): Promise<ToolResult> {
  const path = ROUTES[call.name];
  if (path === undefined) {
    return {
      callId: call.id,
      name: call.name,
      content: `There is no tool "${call.name}".`,
      isError: true,
    };
  }
  const response = await routeApiRequest(
    { id: requestId, method: 'POST', path, query: {}, body: call.input },
    api,
  );
  return {
    callId: call.id,
    name: call.name,
    content: cappedJson(response.body, TOOL_RESULT_CHARACTERS),
    isError: response.status >= 400,
  };
}
