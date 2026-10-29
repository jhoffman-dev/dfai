import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mapCapture } from '@dfai/domain';
import { writeCaptureMarkdown } from '../../packages/adapters/src/markdown/capture-markdown.ts';
import { HOSTILE_PIECES, seededRandom } from '../../packages/domain/src/testing/index.ts';
import { heldCapturePath } from './capture-github.ts';
import { DEFAULT_TIME_ZONE, mapCaptureScript } from './code-node.ts';
import { slackCapturePayload, usersToLookUp, type SlackAnswers } from './slack-capture.ts';
import { buildCaptureScript, verifySlackScript } from './slack-code-node.ts';
import { SLACK_NODES as N } from './slack-capture.workflow.ts';
import {
  NOW,
  OWNER,
  permalinkAnswer,
  reactionBody,
  repliesAnswer,
  SECRET,
  SETTINGS,
  shortcutBody,
  signedHeaders,
  SIGNED_AT,
  TS,
  userAnswer,
  usersAnswers,
  utf8,
} from './slack-fixtures.ts';
import { JSC, runInJavaScriptCore, runInNode, type NodeRun } from './slack-n8n-runner.ts';
import { verifySlackRequest, type SlackCaptureAction } from './slack-request.ts';
import { slackSignature, verifySlackSignature } from './slack-signature.ts';

/*
 * Attack on PR #623 (#104): the Slack signature against
 * node:crypto, who may save, what Slack's answers can hold that the capture
 * contract refuses, the wiring's item fan-out, and Node against
 * JavaScriptCore on 300 seeded payloads. Seeded; a fixed clock.
 */

const LA = DEFAULT_TIME_ZONE;
const check = { signingSecret: SECRET, now: NOW, settings: SETTINGS };
const deliver = (body: string | Uint8Array, headers: unknown = signedHeaders(body)) => ({
  headers,
  body: typeof body === 'string' ? utf8(body) : body,
});

/* ---- the signature ---- */

function randomBytes(random: () => number, length: number): Uint8Array {
  return Uint8Array.from({ length }, () => Math.floor(random() * 256));
}

describe('attack-623: the Slack signature', () => {
  it('equals node:crypto’s HMAC-SHA256 on 300 seeded secrets, timestamps and bodies', () => {
    const random = seededRandom(623);
    const lengths = [0, 1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 129];
    for (let n = 0; n < 300; n += 1) {
      const secretBytes = randomBytes(random, Math.floor(random() * 140));
      const secret = Uint8Array.from(secretBytes);
      const timestamp = String(Math.floor(random() * 2 ** 33));
      const length = n < lengths.length ? (lengths[n] ?? 0) : Math.floor(random() * 3000);
      const body = randomBytes(random, length);
      const expected = createHmac('sha256', Buffer.from(secret))
        .update(`v0:${timestamp}:`)
        .update(body)
        .digest('hex');
      expect(slackSignature(secret, timestamp, body), `case ${n}`).toBe(`v0=${expected}`);
    }
  });

  it('is over the bytes as sent: a shortcut re-encoded with %20 for + does not verify', () => {
    const sent = shortcutBody({ message: { ts: TS, text: 'a b + c' } });
    const reencoded = sent.replace(/\+/g, '%20');
    expect(() => verifySlackSignature(deliver(reencoded, signedHeaders(sent)), check)).toThrow(
      /does not match/,
    );
    expect(() => verifySlackSignature(deliver(sent), check)).not.toThrow();
  });

  it.each([
    ['a leading +', `+${SIGNED_AT}`],
    ['a float', `${SIGNED_AT}.0`],
    ['a space', ` ${SIGNED_AT}`],
    ['hex', `0x${SIGNED_AT.toString(16)}`],
    ['exponent', '1.7931364e9'],
    ['empty', ''],
    ['13 digits', `0${SIGNED_AT}00`],
  ])('refuses a timestamp with %s even when the signature is over it', (_, timestamp) => {
    const body = reactionBody();
    expect(
      verifySlackRequest(deliver(body, signedHeaders(body, SECRET, timestamp)), check),
    ).toEqual(expect.objectContaining({ signed: false }));
  });

  it('takes a zero-padded timestamp only over its own text, so padding forges nothing', () => {
    const body = reactionBody();
    const padded = `00${SIGNED_AT}`;
    expect(verifySlackRequest(deliver(body, signedHeaders(body, SECRET, padded)), check)).toEqual(
      expect.objectContaining({ signed: true }),
    );
    const swapped = { ...signedHeaders(body), 'x-slack-request-timestamp': padded };
    expect(verifySlackRequest(deliver(body, swapped), check)).toMatchObject({ signed: false });
  });

  it.each([
    ['upper-case hex', (sig: string) => `v0=${sig.slice(3).toUpperCase()}`],
    ['a trailing space', (sig: string) => `${sig} `],
    ['V0=', (sig: string) => `V0=${sig.slice(3)}`],
    ['v1=', (sig: string) => `v1=${sig.slice(3)}`],
    ['two joined, as Node joins a repeated header', (sig: string) => `${sig}, ${sig}`],
    ['half the digest', (sig: string) => sig.slice(0, 35)],
  ])('refuses x-slack-signature with %s', (_, change) => {
    const body = reactionBody();
    const headers = signedHeaders(body);
    const sig = change(headers['x-slack-signature']);
    expect(
      verifySlackRequest(deliver(body, { ...headers, 'x-slack-signature': sig }), check),
    ).toMatchObject({ signed: false });
  });

  it('refuses a signature header that is a list, or arrives under a capitalised name', () => {
    const body = reactionBody();
    const headers = signedHeaders(body);
    const listed = { ...headers, 'x-slack-signature': [headers['x-slack-signature']] };
    expect(verifySlackRequest(deliver(body, listed), check)).toMatchObject({ signed: false });
    const { 'x-slack-signature': sig, ...rest } = headers;
    const capital = { ...rest, 'X-Slack-Signature': sig };
    expect(verifySlackRequest(deliver(body, capital), check)).toMatchObject({ signed: false });
  });

  it('refuses a body over 256 kB unhashed, and takes one at the limit', () => {
    const at = `{"type":"x","pad":"${'a'.repeat(256 * 1024 - 21)}"}`;
    expect(utf8(at).length).toBe(256 * 1024);
    expect(verifySlackRequest(deliver(at), check)).toMatchObject({ signed: true });
    const over = `${at} `;
    expect(verifySlackRequest(deliver(over), check)).toEqual({
      signed: false,
      reason: 'body: over 262144 bytes',
    });
  });

  it('accepts exactly 300 s of skew either way, and refuses 301', () => {
    const body = reactionBody();
    for (const skew of [-300, 300]) {
      const headers = signedHeaders(body, SECRET, String(SIGNED_AT + skew));
      expect(verifySlackRequest(deliver(body, headers), check)).toMatchObject({ signed: true });
    }
    for (const skew of [-301, 301]) {
      const headers = signedHeaders(body, SECRET, String(SIGNED_AT + skew));
      expect(verifySlackRequest(deliver(body, headers), check)).toMatchObject({ signed: false });
    }
  });
});

/* ---- who may save ---- */

const signed = (body: string) => verifySlackRequest(deliver(body), check);
const OTHER = 'U0MARAQ111';

describe('attack-623: who may save', () => {
  it('ignores a reaction whose item is the owner’s but whose reactor is not', () => {
    expect(signed(reactionBody({ user: OTHER, item_user: OWNER }))).toMatchObject({
      action: 'ignore',
    });
  });

  it('ignores a shortcut on the owner’s message run by someone else', () => {
    const body = shortcutBody({
      user: { id: OTHER },
      message: { ts: TS, user: OWNER, text: 'x' },
    });
    expect(signed(body)).toMatchObject({ action: 'ignore', reason: 'not your shortcut' });
  });

  it('reads the owner from user.id only: a __proto__ or a second user field changes nothing', () => {
    const body = JSON.stringify({
      type: 'event_callback',
      __proto__: { type: 'url_verification', challenge: 'x' },
      event: {
        type: 'reaction_added',
        __proto__: { user: OWNER },
        reaction: 'inbox_tray',
        item: { type: 'message', channel: 'C0LARK5PUR', ts: TS },
        user: OTHER,
      },
    });
    expect(signed(body)).toMatchObject({ action: 'ignore', reason: 'not your reaction' });
    const noUser = body.replace(`"user":"${OTHER}"`, '"x":1');
    expect(() => signed(noUser)).toThrow(/event\.user: missing/);
  });

  it('reads a form body’s first payload field, and never an event beside it', () => {
    const shortcut = shortcutBody({ user: { id: OTHER } });
    const both = `${shortcut}&event=${encodeURIComponent(reactionBody())}`;
    expect(signed(both)).toMatchObject({ action: 'ignore', reason: 'not your shortcut' });
  });

  it('refuses a payload that is an array, a string, or deep nesting, as unreadable (signed)', () => {
    for (const body of [
      '[{"type":"event_callback"}]',
      'payload=%22x%22',
      `${'['.repeat(50_000)}`,
    ]) {
      expect(() => signed(body)).toThrow(/UnreadableSlackRequest|signed by Slack/);
    }
    expect(() => signed('payload=%E0%A4%A')).toThrow(/not form-encoded/);
  });
});

/* ---- what Slack can answer that the contract refuses ---- */

const reaction: SlackCaptureAction = {
  action: 'capture',
  via: 'reaction',
  kind: 'note',
  channel: 'C0LARK5PUR',
  ts: TS,
  userId: OWNER,
};

function answersWith(change: {
  messages?: readonly Record<string, unknown>[];
  users?: readonly unknown[];
}): SlackAnswers {
  return {
    action: reaction,
    permalink: permalinkAnswer,
    replies: repliesAnswer(change.messages),
    users: change.users ?? usersAnswers,
  };
}

/** What the fallback commit would write; throws as the Map node would. */
const mapped = (answers: SlackAnswers) =>
  mapCapture(slackCapturePayload(answers), { timeZone: LA, writeMarkdown: writeCaptureMarkdown });

const parent = (fields: Record<string, unknown> = {}) => ({
  type: 'message',
  ts: TS,
  thread_ts: TS,
  user: OTHER,
  text: 'Can you send the renewal?',
  ...fields,
});

describe('attack-623: one odd detail in a thread does not lose the message', () => {
  it('saves a thread where one person’s Slack address has an apostrophe', () => {
    const users = [
      ...usersAnswers.slice(0, 1),
      userAnswer(OTHER, "Shay O'Rourke", "shay.o'rourke@example.com"),
    ];
    expect(() => mapped(answersWith({ messages: [parent()], users }))).not.toThrow();
  });

  it('saves a thread where one person’s display name is only a direction mark', () => {
    const odd = userAnswer(OTHER, 'Mara Quill', null);
    const user = { ...odd.user, profile: { ...odd.user.profile, display_name: '‎' } };
    const users = [usersAnswers[0], { ...odd, user }];
    const file = mapped(answersWith({ messages: [parent()], users }));
    expect(file.content).toContain('Mara Quill');
  });

  it('saves a thread that shares more than 100 files (the contract’s most)', () => {
    const files = Array.from({ length: 101 }, (_, at) => ({
      name: `scan-${at}.pdf`,
      permalink: `https://larkspur.slack.com/files/${OTHER}/F${at}/scan-${at}.pdf`,
    }));
    expect(() => mapped(answersWith({ messages: [parent({ files })] }))).not.toThrow();
  });

  it('saves a message whose file has a name over 200 characters', () => {
    const files = [
      {
        name: `${'quarterly-renewal-'.repeat(12)}.pdf`,
        permalink: `https://larkspur.slack.com/files/${OTHER}/F1/renewal.pdf`,
      },
    ];
    expect(() => mapped(answersWith({ messages: [parent({ files })] }))).not.toThrow();
  });

  it('saves the message when its thread holds more than a million characters', () => {
    const replies = Array.from({ length: 30 }, (_, at) => ({
      type: 'message',
      ts: `17931363${String(at).padStart(2, '0')}.000100`,
      thread_ts: TS,
      user: OTHER,
      text: 'log line '.repeat(4_000),
    }));
    const file = mapped(answersWith({ messages: [parent(), ...replies] }));
    expect(file.content).toContain('Can you send the renewal?');
  });

  it('looks up the saved message’s own author first, past 100 people in its thread', () => {
    const replies = Array.from({ length: 120 }, (_, at) => ({
      type: 'message',
      ts: `17931363${String(at).padStart(3, '0').slice(0, 2)}.${String(at).padStart(6, '0')}`,
      thread_ts: TS,
      user: `U0PERSON${String(at).padStart(3, '0')}`,
      text: 'ok',
    }));
    const saved = replies.at(-1);
    const action = { ...reaction, ts: String(saved?.ts) };
    const ids = usersToLookUp(action, repliesAnswer([parent(), ...replies]));
    expect(ids).toHaveLength(100);
    expect(ids).toContain(saved?.user);
  });
});

/* ---- the fallback's listing ---- */

describe('attack-623: the fallback listing', () => {
  it('never takes a listing of 1,000 files (GitHub’s most, so maybe truncated) for “not there”', () => {
    const body = Array.from({ length: 1000 }, (_, at) => ({ name: `Note ${at}.md` }));
    const file = { keyEnding: ' (slack 0123456789abcdef).md' };
    expect(() => heldCapturePath({ statusCode: 200, body }, file)).toThrow();
  });

  it('holds a listing of 999 files as complete, and finds the key in it', () => {
    const body = Array.from({ length: 999 }, (_, at) => ({ name: `Note ${at}.md` }));
    const keyEnding = ' (slack 0123456789abcdef).md';
    expect(heldCapturePath({ statusCode: 200, body }, { keyEnding })).toBeNull();
    const withIt = [...body.slice(1), { name: `Edited title${keyEnding}` }];
    expect(heldCapturePath({ statusCode: 200, body: withIt }, { keyEnding })).toBe(
      `Inbox/Captures/Edited title${keyEnding}`,
    );
  });
});

/* ---- the wiring's item fan-out ---- */

interface WorkflowNode {
  readonly name: string;
  readonly type: string;
  readonly onError?: string;
  readonly executeOnce?: boolean;
  readonly parameters: Record<string, unknown>;
}
const committed = JSON.parse(
  readFileSync(new URL('slack-capture.workflow.json', import.meta.url), 'utf8'),
) as {
  nodes: WorkflowNode[];
  connections: Record<string, { main: { node: string }[][] }>;
};
const nodeNamed = (name: string) => {
  const found = committed.nodes.find((each) => each.name === name);
  if (found === undefined) throw new Error(`no node ${name}`);
  return found;
};
const collapses = (name: string) =>
  nodeNamed(name).executeOnce === true || nodeNamed(name).parameters.mode === 'runOnceForAllItems';

/** Every route from `name` to `target` (`name` included), each a list of node names. */
function routes(name: string, target: string, seen: readonly string[] = []): string[][] {
  if (name === target) return [[name]];
  if (seen.includes(name)) return [];
  return (committed.connections[name]?.main ?? [])
    .flat()
    .flatMap((next) => routes(next.node, target, [...seen, name]))
    .map((route) => [name, ...route]);
}

describe('attack-623: one users.info lookup per person', () => {
  it('never splits a run into “saved” and “not saved” when some lookups fail and some do not', () => {
    // n8n sends a failed item of a many-item node down its error output and the rest on:
    // Build would save with the names it got while "Capture failed" says not saved.
    const names = nodeNamed(N.names);
    const errorTargets = (committed.connections[N.names]?.main[1] ?? []).map((each) => each.node);
    expect(names.onError === 'continueErrorOutput' && errorTargets.length > 0).toBe(false);
  });

  it('emails at most once per run however many lookups failed', () => {
    const fromErrors = (committed.connections[N.names]?.main[1] ?? []).flatMap((first) =>
      routes(first.node, N.notify),
    );
    for (const route of fromErrors) {
      expect(route.some(collapses), route.join(' → ')).toBe(true);
    }
  });
});

/* ---- Node against JavaScriptCore, 300 payloads ---- */

const PIECES = [...HOSTILE_PIECES, '😀', 'é', '<@U0TOBIAS22>', '<!channel>', '&amp;', '+', '%20'];
const wordsOf = (random: () => number) =>
  Array.from({ length: Math.floor(random() * 6) }, () =>
    String(PIECES[Math.floor(random() * PIECES.length)]),
  ).join(' ');

/** A script run once per input as n8n would, all in one node run: `INPUTS` is set first. */
function looped(script: string, inputs: readonly unknown[]): NodeRun {
  return {
    jsCode: [
      `const INPUTS = ${JSON.stringify(inputs)};`,
      'const outs = [];',
      'for (const one of INPUTS) {',
      '  const $in = { first: () => one.input[0], all: () => one.input };',
      '  const $n = (name) => ({ first: () => (one.nodes[name] || [])[0] });',
      '  const helpers = { getBinaryDataBuffer: async () => Uint8Array.from(one.binary) };',
      '  const body = async function ($input, $) {',
      script,
      '  };',
      '  try { outs.push(await body.call({ helpers }, $in, $n)); }',
      '  catch (error) { outs.push({ error: error.name + ": " + error.message }); }',
      '}',
      'return [{ json: outs }];',
    ].join('\n'),
    input: [{ json: {} }],
    now: NOW,
  };
}

function seededVerifies(random: () => number) {
  return Array.from({ length: 300 }, (_, n) => {
    const text = wordsOf(random);
    const body =
      n % 3 === 0
        ? shortcutBody({ message: { ts: TS, user: OTHER, text } })
        : n % 3 === 1
          ? reactionBody({ reaction: random() < 0.5 ? 'inbox_tray' : 'ballot_box_with_check' })
          : `{"type":"event_callback","event":${JSON.stringify(text)}}`;
    const headers = signedHeaders(body, random() < 0.2 ? 'wrong' : SECRET);
    return { input: [{ json: { headers } }], nodes: {}, binary: [...utf8(body)] };
  });
}

function seededThreads(random: () => number) {
  return Array.from({ length: 300 }, () => {
    const messages = [
      parent({ text: `Renewal ${wordsOf(random)}` }),
      ...Array.from({ length: Math.floor(random() * 4) }, (_, at) => ({
        type: 'message',
        ts: `17931361${at}0.000100`,
        thread_ts: TS,
        user: random() < 0.5 ? OTHER : 'U0TOBIAS22',
        text: wordsOf(random),
      })),
    ];
    const verified = { signed: true, ...reaction };
    return {
      input: usersAnswers.map((json) => ({ json })),
      nodes: {
        [N.verify]: [{ json: verified }],
        [N.permalink]: [{ json: permalinkAnswer }],
        [N.thread]: [{ json: repliesAnswer(messages) }],
      },
      binary: [],
    };
  });
}

describe.skipIf(!existsSync(JSC))('attack-623: Node against JavaScriptCore', () => {
  it('answer 300 seeded verifies, builds and maps byte for byte alike', async () => {
    const random = seededRandom(6230);
    const verify = looped(
      verifySlackScript({ signingSecret: SECRET, settings: SETTINGS }),
      seededVerifies(random),
    );
    const threads = seededThreads(random);
    const build = looped(buildCaptureScript(), threads);
    const builtInNode = await runInNode(build);
    if ('error' in builtInNode) throw new Error(builtInNode.error);
    const payloads = builtInNode.items[0]?.json as { json: unknown }[][];
    const maps = looped(
      mapCaptureScript(N.build),
      payloads.map((each) => ({
        input: [{ json: { statusCode: 404, body: {} } }],
        nodes: { [N.build]: each },
        binary: [],
      })),
    );
    const runs = [verify, build, maps];
    const inNode = await Promise.all(runs.map(runInNode));
    expect(runInJavaScriptCore(runs)).toEqual(inNode);
    const mapsOut = (inNode[2] as { items: { json: unknown[] }[] }).items[0]?.json ?? [];
    expect(mapsOut).toHaveLength(300);
    for (const [at, one] of payloads.entries()) {
      const app = mapCapture(one[0]?.json, { timeZone: LA, writeMarkdown: writeCaptureMarkdown });
      expect((mapsOut[at] as { json: unknown }[])[0]?.json).toEqual({ ...app, held: null });
    }
  }, 120_000);
});
