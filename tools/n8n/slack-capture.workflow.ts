import { codeNode, endNode, ERROR_OUTPUT, ifNode, to, type Position } from './n8n-nodes.ts';
import { THREAD_LIMIT } from '../../packages/domain/src/capture/slack/slack-answers.ts';
import { SCRIPT_NODES, type ReplyOutcome } from './slack-code-node.ts';
import { GITHUB_CREDENTIAL, GMAIL_CREDENTIAL, NOTIFY_TO, VAULT_REPO } from './workflow.ts';

/*
 * The Slack capture workflow (#104, ADR-0049): a message shortcut or an
 * emoji reaction reaches n8n, which checks Slack's signature, answers at
 * once, fetches the message, its thread and its people, and sends the
 * capture to DFAI's `POST /v1/captures`. When DFAI does not take it — closed,
 * asleep, or another n8n than the Mac's — n8n maps it with the app's own
 * mapper and commits the file to pkm-space, once. Either way James is told
 * in Slack, and a failure is emailed too.
 */

/** Slack's Web API, the only Slack host the fetches talk to. */
export const SLACK_API = 'https://slack.com/api';

/** The n8n Header Auth credential for reading (`Authorization: Bearer xoxp-…`), by name only. */
export const SLACK_USER_CREDENTIAL = 'Slack user token (DFAI capture)';

/** The n8n Header Auth credential for the replies (`Authorization: Bearer xoxb-…`), by name only. */
export const SLACK_BOT_CREDENTIAL = 'Slack bot token (DFAI capture)';

/** The n8n Bearer Auth credential for DFAI's local API (README, "API destination"). */
export const DFAI_API_CREDENTIAL = 'DFAI local API';

/** Where DFAI listens, seen from n8n's Docker; James puts Settings → Connections' port in. */
export const DFAI_PORT_PLACEHOLDER = 'DFAI_PORT';

/** The production URL is `https://<your n8n>/webhook/` and this, for events and shortcuts both. */
export const WEBHOOK_PATH = 'slack-to-dfai';

/** How long each Slack or GitHub call may take; Slack has had its answer long before. */
export const FETCH_TIMEOUT_MS = 10_000;

export const SLACK_NODES = {
  webhook: 'Slack request',
  ...SCRIPT_NODES,
  signed: 'Signed by Slack?',
  refuse: 'Answer 401: not signed by Slack',
  unreadable: 'Answer 200: email why it cannot be read',
  isChallenge: 'Slack checking the URL?',
  challenge: 'Answer 200: the challenge',
  isCapture: 'A message to save?',
  ignore: 'Answer 200: nothing to save',
  accepted: 'Answer 200: saving it',
  lookUp: 'Who is in it?',
  names: 'Look up names',
  sent: 'DFAI took it?',
  list: 'List Inbox/Captures',
  held: 'Already in pkm-space?',
  commit: 'Commit capture file',
  replySaved: 'Reply: saved by DFAI',
  replyCommitted: 'Reply: committed to pkm-space',
  replyHeld: 'Reply: already in pkm-space',
  replyFailed: 'Reply: not saved',
  failed: 'Capture failed',
  tell: 'Tell me in Slack',
  told: 'Slack took the reply?',
  notify: 'Email me: Slack message not in DFAI',
} as const;

const N = SLACK_NODES;

/** Node ids in this workflow: `c4e8a1f6-<serial>-…`, apart from the other workflows'. */
const slackId = (serial: string) => `c4e8a1f6-${serial}-4b7d-9a2e-6f1c3b5d7e08`;

function webhookNode() {
  return {
    id: slackId('2001'),
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
    webhookId: slackId('2000'),
  };
}

interface AnswerSpec {
  readonly name: string;
  readonly serial: string;
  readonly responseCode: 200 | 401;
  readonly position: Position;
  /** The URL check's answer is the challenge, as text; every other answer is empty. */
  readonly challenge?: boolean;
}

/** Answers Slack's request; the run goes on past it. */
function answerNode({ name, serial, responseCode, position, challenge }: AnswerSpec) {
  return {
    id: slackId(serial),
    name,
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: 1.1,
    position,
    parameters: challenge
      ? { respondWith: 'text', responseBody: '={{ $json.challenge }}', options: { responseCode } }
      : { respondWith: 'noData', options: { responseCode } },
  };
}

interface IfSpec {
  readonly name: string;
  readonly serial: string;
  readonly position: Position;
  readonly leftValue: string;
}

/** An If node that holds when `leftValue` is true. */
const isTrue = ({ name, serial, position, leftValue }: IfSpec) =>
  ifNode({
    name,
    id: slackId(serial),
    position,
    conditionId: slackId(`c${serial.slice(1)}`),
    leftValue,
    rightValue: '',
    operator: { type: 'boolean', operation: 'true', singleValue: true },
  });

interface SlackCallSpec {
  readonly name: string;
  readonly serial: string;
  readonly position: Position;
  readonly method: string;
  readonly query: readonly { readonly name: string; readonly value: string }[];
  readonly batched?: boolean;
}

/**
 * A Slack Web API read with James's user token. Slack answers `ok: false`
 * with a 200, which the next Code node refuses; a 429 or a timeout is
 * retried, then leaves by the error output. No redirect is followed: the
 * token goes to Slack's API and nowhere else.
 */
function slackRead({ name, serial, position, method, query, batched }: SlackCallSpec) {
  return {
    id: slackId(serial),
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position,
    parameters: {
      method: 'GET',
      url: `${SLACK_API}/${method}`,
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendQuery: true,
      queryParameters: { parameters: query },
      options: {
        ...(batched ? { batching: { batch: { batchSize: 10, batchInterval: 1000 } } } : {}),
        redirect: { redirect: { followRedirects: false } },
        timeout: FETCH_TIMEOUT_MS,
      },
    },
    credentials: { httpHeaderAuth: { name: SLACK_USER_CREDENTIAL } },
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 2000,
    ...ERROR_OUTPUT,
  };
}

const fromVerify = (field: string) => `={{ $('${N.verify}').first().json.${field} }}`;

function slackReads() {
  return [
    slackRead({
      name: N.permalink,
      serial: '2010',
      position: [1100, 0],
      method: 'chat.getPermalink',
      query: [
        { name: 'channel', value: fromVerify('channel') },
        { name: 'message_ts', value: fromVerify('ts') },
      ],
    }),
    slackRead({
      name: N.thread,
      serial: '2011',
      position: [1320, 0],
      method: 'conversations.replies',
      query: [
        { name: 'channel', value: fromVerify('channel') },
        { name: 'ts', value: fromVerify('ts') },
        { name: 'limit', value: String(THREAD_LIMIT) },
      ],
    }),
    {
      ...slackRead({
        name: N.names,
        serial: '2013',
        position: [1760, 0],
        method: 'users.info',
        query: [{ name: 'user', value: '={{ $json.userId }}' }],
        batched: true,
      }),
      // One item per person: a failed lookup must not split the run into "saved" and "not
      // saved". Its error stays an item, and "Build the capture" names that person by id.
      onError: 'continueRegularOutput',
    },
  ];
}

/**
 * `POST /v1/captures` on the Mac n8n's Docker runs on (README, "API
 * destination"). Every answer comes out of the first output with its
 * status; no answer after three tries — DFAI closed, a placeholder port, an
 * n8n that is not on the Mac — leaves by the second, to the commit.
 */
function sendNode() {
  return {
    id: slackId('2015'),
    name: N.send,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [2200, 0],
    parameters: {
      method: 'POST',
      url: `http://host.docker.internal:${DFAI_PORT_PLACEHOLDER}/v1/captures`,
      authentication: 'genericCredentialType',
      genericAuthType: 'httpBearerAuth',
      sendHeaders: true,
      headerParameters: {
        parameters: [{ name: 'Host', value: `127.0.0.1:${DFAI_PORT_PLACEHOLDER}` }],
      },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ $json }}',
      options: {
        redirect: { redirect: { followRedirects: false } },
        response: { response: { fullResponse: true, neverError: true } },
        timeout: FETCH_TIMEOUT_MS,
      },
    },
    credentials: { httpBearerAuth: { name: DFAI_API_CREDENTIAL } },
    // A slow DFAI that wrote the note answers in-vault on a retry; only after the last does it commit.
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 2000,
    ...ERROR_OUTPUT,
  };
}

/** The GitHub contents API's listing of `Inbox/Captures/`; a 404 (no folder yet) is an answer too. */
function listNode() {
  return {
    id: slackId('2017'),
    name: N.list,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [2420, 160],
    parameters: {
      method: 'GET',
      url: `https://api.github.com/repos/${VAULT_REPO.owner}/${VAULT_REPO.repository}/contents/Inbox/Captures`,
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'githubApi',
      options: {
        response: { response: { fullResponse: true, neverError: true } },
        timeout: FETCH_TIMEOUT_MS,
      },
    },
    credentials: { githubApi: { name: GITHUB_CREDENTIAL } },
    ...ERROR_OUTPUT,
  };
}

const mapped = (field: string) => `={{ $('${N.map}').first().json.${field} }}`;
const locator = (value: string) => ({ __rl: true, value, mode: 'name' });

/** Commit the mapped file at its path; a path taken since the listing fails, never overwrites. */
function commitNode() {
  return {
    id: slackId('201a'),
    name: N.commit,
    type: 'n8n-nodes-base.github',
    typeVersion: 1.1,
    position: [3080, 240],
    parameters: {
      resource: 'file',
      owner: locator(VAULT_REPO.owner),
      repository: locator(VAULT_REPO.repository),
      operation: 'create',
      filePath: mapped('path'),
      fileContent: mapped('content'),
      commitMessage: mapped('commitMessage'),
      additionalParameters: {},
    },
    credentials: { githubApi: { name: GITHUB_CREDENTIAL } },
    ...ERROR_OUTPUT,
  };
}

/** `chat.postMessage` to James's member id: the bot's DM with him, wherever the message was. */
function tellNode() {
  return {
    id: slackId('2020'),
    name: N.tell,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [3520, 0],
    parameters: {
      method: 'POST',
      url: `${SLACK_API}/chat.postMessage`,
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ { channel: $json.channel, text: $json.text } }}',
      options: { redirect: { redirect: { followRedirects: false } }, timeout: FETCH_TIMEOUT_MS },
    },
    credentials: { httpHeaderAuth: { name: SLACK_BOT_CREDENTIAL } },
    ...ERROR_OUTPUT,
  };
}

/**
 * An n8n expression's value as one line of the email: every control
 * character (CR, LF, tab, NUL, C1, the Unicode line and paragraph
 * separators) as a space, so no value — a title, an error — can forge
 * another line. One that cannot be read (a node that never ran) is empty
 * rather than failing the email. (PR #617's `emailValue`, the same rule.)
 */
export function emailValue(expression: string): string {
  return `{{ (() => { try { return String(${expression} ?? ''); } catch (error) { return ''; } })().replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]+/g, ' ') }}`;
}

const WHY = emailValue(
  'typeof $json.error === "string" ? $json.error : JSON.stringify($json.error ?? $json)',
);

/** An email to James when a Slack message did not reach DFAI, or he could not be told. */
function notifyNode() {
  return {
    id: slackId('2023'),
    name: N.notify,
    type: 'n8n-nodes-base.gmail',
    typeVersion: 2.1,
    position: [3960, 240],
    parameters: {
      resource: 'message',
      operation: 'send',
      sendTo: NOTIFY_TO,
      subject: '=DFAI did not get a Slack message',
      emailType: 'text',
      message: [
        `=A Slack message did not reach DFAI, or Slack was not told: ${WHY}`,
        '',
        `Channel: ${emailValue(`$('${N.verify}').first().json.channel`)}`,
        `Message ts: ${emailValue(`$('${N.verify}').first().json.ts`)}`,
        `Execution: ${emailValue('$workflow.name')} #${emailValue('$execution.id')}`,
      ].join('\n'),
      options: { appendAttribution: false },
    },
    credentials: { gmailOAuth2: { name: GMAIL_CREDENTIAL } },
    // At most one email per run, however many items reach it.
    executeOnce: true,
    ...ERROR_OUTPUT,
  };
}

/** The workflow's scripts, compiled by slack-code-node.ts. */
export interface SlackScripts {
  readonly verify: string;
  readonly lookUp: string;
  readonly build: string;
  readonly map: string;
  readonly replies: Readonly<Record<ReplyOutcome, string>>;
}

function answers() {
  return [
    answerNode({ name: N.refuse, serial: '2003', responseCode: 401, position: [660, 200] }),
    {
      ...answerNode({
        name: N.unreadable,
        serial: '2004',
        responseCode: 200,
        position: [440, 360],
      }),
      ...ERROR_OUTPUT,
    },
    answerNode({
      name: N.challenge,
      serial: '2006',
      responseCode: 200,
      position: [880, -200],
      challenge: true,
    }),
    answerNode({ name: N.ignore, serial: '2008', responseCode: 200, position: [1100, 200] }),
    answerNode({ name: N.accepted, serial: '2009', responseCode: 200, position: [880, 0] }),
  ];
}

function decisions() {
  return [
    isTrue({
      name: N.signed,
      serial: '2002',
      position: [440, 0],
      leftValue: '={{ $json.signed }}',
    }),
    isTrue({
      name: N.isChallenge,
      serial: '2005',
      position: [660, 0],
      leftValue: "={{ $json.action === 'challenge' }}",
    }),
    isTrue({
      name: N.isCapture,
      serial: '2007',
      position: [660, 100],
      leftValue: "={{ $json.action === 'capture' }}",
    }),
    isTrue({
      name: N.sent,
      serial: '2016',
      position: [2420, 0],
      leftValue: '={{ $json.statusCode === 200 || $json.statusCode === 201 }}',
    }),
    isTrue({
      name: N.held,
      serial: '2019',
      position: [2860, 160],
      leftValue: '={{ $json.held !== null }}',
    }),
    isTrue({
      name: N.told,
      serial: '2021',
      position: [3740, 0],
      leftValue: '={{ $json.ok === true }}',
    }),
  ];
}

function scriptNodes(scripts: SlackScripts) {
  const all = 'runOnceForAllItems' as const;
  const reply = (name: string, serial: string, outcome: ReplyOutcome, y: number) =>
    codeNode({
      name,
      id: slackId(serial),
      jsCode: scripts.replies[outcome],
      position: [3300, y],
      mode: all,
    });
  return [
    codeNode({
      name: N.verify,
      id: slackId('200a'),
      jsCode: scripts.verify,
      position: [220, 0],
      mode: all,
    }),
    codeNode({
      name: N.lookUp,
      id: slackId('2012'),
      jsCode: scripts.lookUp,
      position: [1540, 0],
      mode: all,
    }),
    codeNode({
      name: N.build,
      id: slackId('2014'),
      jsCode: scripts.build,
      position: [1980, 0],
      mode: all,
    }),
    codeNode({
      name: N.map,
      id: slackId('2018'),
      jsCode: scripts.map,
      position: [2640, 160],
      mode: all,
    }),
    reply(N.replySaved, '201b', 'saved', -160),
    reply(N.replyCommitted, '201c', 'committed', 240),
    reply(N.replyHeld, '201d', 'held', 80),
    reply(N.replyFailed, '201e', 'failed', 400),
  ];
}

const CONNECTIONS = {
  [N.webhook]: { main: [to(N.verify)] },
  [N.verify]: { main: [to(N.signed), to(N.unreadable)] },
  [N.signed]: { main: [to(N.isChallenge), to(N.refuse)] },
  [N.unreadable]: { main: [to(N.notify), to(N.notify)] },
  [N.isChallenge]: { main: [to(N.challenge), to(N.isCapture)] },
  [N.isCapture]: { main: [to(N.accepted), to(N.ignore)] },
  [N.accepted]: { main: [to(N.permalink)] },
  [N.permalink]: { main: [to(N.thread), to(N.failed)] },
  [N.thread]: { main: [to(N.lookUp), to(N.failed)] },
  [N.lookUp]: { main: [to(N.names), to(N.failed)] },
  [N.names]: { main: [to(N.build)] },
  [N.build]: { main: [to(N.send), to(N.failed)] },
  [N.send]: { main: [to(N.sent), to(N.list)] },
  [N.sent]: { main: [to(N.replySaved), to(N.list)] },
  [N.list]: { main: [to(N.map), to(N.failed)] },
  [N.map]: { main: [to(N.held), to(N.failed)] },
  [N.held]: { main: [to(N.replyHeld), to(N.commit)] },
  [N.commit]: { main: [to(N.replyCommitted), to(N.failed)] },
  [N.replySaved]: { main: [to(N.tell), to(N.notify)] },
  [N.replyCommitted]: { main: [to(N.tell), to(N.notify)] },
  [N.replyHeld]: { main: [to(N.tell), to(N.notify)] },
  [N.replyFailed]: { main: [to(N.tell), to(N.notify)] },
  [N.failed]: { main: [to(N.notify, N.replyFailed)] },
  [N.tell]: { main: [to(N.told), to(N.notify)] },
  [N.told]: { main: [[], to(N.notify)] },
};

/**
 * The whole workflow. Its answers to Slack: `401` to a request not signed
 * with the signing secret, in silence; `200` the moment the signature holds
 * — the URL check's challenge, nothing for a request that saves nothing
 * (another emoji, another person), or an empty 200 before any fetch for a
 * message to save, well inside Slack's 3 seconds. Only a request proven
 * Slack's that cannot be read (or a fault once the signature is proven) is
 * answered `200` and emailed; no raw body is a silent `401`. Every later failure is never answered: it is emailed, and James
 * is told in Slack, so a message is never lost in silence.
 */
export function slackCaptureWorkflow(scripts: SlackScripts) {
  return {
    name: 'Slack to DFAI (save a message from Slack)',
    nodes: [
      webhookNode(),
      ...scriptNodes(scripts),
      ...decisions(),
      ...answers(),
      ...slackReads(),
      sendNode(),
      listNode(),
      commitNode(),
      endNode(N.failed, slackId('201f'), [3080, 400]),
      tellNode(),
      notifyNode(),
    ],
    connections: CONNECTIONS,
    settings: { executionOrder: 'v1' },
  };
}
