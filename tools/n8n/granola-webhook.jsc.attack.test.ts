import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapGranolaNote } from '@dfai/domain';
import { MAP_MEETING_NODE } from './code-node.ts';
import { DEFAULT_GRANOLA_OPTIONS, webhookCodeNodeScript } from './granola-code-node.ts';
import { verifyGranolaWebhook } from './granola-webhook.ts';
import { VECTOR, VECTOR_NOW, vectorHeaders } from './standard-webhook-vector.ts';

/*
 * The Granola workflow's Code nodes under JavaScriptCore (macOS's `jsc`),
 * an engine with no Buffer, TextEncoder or crypto: the signature check needs
 * none of them, so it does not hang on what n8n Cloud's sandbox allows; and
 * the committed map node writes what the app's pull writes in the webview.
 */

const JSC = '/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc';

/** Each case's answer from the driver run under JavaScriptCore: a value or `Name: message`. */
function inJavaScriptCore(body: string, cases: readonly unknown[]): unknown[] {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-jsc-'));
  const driver = [
    body,
    `const cases = ${JSON.stringify(cases)};`,
    'print(JSON.stringify(cases.map((each) => { try { return run(each); } catch (error) { return `${error.name}: ${error.message}`; } })));',
  ].join('\n');
  const file = join(dir, 'driver.js');
  try {
    writeFileSync(file, driver);
    return JSON.parse(execFileSync(JSC, [file], { encoding: 'utf8' })) as unknown[];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const inNode = (run: () => unknown): unknown => {
  try {
    return run();
  } catch (error) {
    return `${(error as Error).name}: ${(error as Error).message}`;
  }
};

const KEY = Buffer.from(VECTOR.secret.slice('whsec_'.length), 'base64');
const NOTE_BODY = '{"note_id":"not_4kTq2mWxLp4Rz7","title":"Larkspur — renewal 🚀"}';
const signature = (body: string) =>
  `v1,${createHmac('sha256', KEY).update(`${VECTOR.id}.${VECTOR.timestamp}.${body}`).digest('base64')}`;

interface CheckCase {
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly secret: string;
  readonly now: number;
}

const CASES: readonly (readonly [string, CheckCase])[] = [
  [
    'the spec’s vector',
    { headers: vectorHeaders(), body: VECTOR.body, secret: VECTOR.secret, now: VECTOR_NOW },
  ],
  [
    'a signed Granola delivery',
    {
      headers: vectorHeaders({ 'webhook-signature': signature(NOTE_BODY) }),
      body: NOTE_BODY,
      secret: VECTOR.secret,
      now: VECTOR_NOW,
    },
  ],
  [
    'a stale timestamp',
    {
      headers: vectorHeaders({ 'webhook-signature': signature(NOTE_BODY) }),
      body: NOTE_BODY,
      secret: VECTOR.secret,
      now: VECTOR_NOW + 301_000,
    },
  ],
  [
    'a wrong secret',
    {
      headers: vectorHeaders({ 'webhook-signature': signature(NOTE_BODY) }),
      body: NOTE_BODY,
      secret: `whsec_${Buffer.from('another secret').toString('base64')}`,
      now: VECTOR_NOW,
    },
  ],
];

describe.skipIf(!existsSync(JSC))(
  'the signature check in an engine with no crypto or Buffer',
  () => {
    const script = webhookCodeNodeScript(
      'return verifyGranolaWebhook({ headers: $json.headers, body: utf8Bytes($json.body) }, $json);',
    );
    // Run once, on first use: a skipped describe's body still runs where there is no `jsc`.
    let ran: unknown[] | undefined;
    const answers = () =>
      (ran ??= inJavaScriptCore(
        `function run($json) {\n${script}\n}`,
        CASES.map(([, each]) => each),
      ));

    it.each(CASES.map(([name, each], at) => [name, each, at] as const))(
      'answers %s as Node does',
      (_, each, at) => {
        const node = inNode(() =>
          verifyGranolaWebhook({ headers: each.headers, body: Buffer.from(each.body) }, each),
        );
        expect(answers()[at]).toEqual(node);
      },
    );

    it('passes the signed delivery and refuses the stale and the wrongly signed', () => {
      expect(answers()[1]).toEqual({
        signed: true,
        webhookId: VECTOR.id,
        noteId: 'not_4kTq2mWxLp4Rz7',
      });
      expect(answers()[0]).toMatch(
        /^UnreadableWebhookBody: signed by Granola, but body: no note_id/,
      );
      expect(answers()[2]).toEqual({
        signed: false,
        reason: expect.stringMatching(/five minutes/),
      });
      expect(answers()[3]).toEqual({ signed: false, reason: expect.stringMatching(/signature/) });
    });
  },
);

const fixtures = new URL('../../packages/domain/src/meetings/fixtures/granola/', import.meta.url);
const notes = readdirSync(fixtures)
  .filter((name) => name.endsWith('.json'))
  .map((name) => JSON.parse(readFileSync(new URL(name, fixtures), 'utf8')) as unknown);

describe.skipIf(!existsSync(JSC))('the committed map node in the webview’s engine', () => {
  it('writes every fixture note byte for byte as the app’s pull does', () => {
    const workflow = JSON.parse(
      readFileSync(new URL('granola-webhook.workflow.json', import.meta.url), 'utf8'),
    ) as { nodes: { name: string; parameters: { jsCode?: string } }[] };
    const jsCode = workflow.nodes.find((each) => each.name === MAP_MEETING_NODE)?.parameters.jsCode;
    expect(jsCode).toBeDefined();
    const answers = inJavaScriptCore(
      `function run(note) {\nconst $ = () => ({ item: { json: { body: note } } });\n${String(jsCode)}\n}`,
      notes,
    );
    expect(answers).toHaveLength(notes.length);
    notes.forEach((note, at) => {
      expect(answers[at]).toEqual({ json: { ...mapGranolaNote(note, DEFAULT_GRANOLA_OPTIONS) } });
    });
  });
});
