import { MAP_MEETING_NODE } from './code-node.ts';
import { BRANCH_NODES, githubBranch } from './github-branch.ts';
import { FETCH_NOTE_NODE } from './granola-code-node.ts';
import { codeNode, ifNode, to, type Position } from './n8n-nodes.ts';

/*
 * The Granola webhook workflow (P28-14, ADR-0034): Granola's `note.generated`
 * reaches n8n, which checks the signature, fetches the note, maps it with the
 * app's own mapper and commits it through the same GitHub branch as the
 * Gemini workflow, so the meeting arrives while every Mac is asleep. The
 * app's pull is the safety net: a note this misses, it catches.
 */

/** Granola's public API, the only host the fetch talks to. */
export const GRANOLA_API = 'https://public-api.granola.ai';

/** The n8n Header Auth credential for the fetch (`Authorization: Bearer grn_…`), by name only. */
export const GRANOLA_API_CREDENTIAL = 'Granola API';

/** The production URL is `https://<your n8n>/webhook/` and this. */
export const WEBHOOK_PATH = 'granola-to-dfai';

/** How long the fetch may take: Granola waits 15 seconds for an answer, and the check runs first. */
export const FETCH_TIMEOUT_MS = 10_000;

export const GRANOLA_NODES = {
  webhook: 'Granola webhook',
  verify: 'Verify Granola signature',
  refuse: 'Answer 401: not signed by Granola',
  fetch: FETCH_NOTE_NODE,
  found: 'Granola sent the note?',
  processing: 'Still processing (404)?',
  retry: 'Answer 503: Granola retries',
  accepted: 'Answer 200: note fetched',
  acceptedFailing: 'Answer 200: email the failure',
  map: MAP_MEETING_NODE,
  ...BRANCH_NODES,
} as const;

const N = GRANOLA_NODES;

/** Node ids in this workflow: `b3d9f2a4-<serial>-…`, apart from the Gemini workflow's. */
const granolaId = (serial: string) => `b3d9f2a4-${serial}-4e6a-8c11-7a2b9c0d1e02`;

function webhookNode() {
  return {
    id: granolaId('1001'),
    name: N.webhook,
    type: 'n8n-nodes-base.webhook',
    typeVersion: 2,
    position: [0, 0],
    parameters: {
      httpMethod: 'POST',
      path: WEBHOOK_PATH,
      // The answer is whichever "Answer" node the run reaches.
      responseMode: 'responseNode',
      // The bytes as sent, in the `data` binary: the signature is over them.
      options: { rawBody: true },
    },
    webhookId: granolaId('1000'),
  };
}

/**
 * `GET /v1/notes/{id}?include=transcript`. Every answer comes out of the first
 * output with its status (never an error), so the If nodes can tell a 404
 * from the rest; only a timeout or a network failure leaves by the second.
 * No redirect is followed: the key goes to Granola's API and nowhere else.
 */
function fetchNode() {
  return {
    id: granolaId('1004'),
    name: N.fetch,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [440, 0],
    parameters: {
      method: 'GET',
      url: `=${GRANOLA_API}/v1/notes/{{ $json.noteId }}`,
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendQuery: true,
      queryParameters: { parameters: [{ name: 'include', value: 'transcript' }] },
      options: {
        redirect: { redirect: { followRedirects: false } },
        response: { response: { fullResponse: true, neverError: true } },
        timeout: FETCH_TIMEOUT_MS,
      },
    },
    credentials: { httpHeaderAuth: { name: GRANOLA_API_CREDENTIAL } },
    onError: 'continueErrorOutput',
  };
}

/** Answers Granola's request; the run goes on past it. */
function answerNode(name: string, serial: string, responseCode: number, position: Position) {
  return {
    id: granolaId(serial),
    name,
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: 1.1,
    position,
    parameters: { respondWith: 'noData', options: { responseCode } },
  };
}

const statusIs = (name: string, serial: string, status: number, position: Position) =>
  ifNode({
    name,
    id: granolaId(serial),
    position,
    conditionId: granolaId(`c${serial.slice(1)}`),
    leftValue: '={{ $json.statusCode }}',
    rightValue: status,
    operator: { type: 'number', operation: 'equals' },
  });

/** Where the webhook half hands over to the GitHub branch: the branch is drawn this far right. */
const BRANCH_SHIFT = 880;

const CONNECTIONS = {
  [N.webhook]: { main: [to(N.verify)] },
  [N.verify]: { main: [to(N.fetch), to(N.refuse)] },
  [N.fetch]: { main: [to(N.found), to(N.acceptedFailing)] },
  [N.found]: { main: [to(N.accepted), to(N.processing)] },
  [N.processing]: { main: [to(N.retry), to(N.acceptedFailing)] },
  [N.accepted]: { main: [to(N.map)] },
  [N.acceptedFailing]: { main: [to(N.failed)] },
  [N.map]: { main: [to(N.getPath), to(N.failed)] },
};

/**
 * The whole workflow. Its answers to Granola (ADR-0034): `401` to a delivery
 * not signed with the secret (Granola does not retry a 4xx); `503` when the
 * note is still processing (a `404`), so Granola retries it with backoff;
 * `200` for everything else, as soon as the fetch has answered. A later
 * failure — a note the mapper refuses, a GitHub failure, a Granola error
 * other than 404 — is emailed, never answered: the pull catches the meeting,
 * and no answer spends Granola's four-day retry budget on it.
 */
export function granolaWebhookWorkflow(scripts: {
  verify: string;
  map: string;
  same: string;
  sameOther: string;
}) {
  const branch = githubBranch({
    layout: { id: granolaId, shift: BRANCH_SHIFT },
    scripts,
    email: {
      title: `$('${N.fetch}').item.json.body?.title ?? 'a Granola note'`,
      sourceId: `$('${N.verify}').item.json.noteId`,
    },
  });
  return {
    name: 'Granola webhook to DFAI (commit to pkm-space)',
    nodes: [
      webhookNode(),
      codeNode({
        name: N.verify,
        id: granolaId('1002'),
        jsCode: scripts.verify,
        position: [220, 0],
        mode: 'runOnceForAllItems',
      }),
      answerNode(N.refuse, '1003', 401, [440, 160]),
      fetchNode(),
      statusIs(N.found, '1005', 200, [660, 0]),
      statusIs(N.processing, '1006', 404, [880, 160]),
      answerNode(N.retry, '1007', 503, [1100, 240]),
      answerNode(N.accepted, '1008', 200, [880, -120]),
      answerNode(N.acceptedFailing, '1009', 200, [1100, 120]),
      codeNode({ name: N.map, id: granolaId('100a'), jsCode: scripts.map, position: [1100, -120] }),
      ...branch.nodes,
    ],
    connections: { ...CONNECTIONS, ...branch.connections },
    settings: { executionOrder: 'v1' },
  };
}
