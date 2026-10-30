import { MAP_MEETING_NODE } from './code-node.ts';
import { BRANCH_NODES, githubBranch } from './github-branch.ts';
import { FETCH_NOTE_NODE } from './granola-code-node.ts';
import { codeNode, ERROR_OUTPUT, ifNode, to, type Position } from './n8n-nodes.ts';

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

/**
 * How long the fetch may take. Granola has its answer by then (it is sent
 * before the fetch); this bounds how long a run can hang on Granola's API.
 */
export const FETCH_TIMEOUT_MS = 10_000;

export const GRANOLA_NODES = {
  webhook: 'Granola webhook',
  verify: 'Verify Granola signature',
  signed: 'Signed by Granola?',
  refuse: 'Answer 401: not signed by Granola',
  verifyFailed: 'Answer 200: email why it cannot be read',
  fetch: FETCH_NOTE_NODE,
  accepted: 'Answer 200: signature verified',
  found: 'Granola sent the note?',
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
 * `GET /v1/notes/{id}?include=transcript`, for the id the verified webhook
 * named. Every answer comes out of the first output with its status (never
 * an error), so "Granola sent the note?" can tell a note from the rest; only
 * a timeout or a network failure leaves by the second.
 * No redirect is followed: the key goes to Granola's API and nowhere else.
 */
function fetchNode() {
  return {
    id: granolaId('1004'),
    name: N.fetch,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [880, 0],
    parameters: {
      method: 'GET',
      url: `=${GRANOLA_API}/v1/notes/{{ $('${N.verify}').item.json.noteId }}`,
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

interface AnswerSpec {
  readonly name: string;
  readonly serial: string;
  readonly responseCode: 200 | 401;
  readonly position: Position;
}

/** Answers Granola's request; the run goes on past it. */
function answerNode({ name, serial, responseCode, position }: AnswerSpec) {
  return {
    id: granolaId(serial),
    name,
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: 1.1,
    position,
    parameters: { respondWith: 'noData', options: { responseCode } },
  };
}

/** Did the check pass? A refusal is `signed: false`, out of the verify node's first output. */
const signedNode = () =>
  ifNode({
    name: N.signed,
    id: granolaId('100b'),
    position: [440, 0],
    conditionId: granolaId('c00b'),
    leftValue: '={{ $json.signed }}',
    rightValue: '',
    operator: { type: 'boolean', operation: 'true', singleValue: true },
  });

interface StatusSpec {
  readonly name: string;
  readonly serial: string;
  readonly status: number;
  readonly position: Position;
}

/** An If node on the fetch's status: true when Granola answered `status`. */
const statusIs = ({ name, serial, status, position }: StatusSpec) =>
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
const BRANCH_SHIFT = 1100;

const CONNECTIONS = {
  [N.webhook]: { main: [to(N.verify)] },
  [N.verify]: { main: [to(N.signed), to(N.verifyFailed)] },
  [N.signed]: { main: [to(N.accepted), to(N.refuse)] },
  [N.verifyFailed]: { main: [to(N.failed), to(N.failed)] },
  [N.accepted]: { main: [to(N.fetch)] },
  [N.fetch]: { main: [to(N.found), to(N.failed)] },
  [N.found]: { main: [to(N.map), to(N.failed)] },
  [N.map]: { main: [to(N.getPath), to(N.failed)] },
};

/**
 * The whole workflow. Its answers to Granola (ADR-0034): `401` to a delivery
 * not signed with the secret (Granola does not retry a 4xx), in silence; `200`
 * the moment the signature holds, before the fetch, well inside Granola's 15
 * seconds. A signed body that names no note, and any fault in the verify node
 * (no raw body), are answered `200` and emailed: they leave by its error
 * output, which cannot tell them apart, and neither is worth a retry. Every later failure — any Granola status but 200 (a 404 too: the
 * note is gone or still processing), a timeout, a note the mapper refuses, a
 * GitHub failure — is emailed, never answered: the pull catches the meeting,
 * and no answer of ours spends Granola's four-day retry budget.
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
      signedNode(),
      answerNode({ name: N.refuse, serial: '1003', responseCode: 401, position: [660, 160] }),
      answerNode({ name: N.accepted, serial: '1008', responseCode: 200, position: [660, 0] }),
      {
        ...answerNode({
          name: N.verifyFailed,
          serial: '1009',
          responseCode: 200,
          position: [440, 240],
        }),
        ...ERROR_OUTPUT,
      },
      fetchNode(),
      statusIs({ name: N.found, serial: '1005', status: 200, position: [1100, 0] }),
      codeNode({ name: N.map, id: granolaId('100a'), jsCode: scripts.map, position: [1320, 0] }),
      ...branch.nodes,
    ],
    connections: { ...CONNECTIONS, ...branch.connections },
    settings: { executionOrder: 'v1' },
  };
}
