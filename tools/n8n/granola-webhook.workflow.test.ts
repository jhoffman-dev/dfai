import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mapGranolaNote } from '@dfai/domain';
import {
  mapMeetingScript,
  MAP_MEETING_NODE,
  sameMeetingAtOtherPathScript,
  sameMeetingScript,
} from './code-node.ts';
import { GITHUB_CREDENTIAL, VAULT_REPO } from './github-branch.ts';
import {
  DEFAULT_GRANOLA_OPTIONS,
  mapGranolaScript,
  SECRET_PLACEHOLDER,
  verifyGranolaScript,
} from './granola-code-node.ts';
import {
  FETCH_TIMEOUT_MS,
  GRANOLA_API,
  GRANOLA_API_CREDENTIAL,
  GRANOLA_NODES as N,
  granolaWebhookWorkflow,
  WEBHOOK_PATH,
} from './granola-webhook.workflow.ts';
import { VECTOR, VECTOR_NOW, vectorHeaders } from './standard-webhook-vector.ts';

/*
 * The Granola webhook workflow James imports into n8n (P28-14). These tests
 * hold the committed JSON to its builders, run its Code nodes as n8n would,
 * and walk its wiring for each answer Granola and GitHub can give.
 */

interface WorkflowNode {
  readonly name: string;
  readonly type: string;
  readonly parameters: Record<string, unknown>;
  readonly credentials?: Record<string, Record<string, unknown>>;
  readonly onError?: string;
}
interface Workflow {
  readonly nodes: readonly WorkflowNode[];
  readonly connections: Record<string, { main: { node: string }[][] }>;
}

const committedText = readFileSync(
  new URL('granola-webhook.workflow.json', import.meta.url),
  'utf8',
);
const committed = JSON.parse(committedText) as Workflow;
const node = (name: string) => {
  const found = committed.nodes.find((each) => each.name === name);
  if (found === undefined) throw new Error(`no node ${name}`);
  return found;
};
const jsCodeOf = (name: string) => String(node(name).parameters.jsCode);

const scripts = () => ({
  verify: verifyGranolaScript(),
  map: mapGranolaScript(),
  same: sameMeetingScript(),
  sameOther: sameMeetingAtOtherPathScript(),
});

describe('the committed workflow', () => {
  it('is what `pnpm n8n:build` makes now (rebuild after changing the mapper)', () => {
    expect(committed).toEqual(JSON.parse(JSON.stringify(granolaWebhookWorkflow(scripts()))));
  });

  it('carries no secret and no key: the placeholder, and credentials by name only', () => {
    expect(jsCodeOf(N.verify)).toContain(`const SECRET = ${JSON.stringify(SECRET_PLACEHOLDER)};`);
    expect(committedText.match(/whsec_[A-Za-z0-9+/=_]+/g)).toEqual([SECRET_PLACEHOLDER]);
    expect(committedText).not.toMatch(/grn_[A-Za-z0-9]|Bearer [A-Za-z0-9]/);
    expect(node(N.fetch).credentials).toEqual({ httpHeaderAuth: { name: GRANOLA_API_CREDENTIAL } });
  });
});

/** The path a run takes from the webhook, given which output each node leaves by. */
function walk(leave: (name: string) => number): string[] {
  const path: string[] = [];
  let at: string | undefined = N.webhook;
  while (at !== undefined) {
    expect(path, 'a loop').not.toContain(at);
    path.push(at);
    const outputs: { node: string }[][] = committed.connections[at]?.main ?? [];
    at = outputs[outputs.length === 1 ? 0 : leave(at)]?.[0]?.node;
  }
  return path;
}

/** How an If node on `$json.statusCode` leaves for a status: 0 when it holds. */
function ifStatus(name: string, status: number): number {
  const { conditions } = node(name).parameters.conditions as {
    conditions: { leftValue: string; rightValue: number; operator: { operation: string } }[];
  };
  const [only] = conditions;
  expect(only?.leftValue).toBe('={{ $json.statusCode }}');
  expect(only?.operator.operation).toBe('equals');
  return only?.rightValue === status ? 0 : 1;
}

/** Whether a node is an If on the fetch's status. */
const readsStatus = (name: string) =>
  node(name).type === 'n8n-nodes-base.if' &&
  JSON.stringify(node(name).parameters).includes('$json.statusCode');

/** A run where Granola answers `status` (or never answers), and GitHub as `github` says. */
function run(granola: number | 'no answer', github: { pathTaken: boolean; commits: boolean }) {
  return walk((name) => {
    if (name === N.fetch) return granola === 'no answer' ? 1 : 0;
    if (readsStatus(name)) return ifStatus(name, granola === 'no answer' ? 0 : granola);
    if (name === N.getPath) return github.pathTaken ? 0 : 1;
    if (name === N.create) return github.commits ? 0 : 1;
    return 0;
  });
}
const answers = (path: readonly string[]) =>
  path
    .filter((name) => node(name).type === 'n8n-nodes-base.respondToWebhook')
    .map((name) => (node(name).parameters.options as { responseCode: number }).responseCode);

const FREE = { pathTaken: false, commits: true };

describe('the wiring', () => {
  it('runs verify → fetch → map → lookup → commit for a note Granola sends', () => {
    const path = run(200, FREE);
    const order = [N.verify, N.fetch, N.map, N.getPath, N.create].map((name) => path.indexOf(name));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(path.at(-1)).toBe(N.create);
    expect(answers(path)).toEqual([200]);
    // The 200 goes as soon as the signature holds, before the fetch: Granola waits 15 seconds.
    expect(path.slice(1, 4)).toEqual([N.verify, N.signed, N.accepted]);
    expect(path.indexOf(N.accepted)).toBeLessThan(path.indexOf(N.fetch));
  });

  it('answers only 200 or 401: nothing spends Granola’s four-day retry budget (ADR-0034)', () => {
    const codes = committed.nodes
      .filter((each) => each.type === 'n8n-nodes-base.respondToWebhook')
      .map((each) => (each.parameters.options as { responseCode: number }).responseCode);
    expect(new Set(codes)).toEqual(new Set([200, 401]));
  });

  it('answers a signed body it cannot read, or a fault in the check, with 200 and the email', () => {
    const path = walk((name) => (name === N.verify ? 1 : 0));
    expect(answers(path)).toEqual([200]);
    expect(path).toEqual([N.webhook, N.verify, N.verifyFailed, N.failed, N.notify]);
    expect(node(N.verify).onError).toBe('continueErrorOutput');
  });

  it('answers a GitHub failure with 200 and the failure email', () => {
    const path = run(200, { pathTaken: false, commits: false });
    expect(answers(path)).toEqual([200]);
    expect(path.slice(-3)).toEqual([N.create, N.failed, N.notify]);
    expect(node(N.notify).type).toBe('n8n-nodes-base.gmail');
  });

  it.each([404, 401, 413, 429, 500])(
    'answers a Granola %i with 200 and the email, never a retry: the pull catches it',
    (status) => {
      const path = run(status, FREE);
      expect(answers(path)).toEqual([200]);
      expect(path.slice(-2)).toEqual([N.failed, N.notify]);
      expect(path).not.toContain(N.map);
    },
  );

  it('answers a fetch that times out with 200 and the email', () => {
    const path = run('no answer', FREE);
    expect(answers(path)).toEqual([200]);
    expect(path.slice(-2)).toEqual([N.failed, N.notify]);
  });

  it('answers a delivery the check refuses with a 401, and fetches nothing', () => {
    const path = walk((name) => (name === N.signed ? 1 : 0));
    expect(path).toEqual([N.webhook, N.verify, N.signed, N.refuse]);
    expect(answers(path)).toEqual([401]);
  });

  it('sends a note the mapper refuses to the email, after its 200', () => {
    const path = walk((name) => (name === N.map ? 1 : 0));
    expect(answers(path)).toEqual([200]);
    expect(path.slice(-3)).toEqual([N.map, N.failed, N.notify]);
  });

  it('answers exactly once on every path a run can take', () => {
    const forks = Object.entries(committed.connections)
      .filter(([, { main }]) => main.length > 1)
      .map(([name]) => name);
    // Every combination of outputs at every fork.
    for (let mask = 0; mask < 2 ** forks.length; mask += 1) {
      const path = walk((name) => (mask >> forks.indexOf(name)) & 1);
      expect(answers(path), path.join(' → ')).toHaveLength(1);
    }
  });

  it('is the Gemini workflow’s GitHub branch, node for node', () => {
    const gemini = JSON.parse(
      readFileSync(new URL('meeting-to-atlas.workflow.json', import.meta.url), 'utf8'),
    ) as Workflow;
    const branch = [N.getPath, N.same, N.ifSame, N.getCollision, N.sameOther, N.create];
    for (const name of [...branch, N.createCollision, N.skip, N.failed]) {
      expect(committed.connections[name], name).toEqual(gemini.connections[name]);
    }
    // Everything but the ids, which are each workflow's own.
    const shape = ({ type, parameters, credentials, onError }: WorkflowNode): unknown =>
      JSON.parse(
        JSON.stringify({ type, parameters, credentials, onError }, (key, value: unknown) =>
          key === 'id' ? undefined : value,
        ),
      );
    for (const name of branch) {
      const theirs = gemini.nodes.find((each) => each.name === name);
      expect(theirs, name).toBeDefined();
      expect(shape(node(name)), name).toEqual(shape(theirs as WorkflowNode));
    }
    const github = committed.nodes.filter((each) => each.type === 'n8n-nodes-base.github');
    expect(github).toHaveLength(4);
    for (const each of github) {
      expect(each.credentials).toEqual({ githubApi: { name: GITHUB_CREDENTIAL } });
      expect(each.parameters).toMatchObject({ repository: { value: VAULT_REPO.repository } });
    }
  });
});

describe('the webhook and the fetch', () => {
  it('takes the raw body, and answers from the Answer nodes', () => {
    expect(node(N.webhook).parameters).toEqual({
      httpMethod: 'POST',
      path: WEBHOOK_PATH,
      responseMode: 'responseNode',
      options: { rawBody: true },
    });
  });

  it('fetches the verified note with its transcript, from Granola’s API only, in time', () => {
    const fetch = node(N.fetch);
    expect(fetch.parameters).toMatchObject({
      method: 'GET',
      url: `=${GRANOLA_API}/v1/notes/{{ $('${N.verify}').item.json.noteId }}`,
      queryParameters: { parameters: [{ name: 'include', value: 'transcript' }] },
      options: {
        redirect: { redirect: { followRedirects: false } },
        response: { response: { fullResponse: true, neverError: true } },
      },
    });
    expect(FETCH_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
    expect(fetch.onError).toBe('continueErrorOutput');
  });
});

// --- The Code nodes, run as n8n runs them ---

const KEY = Buffer.from(VECTOR.secret.slice('whsec_'.length), 'base64');
const NOTE_BODY = '{"event":"note.generated","note_id":"not_4kTq2mWxLp4Rz7"}';
const signature = (body: string) =>
  `v1,${createHmac('sha256', KEY).update(`${VECTOR.id}.${VECTOR.timestamp}.${body}`).digest('base64')}`;

type AsyncCode = (this: unknown, $input: unknown) => Promise<{ json: unknown }[]>;
// The Code node wraps its code in an async function: `await` is allowed at the top.
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...args: string[]
) => AsyncCode;

/** The verify node run on a delivery, `this.helpers` handing over the raw body as n8n does. */
function verifyIn(jsCode: string, headers: unknown, body: string) {
  const code = new AsyncFunction('$input', jsCode);
  const helpers = {
    getBinaryDataBuffer: (index: number, property: string) => {
      expect([index, property]).toEqual([0, 'data']);
      return Promise.resolve(Buffer.from(body));
    },
  };
  const $input = { first: () => ({ json: { headers, body: JSON.parse(body) as unknown } }) };
  return code.call({ helpers }, $input);
}

describe('the verify node', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(VECTOR_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes the Standard Webhooks vector once the secret is pasted in', async () => {
    // The vector's body names no note: signed, so it leaves by the error output (200 + email).
    await expect(
      verifyIn(verifyGranolaScript(VECTOR.secret), vectorHeaders(), VECTOR.body),
    ).rejects.toThrow(
      /^signed by Granola, but body: no note_id.*it begins: \{"test": 2432232314\}$/,
    );
  });

  it('hands a signed Granola delivery’s note id on to the fetch', async () => {
    const headers = vectorHeaders({ 'webhook-signature': signature(NOTE_BODY) });
    const out = await verifyIn(verifyGranolaScript(VECTOR.secret), headers, NOTE_BODY);
    expect(out).toEqual([
      { json: { signed: true, webhookId: VECTOR.id, noteId: 'not_4kTq2mWxLp4Rz7' } },
    ]);
  });

  it('refuses a stale timestamp and a wrong secret', async () => {
    const headers = vectorHeaders({ 'webhook-signature': signature(NOTE_BODY) });
    vi.setSystemTime(VECTOR_NOW + 301_000);
    const refusal = (reason: RegExp) => [
      { json: { signed: false, reason: expect.stringMatching(reason) } },
    ];
    await expect(verifyIn(verifyGranolaScript(VECTOR.secret), headers, NOTE_BODY)).resolves.toEqual(
      refusal(/five minutes/),
    );
    vi.setSystemTime(VECTOR_NOW);
    const wrong = 'whsec_' + Buffer.from('another secret').toString('base64');
    await expect(verifyIn(verifyGranolaScript(wrong), headers, NOTE_BODY)).resolves.toEqual(
      refusal(/signature/),
    );
    const huge = `{"note_id":"not_4kTq2mWxLp4Rz7","pad":"${'x'.repeat(70_000)}"}`;
    const signedHuge = vectorHeaders({ 'webhook-signature': signature(huge) });
    await expect(verifyIn(verifyGranolaScript(VECTOR.secret), signedHuge, huge)).resolves.toEqual(
      refusal(/^body: over 65536 bytes$/),
    );
  });

  it('refuses everything as committed, until James pastes the secret in', async () => {
    const headers = vectorHeaders({ 'webhook-signature': signature(NOTE_BODY) });
    await expect(verifyIn(jsCodeOf(N.verify), headers, NOTE_BODY)).resolves.toEqual([
      { json: { signed: false, reason: expect.stringMatching(/secret is not set/) } },
    ]);
    expect(node(N.verify).parameters.mode).toBe('runOnceForAllItems');
  });
});

const fixtures = new URL('../../packages/domain/src/meetings/fixtures/granola/', import.meta.url);
const fixtureNames = readdirSync(fixtures)
  .filter((name) => name.endsWith('.json'))
  .map((name) => name.slice(0, -'.json'.length));
const noteOf = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`${name}.json`, fixtures), 'utf8'));
/** The settings the domain's goldens were written with (granola-note.test.ts). */
const GOLDEN_OPTIONS = {
  timeZone: 'America/Los_Angeles',
  selfEmails: ['Mara.Quill@example.com'],
  groupAddresses: [],
};

type MapCode = (
  json: unknown,
  $: (name: string) => { item: { json: unknown } },
) => { json: unknown };
const mapIn = (jsCode: string, note: unknown) =>
  (new Function('$json', '$', jsCode) as MapCode)({ statusCode: 200, body: note }, (name) => {
    expect(name).toBe(N.fetch);
    return { item: { json: { statusCode: 200, body: note } } };
  }).json;

describe('the map node', () => {
  const mapper = (script: string) => script.slice(0, script.indexOf('// --- n8n ---'));

  it('is the Gemini workflow’s compiled mapper, byte for byte, with Granola’s last lines', () => {
    expect(mapper(jsCodeOf(MAP_MEETING_NODE))).toBe(mapper(mapMeetingScript()));
    expect(mapper(jsCodeOf(MAP_MEETING_NODE)).length).toBeGreaterThan(10_000);
    expect(jsCodeOf(MAP_MEETING_NODE)).toContain(
      `const OPTIONS = ${JSON.stringify(DEFAULT_GRANOLA_OPTIONS)};`,
    );
  });

  it.each(fixtureNames)('writes %s byte for byte as the domain’s golden file', (name) => {
    const golden = readFileSync(new URL(`${name}.md`, fixtures), 'utf8');
    const file = mapIn(mapGranolaScript(GOLDEN_OPTIONS), noteOf(name)) as { content: string };
    expect(file.content).toBe(golden);
  });

  it.each(fixtureNames)('as committed, writes %s as the app’s pull does', (name) => {
    const note = noteOf(name);
    expect(mapIn(jsCodeOf(MAP_MEETING_NODE), note)).toEqual({
      ...mapGranolaNote(note, DEFAULT_GRANOLA_OPTIONS),
    });
  });

  it('refuses a note as the app does, out of its error output', () => {
    expect(() => mapIn(jsCodeOf(MAP_MEETING_NODE), { id: 'not_1', title: 'No time' })).toThrow(
      /no start/,
    );
    expect(node(MAP_MEETING_NODE).onError).toBe('continueErrorOutput');
  });
});

describe('the failure email', () => {
  it('names the note by its id from the verified webhook, and its title when fetched', () => {
    const message = String(node(N.notify).parameters.message);
    expect(message).toContain(`$('${N.verify}').item.json.noteId`);
    expect(String(node(N.notify).parameters.subject)).toContain(
      `$('${N.fetch}').item.json.body?.title`,
    );
  });
});
