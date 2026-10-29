import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { moduleScript } from './code-node.ts';
import { verifyGranolaScript } from './granola-code-node.ts';
import { webhookNoteId } from './granola-webhook.ts';
import { GRANOLA_NODES as N } from './granola-webhook.workflow.ts';
import { hmacSha256 } from './sha256.ts';
import { verifyStandardWebhook, WebhookRefusal } from './standard-webhook.ts';
import { VECTOR, VECTOR_NOW, vectorHeaders } from './standard-webhook-vector.ts';

/*
 * Adversarial tests for PR #617 (P28-14, the Granola webhook workflow): a
 * seeded differential of the plain-JavaScript HMAC against node:crypto, under
 * Node and JavaScriptCore; the header, secret and body edges of the check; and
 * the committed workflow walked with a failure injected at each node.
 */

// --- A seeded RNG, the same in Node and in the JavaScriptCore driver ---

const MULBERRY32 = `function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function bytesFrom(next, length) {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = Math.floor(next() * 256);
  return out;
}
function hex(bytes) {
  let text = '';
  for (const byte of bytes) text += (byte < 16 ? '0' : '') + byte.toString(16);
  return text;
}`;

const { mulberry32, bytesFrom, hex } = new Function(
  `${MULBERRY32}\nreturn { mulberry32, bytesFrom, hex };`,
)() as {
  mulberry32: (seed: number) => () => number;
  bytesFrom: (next: () => number, length: number) => Uint8Array;
  hex: (bytes: Uint8Array) => string;
};

/** One differential case: a key and a message length, drawn from the seed. */
interface HmacCase {
  readonly seed: number;
  readonly keyLength: number;
  readonly messageLength: number;
}

const EDGES = [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 121, 127, 128];

function hmacCases(): HmacCase[] {
  const next = mulberry32(0x617);
  const cases: HmacCase[] = [];
  for (const keyLength of [0, 1, 32, 63, 64, 65, 128, 200]) {
    for (const messageLength of EDGES)
      cases.push({ seed: cases.length + 1, keyLength, messageLength });
  }
  for (let i = 0; i < 40; i += 1) {
    cases.push({
      seed: 1000 + i,
      keyLength: Math.floor(next() * 201),
      messageLength: i < 4 ? 100_000 - i : Math.floor(next() * 100_001),
    });
  }
  return cases;
}

const keyAndMessage = ({ seed, keyLength, messageLength }: HmacCase) => {
  const next = mulberry32(seed);
  return { key: bytesFrom(next, keyLength), message: bytesFrom(next, messageLength) };
};

const nodeHmac = (key: Uint8Array, message: Uint8Array) =>
  createHmac('sha256', key).update(message).digest('hex');

describe('HMAC-SHA256 against node:crypto, seeded', () => {
  it('matches node:crypto for every seeded key (0–200 bytes) and message (0–100k bytes)', () => {
    const wrong = hmacCases().filter((each) => {
      const { key, message } = keyAndMessage(each);
      return hex(hmacSha256(key, message)) !== nodeHmac(key, message);
    });
    expect(wrong).toEqual([]);
  });

  it('is deterministic: the same seed twice gives the same key, message and digest', () => {
    const [first] = hmacCases().slice(-1);
    if (first === undefined) throw new Error('no case');
    const a = keyAndMessage(first);
    const b = keyAndMessage(first);
    expect(hex(hmacSha256(a.key, a.message))).toBe(hex(hmacSha256(b.key, b.message)));
  });
});

const JSC = '/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc';

describe.skipIf(!existsSync(JSC))('HMAC-SHA256 against node:crypto under JavaScriptCore', () => {
  it('gives node:crypto’s digest for every seeded case, in an engine with no crypto', () => {
    const cases = hmacCases();
    const dir = mkdtempSync(join(tmpdir(), 'atlas-jsc-attack-'));
    const driver = [
      MULBERRY32,
      moduleScript('./sha256.ts'),
      `const cases = ${JSON.stringify(cases)};`,
      'print(JSON.stringify(cases.map((c) => { const next = mulberry32(c.seed);',
      '  const key = bytesFrom(next, c.keyLength); const message = bytesFrom(next, c.messageLength);',
      '  return hex(hmacSha256(key, message)); })));',
    ].join('\n');
    try {
      writeFileSync(join(dir, 'driver.js'), driver);
      const digests = JSON.parse(
        execFileSync(JSC, [join(dir, 'driver.js')], { encoding: 'utf8', maxBuffer: 1 << 24 }),
      ) as string[];
      const expected = cases.map((each) => {
        const { key, message } = keyAndMessage(each);
        return nodeHmac(key, message);
      });
      expect(digests).toEqual(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});

// --- The header, secret and body edges of the check ---

const KEY = Buffer.from(VECTOR.secret.slice('whsec_'.length), 'base64');
const sign = (id: string, timestamp: string, body: string) =>
  createHmac('sha256', KEY).update(`${id}.${timestamp}.${body}`).digest('base64');
const GOOD = `v1,${sign(VECTOR.id, VECTOR.timestamp, VECTOR.body)}`;
const verify = (headers: unknown, secret: string = VECTOR.secret, now = VECTOR_NOW) =>
  verifyStandardWebhook({ headers, body: Buffer.from(VECTOR.body) }, { secret, now });
const refused = (run: () => unknown) => expect(run).toThrow(WebhookRefusal);

describe('the webhook-signature header', () => {
  it.each([
    ['several, the good one last', `v1,AAAA v1,${'B'.repeat(43)}= ${GOOD}`],
    ['doubled spaces and an empty entry', `  v1,AAAA   ${GOOD}  `],
    ['a v1a entry before it', `v1a,${GOOD.slice(3)} ${GOOD}`],
    ['a v1 entry with bad base64 before it', `v1,***notbase64*** ${GOOD}`],
  ])('passes with %s', (_, signature) => {
    expect(verify(vectorHeaders({ 'webhook-signature': signature }))).toBe(VECTOR.id);
  });

  it.each([
    ['tab-separated', `v1,AAAA\t${GOOD}`],
    ['the good digest under v1a only', `v1a,${GOOD.slice(3)}`],
    ['the good digest with no scheme', GOOD.slice(3)],
    ['`v1,` alone', 'v1,'],
    ['the good digest in upper case', `v1,${GOOD.slice(3).toUpperCase()}`],
    ['the good digest truncated by one', GOOD.slice(0, -1)],
    ['the good digest with one more character', `${GOOD}A`],
    ['empty', ''],
    ['a huge header of junk entries', `${'v1,AAAA '.repeat(20_000)}`],
  ])('refuses %s', (_, signature) => {
    refused(() => verify(vectorHeaders({ 'webhook-signature': signature })));
  });

  it('refuses a header that is not a string (an array of signatures)', () => {
    refused(() => verify({ ...vectorHeaders(), 'webhook-signature': [GOOD] }));
  });

  it('refuses headers whose names are not lower case, as n8n never hands them over', () => {
    refused(() =>
      verify({
        'Webhook-Id': VECTOR.id,
        'Webhook-Timestamp': VECTOR.timestamp,
        'Webhook-Signature': GOOD,
      }),
    );
  });
});

describe('the webhook-id and webhook-timestamp headers', () => {
  it.each([['webhook-id'], ['webhook-timestamp'], ['webhook-signature']])(
    'refuses a delivery missing %s',
    (name) => {
      const headers: Record<string, string> = vectorHeaders();
      delete headers[name];
      refused(() => verify(headers));
    },
  );

  it.each([
    ['a leading +', `+${VECTOR.timestamp}`],
    ['a minus sign', `-${VECTOR.timestamp}`],
    ['a float', `${VECTOR.timestamp}.0`],
    ['an exponent', '1.614265330e9'],
    ['hex', `0x${Number(VECTOR.timestamp).toString(16)}`],
    ['milliseconds (13 digits)', `${VECTOR.timestamp}000`],
    ['past 2^53', '9007199254740993'],
    ['spaces', ` ${VECTOR.timestamp} `],
    ['Arabic-Indic digits', '١٦١٤٢٦٥٣٣٠'],
    ['empty', ''],
  ])('refuses a timestamp with %s, even when signed over it', (_, timestamp) => {
    const signature = `v1,${sign(VECTOR.id, timestamp, VECTOR.body)}`;
    refused(() =>
      verify(vectorHeaders({ 'webhook-timestamp': timestamp, 'webhook-signature': signature })),
    );
  });

  it('passes a signed timestamp with leading zeros: the check is over the bytes as sent', () => {
    const timestamp = `00${VECTOR.timestamp}`;
    const signature = `v1,${sign(VECTOR.id, timestamp, VECTOR.body)}`;
    expect(
      verify(vectorHeaders({ 'webhook-timestamp': timestamp, 'webhook-signature': signature })),
    ).toBe(VECTOR.id);
  });

  it.each([
    [300_000, true],
    [-300_000, true],
    [300_001, false],
    [-300_001, false],
  ])('at now = timestamp %+i ms, passes: %s', (offset, passes) => {
    const run = () =>
      verify(vectorHeaders({ 'webhook-signature': GOOD }), VECTOR.secret, VECTOR_NOW + offset);
    if (passes) expect(run()).toBe(VECTOR.id);
    else refused(run);
  });

  it('refuses when the caller’s clock is not a number (NaN), rather than passing any timestamp', () => {
    refused(() => verify(vectorHeaders(), VECTOR.secret, Number.NaN));
  });
});

describe('the secret', () => {
  const raw = VECTOR.secret.slice('whsec_'.length);
  it.each([
    ['no whsec_ prefix', raw],
    ['a trailing newline', `${VECTOR.secret}\n`],
    ['a leading space', ` ${VECTOR.secret}`],
    ['the url-safe alphabet', `whsec_${raw.replace(/\+/g, '-').replace(/\//g, '_')}x`],
    ['an empty key', 'whsec_'],
    ['the committed placeholder', 'whsec_PASTE_THE_SECRET_FROM_GRANOLA_HERE'],
  ])('refuses every delivery with %s, rather than verifying under another key', (_, secret) => {
    refused(() => verify(vectorHeaders(), secret));
  });
});

describe('the note id in a verified body', () => {
  it.each([
    ['top level wins over data', '{"note_id":"not_top","data":{"note_id":"not_data"}}', 'not_top'],
    ['data, when the top is null', '{"note_id":null,"data":{"note_id":"not_data"}}', 'not_data'],
    ['the last of duplicate keys', '{"note_id":"not_one","note_id":"not_two"}', 'not_two'],
  ])('reads %s', (_, body, id) => {
    expect(webhookNoteId(body)).toBe(id);
  });

  it.each([
    ['a number', '{"note_id":5}'],
    ['an array', '{"note_id":["not_1"]}'],
    ['only under __proto__', '{"__proto__":{"note_id":"not_1"}}'],
    ['a path segment', '{"note_id":"../repos"}'],
    ['a query', '{"note_id":"not_1?x=1"}'],
    ['65 characters', `{"note_id":"${'a'.repeat(65)}"}`],
    ['a trailing newline', '{"note_id":"not_1\\n"}'],
    ['a BOM before the JSON', '﻿{"note_id":"not_1"}'],
  ])('refuses a note_id that is %s', (_, body) => {
    expect(() => webhookNoteId(body)).toThrow(WebhookRefusal);
  });
});

// --- The committed workflow, with a failure injected at each node ---

interface WorkflowNode {
  readonly name: string;
  readonly type: string;
  readonly parameters: Record<string, unknown>;
  readonly onError?: string;
}
interface Workflow {
  readonly nodes: readonly WorkflowNode[];
  readonly connections: Record<string, { main: { node: string }[][] }>;
}

const committed = JSON.parse(
  readFileSync(new URL('granola-webhook.workflow.json', import.meta.url), 'utf8'),
) as Workflow;
const node = (name: string) => {
  const found = committed.nodes.find((each) => each.name === name);
  if (found === undefined) throw new Error(`no node ${name}`);
  return found;
};

/** The path a run takes; `leave` gives the output each node leaves by. */
function walk(leave: (name: string) => number): string[] {
  const path: string[] = [];
  let at: string | undefined = N.webhook;
  while (at !== undefined && !path.includes(at)) {
    path.push(at);
    const outputs: { node: string }[][] = committed.connections[at]?.main ?? [];
    at = outputs[outputs.length === 1 ? 0 : leave(at)]?.[0]?.node;
  }
  return path;
}
const answers = (path: readonly string[]) =>
  path
    .filter((name) => node(name).type === 'n8n-nodes-base.respondToWebhook')
    .map((name) => (node(name).parameters.options as { responseCode: number }).responseCode);

/** A node that throws: n8n sends it out of its error output when it has one, else the run stops. */
const throwsAt = (failing: string) => (name: string) =>
  name === failing && node(name).onError === 'continueErrorOutput' ? 1 : 0;

describe('a failure injected at each node', () => {
  const stages = [
    N.fetch,
    N.map,
    N.getPath,
    N.same,
    N.getCollision,
    N.sameOther,
    N.create,
    N.createCollision,
  ];

  it.each(stages)('a throw at %s is answered once and emailed', (failing) => {
    const path = walk((name) => {
      if (name === failing) return throwsAt(failing)(name);
      // A lookup that fails reads as a free path, so the commit after it is tried and fails too.
      if (name === N.getPath) return failing === N.create ? 1 : 0;
      if (name === N.create) return failing === N.getPath ? 1 : 0;
      if (name === N.ifSame) return 1;
      if (name === N.getCollision) return failing === N.createCollision ? 1 : 0;
      if (name === N.createCollision) return failing === N.getCollision ? 1 : 0;
      if (name === N.found) return 0;
      return 0;
    });
    expect(answers(path)).toEqual([200]);
    if (path.includes(failing)) expect(path.slice(-2)).toEqual([N.failed, N.notify]);
  });

  it('every node that can throw past the 200 has an error output (or is the email itself)', () => {
    const answered = new Set([N.webhook, N.verify, N.accepted, N.refuse]);
    const silent = committed.nodes
      .filter((each) => !answered.has(each.name as never))
      .filter((each) => !['n8n-nodes-base.noOp', 'n8n-nodes-base.if'].includes(each.type))
      .filter((each) => each.name !== N.notify && each.onError !== 'continueErrorOutput')
      .map((each) => each.name);
    expect(silent).toEqual([]);
  });
});

// --- The verify node as committed, run as n8n runs it ---

type AsyncCode = (this: unknown, $input: unknown) => Promise<{ json: unknown }[]>;
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...args: string[]
) => AsyncCode;

/** The output the verify node leaves by for a delivery: 0 on success, 1 when it throws. */
async function verifyOutput(
  headers: unknown,
  readBody: () => Promise<Uint8Array>,
): Promise<number> {
  const code = new AsyncFunction('$input', verifyGranolaScript(VECTOR.secret));
  const helpers = { getBinaryDataBuffer: () => readBody() };
  const $input = { first: () => ({ json: { headers } }) };
  try {
    await code.call({ helpers }, $input);
    return 0;
  } catch {
    return 1;
  }
}

describe('a delivery that is signed by Granola but cannot be read', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(VECTOR_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // ADR-0034: "200 right after the signature is verified"; every later failure is emailed.
  it('is answered 200 and emailed, not refused 401 in silence, when its body names no note id where the check looks', async () => {
    const body = '{"type":"note.generated","data":{"id":"not_4kTq2mWxLp4Rz7"}}';
    const headers = vectorHeaders({
      'webhook-signature': `v1,${sign(VECTOR.id, VECTOR.timestamp, body)}`,
    });
    const output = await verifyOutput(headers, () => Promise.resolve(Buffer.from(body)));
    const path = walk((name) => (name === N.verify ? output : 0));
    expect(answers(path)).toEqual([200]);
    expect(path).toContain(N.notify);
  });

  it('is emailed, not refused 401 in silence, when n8n cannot hand the verify node the raw body', async () => {
    const output = await verifyOutput(vectorHeaders(), () =>
      Promise.reject(new Error('No binary data with field data found')),
    );
    const path = walk((name) => (name === N.verify ? output : 0));
    expect(path).toContain(N.notify);
  });
});

// --- The failure email, its n8n expressions evaluated ---

/** An n8n `=…{{ expr }}…` template rendered with the given `$` and `$json`. */
function render(template: string, $: (name: string) => unknown, $json: unknown): string {
  return template
    .replace(/^=/, '')
    .replace(/\{\{ ([\s\S]+?) \}\}/g, (_, expression: string) =>
      String(
        new Function('$', '$json', '$workflow', '$execution', `return (${expression});`)(
          $,
          $json,
          { name: 'Granola webhook to DFAI' },
          { id: '41' },
        ),
      ),
    );
}

describe('the failure email', () => {
  const title = 'Quarterly sync\nSource ID: not_forged\nExecution: none';
  const $ = (name: string) => ({
    item: {
      json:
        name === N.fetch ? { statusCode: 200, body: { title } } : { noteId: 'not_4kTq2mWxLp4Rz7' },
    },
  });
  const message = () =>
    render(String(node(N.notify).parameters.message), $, { error: 'GitHub said 409' });

  it('names the verified source id once, whatever the meeting title holds', () => {
    const sourceLines = message()
      .split('\n')
      .filter((line) => line.startsWith('Source ID:'));
    expect(sourceLines).toEqual(['Source ID: not_4kTq2mWxLp4Rz7']);
  });
});
