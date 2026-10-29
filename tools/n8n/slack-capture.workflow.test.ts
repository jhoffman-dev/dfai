import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mapCapture } from '@dfai/domain';
import { writeCaptureMarkdown } from '../../packages/adapters/src/markdown/capture-markdown.ts';
import { DEFAULT_TIME_ZONE, mapCaptureScript } from './code-node.ts';
import { BOT_SCOPES, slackAppManifest, USER_SCOPES } from './slack-app-manifest.ts';
import {
  replyScript,
  slackScripts,
  usersToLookUpScript,
  buildCaptureScript,
  verifySlackScript,
} from './slack-code-node.ts';
import {
  DFAI_API_CREDENTIAL,
  emailValue,
  SLACK_BOT_CREDENTIAL,
  SLACK_NODES as N,
  SLACK_USER_CREDENTIAL,
  slackCaptureWorkflow,
  WEBHOOK_PATH,
} from './slack-capture.workflow.ts';
import { SIGNING_SECRET_PLACEHOLDER } from './slack-signature.ts';
import { OWNER_PLACEHOLDER } from './slack-request.ts';
import { GITHUB_CREDENTIAL } from './workflow.ts';
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
  usersAnswers,
} from './slack-fixtures.ts';
import {
  JSC,
  runInJavaScriptCore,
  runInNode,
  type Item,
  type NodeRun,
} from './slack-n8n-runner.ts';

/*
 * The Slack capture workflow James imports into n8n (#104). These tests
 * hold the committed JSON to its builders, walk every route a run can take,
 * and run its Code nodes as n8n would, in Node and in JavaScriptCore.
 */

interface WorkflowNode {
  readonly name: string;
  readonly type: string;
  readonly parameters: Record<string, unknown>;
  readonly credentials?: Record<string, Record<string, unknown>>;
}
interface Workflow {
  readonly nodes: readonly WorkflowNode[];
  readonly connections: Record<string, { main: { node: string }[][] }>;
}

const committedText = readFileSync(new URL('slack-capture.workflow.json', import.meta.url), 'utf8');
const committed = JSON.parse(committedText) as Workflow;
const node = (name: string) => {
  const found = committed.nodes.find((each) => each.name === name);
  if (found === undefined) throw new Error(`no node ${name}`);
  return found;
};
const jsCodeOf = (name: string) => String(node(name).parameters.jsCode);

describe('the committed workflow', () => {
  it('is what `pnpm n8n:build` makes now (rebuild after changing a module)', () => {
    expect(committed).toEqual(JSON.parse(JSON.stringify(slackCaptureWorkflow(slackScripts()))));
  });

  it('carries no secret and no token: placeholders, and credentials by name only', () => {
    expect(jsCodeOf(N.verify)).toContain(
      `const SIGNING_SECRET = ${JSON.stringify(SIGNING_SECRET_PLACEHOLDER)};`,
    );
    expect(jsCodeOf(N.verify)).toContain(`const OWNER = ${JSON.stringify(OWNER_PLACEHOLDER)};`);
    expect(committedText).not.toMatch(/xox[a-z]-|Bearer [A-Za-z0-9]|ghp_|github_pat_/);
    const credentials = committed.nodes.flatMap((each) =>
      Object.values(each.credentials ?? {}).map((credential) => Object.keys(credential)),
    );
    expect(credentials.every((keys) => keys.join() === 'name')).toBe(true);
    expect(node(N.thread).credentials).toEqual({ httpHeaderAuth: { name: SLACK_USER_CREDENTIAL } });
    expect(node(N.tell).credentials).toEqual({ httpHeaderAuth: { name: SLACK_BOT_CREDENTIAL } });
    expect(node(N.send).credentials).toEqual({ httpBearerAuth: { name: DFAI_API_CREDENTIAL } });
    expect(node(N.commit).credentials).toEqual({ githubApi: { name: GITHUB_CREDENTIAL } });
  });

  it('talks to Slack’s API, GitHub and the Mac’s DFAI only, following no redirect to Slack', () => {
    const urls = committed.nodes
      .filter((each) => each.type === 'n8n-nodes-base.httpRequest')
      .map((each) => ({
        name: each.name,
        url: String(each.parameters.url),
        options: each.parameters.options,
      }));
    for (const { url } of urls) {
      expect(url).toMatch(
        /^(https:\/\/slack\.com\/api\/|https:\/\/api\.github\.com\/repos\/jhoffman-dev\/pkm-space\/|http:\/\/host\.docker\.internal:)/,
      );
    }
    for (const { url, options } of urls.filter((each) => each.url.includes('slack.com'))) {
      expect(options, url).toMatchObject({ redirect: { redirect: { followRedirects: false } } });
    }
  });
});

describe('the send to DFAI', () => {
  it('retries a slow DFAI before falling back, so a note DFAI wrote is not committed again', () => {
    expect(node(N.send)).toMatchObject({ retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 });
  });

  it('follows no redirect with the bearer token', () => {
    expect(node(N.send).parameters.options).toMatchObject({
      redirect: { redirect: { followRedirects: false } },
    });
  });
});

describe('the Slack app manifest', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('slack-app.manifest.json', import.meta.url), 'utf8'),
  ) as ReturnType<typeof slackAppManifest>;

  it('is what `pnpm n8n:build` makes now', () => {
    expect(manifest).toEqual(JSON.parse(JSON.stringify(slackAppManifest())));
  });

  it('asks for the fewest scopes: reads as James, and only commands and chat:write as the bot', () => {
    expect(manifest.oauth_config.scopes.user).toEqual([...USER_SCOPES]);
    expect(manifest.oauth_config.scopes.bot).toEqual(['commands', 'chat:write']);
    expect(
      [...USER_SCOPES, ...BOT_SCOPES].filter((scope) => /write|admin|files:/.test(scope)),
    ).toEqual(['chat:write']);
  });

  it('sends events and shortcuts to the workflow’s webhook, the shortcuts by its callbacks', () => {
    expect(manifest.settings.event_subscriptions.request_url).toMatch(
      new RegExp(`/webhook/${WEBHOOK_PATH}$`),
    );
    expect(manifest.settings.interactivity.request_url).toBe(
      manifest.settings.event_subscriptions.request_url,
    );
    expect(manifest.settings.event_subscriptions.user_events).toEqual(['reaction_added']);
    expect(manifest.features.shortcuts.map((each) => each.callback_id)).toEqual([
      'dfai_save_note',
      'dfai_save_task',
    ]);
  });
});

/* ---- the wiring ---- */

const outputsOf = (name: string) => committed.connections[name]?.main ?? [];

/**
 * Every run the workflow can make from `name`: each node with two outputs
 * may leave by either, and a node wired to two runs both. A run is the list
 * of nodes it reaches.
 */
function runsFrom(name: string, seen: readonly string[] = []): string[][] {
  expect(seen, `a loop at ${name}`).not.toContain(name);
  const outputs = outputsOf(name);
  if (outputs.length === 0) return [[name]];
  return outputs.flatMap((targets) => {
    const branches = targets.map((target) => runsFrom(target.node, [...seen, name]));
    const combined = branches.reduce<string[][]>(
      (runs, options) => runs.flatMap((run) => options.map((option) => [...run, ...option])),
      [[]],
    );
    return combined.map((run) => [name, ...run]);
  });
}

const isAnswer = (name: string) => node(name).type === 'n8n-nodes-base.respondToWebhook';
const answerCode = (name: string) =>
  (node(name).parameters.options as { responseCode: number }).responseCode;
const ALL_RUNS = runsFrom(N.webhook);

describe('the wiring', () => {
  it('answers Slack exactly once on every route a run can take', () => {
    expect(ALL_RUNS.length).toBeGreaterThan(20);
    for (const run of ALL_RUNS) expect(run.filter(isAnswer), run.join(' → ')).toHaveLength(1);
  });

  it('answers before any fetch: no call is reachable without passing an answer', () => {
    for (const run of ALL_RUNS) {
      const answeredAt = run.findIndex(isAnswer);
      const firstCall = run.findIndex((name) => node(name).type === 'n8n-nodes-base.httpRequest');
      if (firstCall !== -1) expect(answeredAt, run.join(' → ')).toBeLessThan(firstCall);
    }
  });

  it('refuses a bad signature with a 401 in silence: no email, no reply, nothing fetched', () => {
    const refused = ALL_RUNS.filter((run) => run.includes(N.refuse));
    expect(refused.length).toBeGreaterThan(0);
    for (const run of refused) {
      expect(run).toEqual([N.webhook, N.verify, N.signed, N.refuse]);
      expect(answerCode(N.refuse)).toBe(401);
    }
  });

  it('answers a signed request it cannot read 200, and emails it', () => {
    for (const run of ALL_RUNS.filter((each) => each.includes(N.unreadable))) {
      expect(run.slice(0, 3)).toEqual([N.webhook, N.verify, N.unreadable]);
      expect(run).toContain(N.notify);
      expect(answerCode(N.unreadable)).toBe(200);
    }
  });

  it('answers the URL check with the challenge, and a request that saves nothing with an empty 200', () => {
    const challenge = node(N.challenge).parameters;
    expect(challenge).toMatchObject({
      respondWith: 'text',
      responseBody: '={{ $json.challenge }}',
    });
    for (const name of [N.challenge, N.ignore]) {
      const runs = ALL_RUNS.filter((run) => run.includes(name));
      expect(runs.length).toBeGreaterThan(0);
      for (const run of runs) expect(run.at(-1)).toBe(name);
    }
  });

  it('emails and tells James in Slack whenever a message to save is not saved', () => {
    const failed = ALL_RUNS.filter((run) => run.includes(N.failed));
    expect(failed.length).toBeGreaterThan(0);
    for (const run of failed) {
      expect(run).toContain(N.notify);
      expect(run).toContain(N.replyFailed);
    }
  });

  it('ends every route past the 200 in a reply or an email, never in silence', () => {
    for (const run of ALL_RUNS.filter((each) => each.includes(N.accepted))) {
      expect(run.includes(N.tell) || run.includes(N.notify), run.join(' → ')).toBe(true);
    }
  });

  it('falls back to the commit when DFAI does not answer, or does not take it', () => {
    expect(outputsOf(N.send).map((targets) => targets.map((each) => each.node))).toEqual([
      [N.sent],
      [N.list],
    ]);
    expect(outputsOf(N.sent).map((targets) => targets.map((each) => each.node))).toEqual([
      [N.replySaved],
      [N.list],
    ]);
    expect(
      String(
        (node(N.sent).parameters.conditions as { conditions: { leftValue: string }[] })
          .conditions[0]?.leftValue,
      ),
    ).toBe('={{ $json.statusCode === 200 || $json.statusCode === 201 }}');
  });

  it('commits only when pkm-space holds no file for the message', () => {
    expect(outputsOf(N.held).map((targets) => targets.map((each) => each.node))).toEqual([
      [N.replyHeld],
      [N.commit],
    ]);
  });
});

/* ---- the email ---- */

/** The email's text as n8n would write it, every `{{ }}` evaluated with these names. */
function emailAs(scope: Record<string, unknown>): string {
  const message = String(node(N.notify).parameters.message).slice(1);
  return message.replace(/\{\{ ([\s\S]*?) \}\}(?=$|[\s#])/gm, (_, expression: string) => {
    const evaluate = new Function(...Object.keys(scope), `return (${expression});`) as (
      ...values: unknown[]
    ) => unknown;
    return String(evaluate(...Object.values(scope)));
  });
}

describe('the failure email', () => {
  const never = () => {
    throw new Error('the node never ran');
  };
  const scope = (json: unknown) => ({
    $json: json,
    $: () => ({ first: () => ({ json: { channel: 'C0LARK5PUR', ts: '1793136000.000100' } }) }),
    $workflow: { name: 'Slack to DFAI' },
    $execution: { id: '42' },
  });

  it('puts every value on one line: no error can forge a header or a line', () => {
    const text = emailAs(scope({ error: 'boom\r\nBcc: someone@example.com x\u0000y' }));
    expect(text.split('\n')).toHaveLength(5);
    expect(text.split('\n')[0]).toBe(
      'A Slack message did not reach DFAI, or Slack was not told: boom Bcc: someone@example.com x y',
    );
    expect(text).toContain('Channel: C0LARK5PUR');
    expect(text).toContain('Execution: Slack to DFAI #42');
  });

  it('leaves a value empty rather than failing when its node never ran', () => {
    const text = emailAs({ ...scope({ error: 'x' }), $: never });
    expect(text).toContain('Channel: \n');
    expect(text).toContain('Message ts: \n');
  });

  it('names an error that is not text by its JSON', () => {
    expect(emailAs(scope({ error: { message: 'timeout', code: 1 } }))).toMatch(
      /told: \{"message":"timeout","code":1\}/,
    );
  });

  it('is the expression PR #617 sanitises with', () => {
    expect(emailValue('$json.x')).toBe(
      "{{ (() => { try { return String($json.x ?? ''); } catch (error) { return ''; } })().replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]+/g, ' ') }}",
    );
  });
});

/* ---- the Code nodes, run as n8n runs them ---- */

const LA = DEFAULT_TIME_ZONE;
const json = (value: unknown): Item[] => [{ json: value }];
const bytes = (text: string) => [...new TextEncoder().encode(text)];

/** The verify node as James sets it up: his secret and member id pasted in. */
const verifyRun = (body: string, headers = signedHeaders(body)): NodeRun => ({
  jsCode: verifySlackScript({ signingSecret: SECRET, settings: SETTINGS }),
  input: json({ headers, body: {} }),
  binary: bytes(body),
  now: NOW,
});

/** The rest of a capture's chain, once the verify node has answered. */
function chainRuns(verified: unknown, listing: unknown) {
  const nodes: Record<string, Item[]> = {
    [N.verify]: json(verified),
    [N.permalink]: json(permalinkAnswer),
    [N.thread]: json(repliesAnswer()),
  };
  const lookUp = { jsCode: usersToLookUpScript(), input: json({}), nodes };
  const build = {
    jsCode: buildCaptureScript(),
    input: usersAnswers.map((each) => ({ json: each })),
    nodes,
  };
  return {
    nodes,
    lookUp,
    build,
    map: (payload: unknown) => ({
      jsCode: mapCaptureScript(N.build),
      input: json(listing),
      nodes: { ...nodes, [N.build]: json(payload) },
    }),
  };
}

const items = (answer: Awaited<ReturnType<typeof runInNode>>) => {
  if ('error' in answer) throw new Error(answer.error);
  return answer.items;
};

describe('the Code nodes, run as n8n runs them', () => {
  it('verify a signed reaction and hand on what to save; a forged one is signed: false', async () => {
    expect(items(await runInNode(verifyRun(reactionBody())))[0]?.json).toMatchObject({
      signed: true,
      action: 'capture',
      kind: 'note',
      userId: OWNER,
    });
    const forged = verifyRun(reactionBody(), signedHeaders(reactionBody(), 'wrong'));
    expect(items(await runInNode(forged))[0]?.json).toEqual({
      signed: false,
      reason: 'x-slack-signature: does not match',
    });
  });

  it.each([
    ['with no signature', { 'content-type': 'multipart/form-data; boundary=x' }],
    [
      'signed for some body, fresh',
      { ...signedHeaders('{}'), 'content-type': 'multipart/form-data; boundary=x' },
    ],
  ])(
    'refuse in silence (401, no email) a request with no raw body — multipart with no file part — %s',
    async (_, headers) => {
      const run = {
        ...verifyRun('{}'),
        input: json({ headers, body: { field: 'x' } }),
        binary: undefined,
      };
      expect(items(await runInNode(run))[0]?.json).toEqual({
        signed: false,
        reason: 'no raw body',
      });
    },
  );

  it('refuse in silence a request whose item has no headers at all', async () => {
    const run = { ...verifyRun('{}'), input: json({}) };
    expect(items(await runInNode(run))[0]?.json).toMatchObject({ signed: false });
  });

  it('as committed, refuse everything until the secret is pasted in', async () => {
    const run = { ...verifyRun(shortcutBody()), jsCode: jsCodeOf(N.verify) };
    expect(items(await runInNode(run))[0]?.json).toMatchObject({
      signed: false,
      reason: /not set/,
    });
  });

  it('throw to the error output for a signed body that cannot be read', async () => {
    expect(await runInNode(verifyRun('{nope'))).toEqual({
      error: expect.stringMatching(/^UnreadableSlackRequest: signed by Slack, but body: not JSON/),
    });
  });

  it('map the fetched message to the very file the app writes for it (the golden)', async () => {
    const verified = items(await runInNode(verifyRun(shortcutBody())))[0]?.json;
    const chain = chainRuns(verified, { statusCode: 404, body: {} });
    const lookUps = items(await runInNode(chain.lookUp)).map((each) => each.json);
    expect(lookUps).toEqual([
      { userId: OWNER },
      { userId: 'U0MARAQ111' },
      { userId: 'U0TOBIAS22' },
    ]);
    const payload = items(await runInNode(chain.build))[0]?.json;
    const mapped = items(await runInNode(chain.map(payload)))[0]?.json as Record<string, unknown>;
    const app = mapCapture(payload, { timeZone: LA, writeMarkdown: writeCaptureMarkdown });
    expect(mapped).toEqual({ ...app, held: null });
    expect(app.content).toContain("external_id: 'C0LARK5PUR/1793136000.000100'");
    expect(app.content).toContain('## Thread');
    expect(app.content).toContain(
      '[renewal.pdf](https://larkspur.slack.com/files/U0MARAQ111/F1/renewal.pdf)',
    );
  });

  it('find the message already in pkm-space under another title, and say so', async () => {
    const verified = items(await runInNode(verifyRun(reactionBody())))[0]?.json;
    const payload = items(await runInNode(chainRuns(verified, null).build))[0]?.json;
    const app = mapCapture(payload, { timeZone: LA, writeMarkdown: writeCaptureMarkdown });
    const name = `Another title${app.keyEnding}`;
    const listing = { statusCode: 200, body: [{ name: 'Unrelated.md' }, { name }] };
    const mapped = items(await runInNode(chainRuns(verified, listing).map(payload)))[0]?.json;
    expect(mapped).toMatchObject({ held: `Inbox/Captures/${name}` });
    const reply = await runInNode({
      jsCode: replyScript('held'),
      input: json(mapped),
      nodes: { [N.verify]: json(verified), [N.map]: json(mapped) },
    });
    expect(items(reply)[0]?.json).toEqual({
      channel: OWNER,
      text: `Already in pkm-space, not saved again: Inbox/Captures/${name}`,
    });
  });

  it('refuse, to the error output, a payload the contract refuses, and a listing GitHub did not give', async () => {
    const verified = items(await runInNode(verifyRun(reactionBody())))[0]?.json;
    const chain = chainRuns(verified, { statusCode: 403, body: {} });
    const payload = items(await runInNode(chain.build))[0]?.json;
    expect(await runInNode(chain.map(payload))).toEqual({
      error: expect.stringMatching(/^ListingError: GitHub answered 403/),
    });
    const refused = await runInNode(
      chainRuns(verified, { statusCode: 404 }).map({ ...(payload as object), kind: 'memo' }),
    );
    expect(refused).toEqual({
      error: expect.stringMatching(/kind: "memo" is not "note" or "task"/),
    });
  });

  it('reply to James, naming why DFAI did not take it', async () => {
    const verified = items(await runInNode(verifyRun(reactionBody())))[0]?.json;
    const reply = await runInNode({
      jsCode: replyScript('committed'),
      input: json({ content: {} }),
      nodes: {
        [N.verify]: json(verified),
        [N.map]: json({ path: 'Inbox/Captures/R (slack 01).md' }),
        [N.send]: json({ error: 'connect ECONNREFUSED' }),
      },
    });
    expect(items(reply)[0]?.json).toEqual({
      channel: OWNER,
      text: 'Saved to pkm-space for DFAI (DFAI did not answer): Inbox/Captures/R (slack 01).md',
    });
  });
});

/* ---- JavaScriptCore ---- */

describe('where the Slack parity test runs', () => {
  it.runIf(!existsSync(JSC))(
    'says JavaScriptCore parity is not checked here: jsc is macOS’s',
    () => {
      expect(existsSync(JSC)).toBe(false);
    },
  );
});

describe.skipIf(!existsSync(JSC))('the Code nodes in JavaScriptCore', () => {
  it('answer every node of a capture byte for byte as Node does, refusals too', async () => {
    const verifies = [
      verifyRun(reactionBody()),
      verifyRun(shortcutBody({ callback_id: 'dfai_save_note' })),
      verifyRun(reactionBody(), signedHeaders(reactionBody(), 'wrong')),
      verifyRun('{nope'),
      verifyRun(JSON.stringify({ type: 'url_verification', challenge: 'c0ffee' })),
      verifyRun('{"text":"Café — naïve 😀"}'),
    ];
    const verified = items(await runInNode(verifies[0] as NodeRun))[0]?.json;
    const chain = chainRuns(verified, {
      statusCode: 200,
      body: [{ name: 'Other (slack 0000000000000000).md' }],
    });
    const payload = items(await runInNode(chain.build))[0]?.json;
    const replies = (['saved', 'committed', 'held', 'failed'] as const).map((outcome) => ({
      jsCode: replyScript(outcome),
      input: json({
        error: 'a\n<!channel>',
        statusCode: 201,
        body: { capture: { path: 'Inbox/Captures/R.md', outcome: 'written' } },
      }),
      nodes: {
        [N.verify]: json(verified),
        [N.map]: json({ path: 'P.md', held: 'H.md' }),
        [N.send]: json({ statusCode: 503 }),
      },
    }));
    const runs: NodeRun[] = [
      ...verifies,
      chain.lookUp,
      chain.build,
      chain.map(payload),
      chainRuns(verified, { statusCode: 500 }).map(payload),
      ...replies,
    ];
    const inNode = await Promise.all(runs.map(runInNode));
    expect(runInJavaScriptCore(runs)).toEqual(inNode);
    expect(inNode.filter((answer) => 'error' in answer)).toHaveLength(2);
  }, 60_000);
});
