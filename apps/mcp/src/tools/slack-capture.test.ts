/**
 * `atlas_capture` (#106, ADR-0049) is `POST /v1/captures` and nothing else:
 * the tool's input becomes a capture/v1 payload, the route's answer comes
 * back as it is, and a capture with no permalink never leaves the server.
 * All names are made up.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { errorBody, startFakeAtlas, type FakeAtlas } from '../testing/fake-atlas.ts';
import { connectInMemoryMcp } from '../testing/in-memory-mcp.ts';
import { MISSING_PERMALINK } from './slack-capture.ts';

const PERMALINK = 'https://larkspur.slack.com/archives/C0LARK5PUR/p1793136000000100';
const PATH = 'Inbox/Captures/Send the Larkspur renewal by Friday (slack 2db9a3ee76a9e132).md';

const SOURCE = {
  channel: { id: 'C0LARK5PUR', name: 'larkspur-payroll' },
  ts: '1793136000.000100',
  url: PERMALINK,
  author: { id: 'U0MARAQ111', name: 'Mara Quill', email: 'mara.quill@example.com' },
};

const MESSAGE = { kind: 'task', source: SOURCE, text: 'Send the *Larkspur* renewal by Friday' };

let atlas: FakeAtlas;
let mcp: Client;

beforeEach(async () => {
  atlas = await startFakeAtlas(() => ({
    status: 201,
    body: { capture: { path: PATH, outcome: 'written' } },
  }));
  mcp = await connectInMemoryMcp({ baseUrl: atlas.baseUrl });
});

afterEach(async () => {
  await mcp.close();
  await atlas.close();
});

async function capture(args: Record<string, unknown>) {
  const result = await mcp.callTool({ name: 'atlas_capture', arguments: args });
  const [first] = result.content as { type: string; text: string }[];
  return { isError: result.isError === true, text: first?.text ?? '' };
}

describe('atlas_capture → POST /v1/captures', () => {
  it('sends the message as a capture/v1 payload from slack, and only what was given', async () => {
    const result = await capture(MESSAGE);

    expect(result.isError).toBe(false);
    expect(atlas.requests).toHaveLength(1);
    const [request] = atlas.requests;
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe('/v1/captures');
    expect(request?.body).toEqual({
      contract: 'capture/v1',
      kind: 'task',
      source: { provider: 'slack', ...SOURCE },
      text: 'Send the *Larkspur* renewal by Friday',
    });
  });

  it('passes the thread, attachments, mentions, title and zone on as the contract names them', async () => {
    const extras = {
      title: 'Larkspur renewal',
      thread: [{ ts: '1793136300.000200', author: { name: 'Tobias Fenn' }, text: 'On it.' }],
      attachments: [{ name: 'renewal.pdf', url: 'https://files.slack.com/renewal.pdf' }],
      users: { U0TOBIAS22: 'Tobias Fenn' },
      timeZone: 'America/Los_Angeles',
    };

    await capture({ ...MESSAGE, kind: 'note', ...extras });

    expect(atlas.requests[0]?.body).toEqual({
      contract: 'capture/v1',
      kind: 'note',
      source: { provider: 'slack', ...SOURCE },
      text: MESSAGE.text,
      ...extras,
    });
  });

  it('returns the receipt, written the first time and in-vault after', async () => {
    const first = await capture(MESSAGE);
    atlas.respondWith(() => ({
      status: 200,
      body: { capture: { path: PATH, outcome: 'in-vault' } },
    }));
    const again = await capture(MESSAGE);

    expect(JSON.parse(first.text)).toEqual({ capture: { path: PATH, outcome: 'written' } });
    expect(JSON.parse(again.text)).toEqual({ capture: { path: PATH, outcome: 'in-vault' } });
  });

  it.each([
    ['left out', undefined],
    ['empty', ''],
  ])('refuses a capture whose permalink is %s, saying so, before any request', async (_, url) => {
    const result = await capture({ ...MESSAGE, source: { ...SOURCE, url } });

    expect(result.isError).toBe(true);
    expect(result.text).toContain(`source.url: ${MISSING_PERMALINK}`);
    expect(atlas.requests).toHaveLength(0);
  });

  it.each([
    ['replies', { replies: [{ ts: '1793136300.000200', author: { name: 'Tobias Fenn' } }] }],
    ['files', { files: [{ name: 'renewal.pdf', url: 'https://files.slack.com/r' }] }],
    ['thread_ts', { source: { ...SOURCE, thread_ts: '1793136000.000100' } }],
    ['topic', { source: { ...SOURCE, channel: { id: 'C0LARK5PUR', topic: 'Renewals' } } }],
    ['title', { source: { ...SOURCE, author: { name: 'Mara Quill', title: 'Lead' } } }],
    [
      'shared',
      { thread: [{ ts: '1793136300.000200', author: { name: 'Tobias Fenn' }, shared: 1 }] },
    ],
    ['size', { attachments: [{ name: 'r.pdf', url: 'https://files.slack.com/r', size: 1 }] }],
  ])(
    'refuses a key the contract does not have, "%s", naming it, before any request',
    async (key, extra) => {
      const result = await capture({ ...MESSAGE, ...extra });

      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/Unrecognized key/);
      expect(result.text).toContain(`"${key}"`);
      expect(atlas.requests).toHaveLength(0);
    },
  );

  it('sends a file-only message, whose text and replies’ text may be left out', async () => {
    const attachments = [{ name: 'renewal.pdf', url: 'https://files.slack.com/renewal.pdf' }];
    const thread = [{ ts: '1793136300.000200', author: { name: 'Tobias Fenn' } }];

    const result = await capture({ kind: 'note', source: SOURCE, attachments, thread });

    expect(result.isError).toBe(false);
    expect(atlas.requests[0]?.body).toEqual({
      contract: 'capture/v1',
      kind: 'note',
      source: { provider: 'slack', ...SOURCE },
      attachments,
      thread,
    });
  });

  it('takes null for a field left out, as the contract does, and sends no null', async () => {
    const result = await capture({
      ...MESSAGE,
      title: null,
      timeZone: null,
      users: null,
      source: {
        ...SOURCE,
        channel: { id: 'C0LARK5PUR', name: null },
        author: { name: 'Mara Quill', id: null, email: null },
      },
      thread: [
        {
          ts: '1793136300.000200',
          author: { name: 'Tobias Fenn', email: null },
          text: 'On it.',
          url: null,
        },
      ],
    });

    expect(result.isError).toBe(false);
    expect(atlas.requests[0]?.body).toEqual({
      contract: 'capture/v1',
      kind: 'task',
      source: {
        provider: 'slack',
        channel: { id: 'C0LARK5PUR' },
        ts: SOURCE.ts,
        url: PERMALINK,
        author: { name: 'Mara Quill' },
      },
      text: MESSAGE.text,
      thread: [{ ts: '1793136300.000200', author: { name: 'Tobias Fenn' }, text: 'On it.' }],
    });
  });

  it('passes the contract’s refusal on whole, every reason in it', async () => {
    const reasons =
      'The capture was refused: source.url: is not a link to this message: its channel or ts differ';
    atlas.respondWith(() => ({ status: 400, body: errorBody('invalid', reasons) }));

    const result = await capture({
      ...MESSAGE,
      source: { ...SOURCE, url: 'https://larkspur.slack.com/archives/C0OTHER000/p1' },
    });

    expect(result).toEqual({ isError: true, text: `invalid: ${reasons}` });
  });
});

describe('atlas_capture as listed', () => {
  const listed = async () => (await mcp.listTools()).tools.find((t) => t.name === 'atlas_capture');

  it('writes without destroying, and the same message twice is one note', async () => {
    expect((await listed())?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it('tells the model to pass the link and the message’s key, choose the kind, and invent nothing', async () => {
    const description = (await listed())?.description ?? '';

    expect(description).toMatch(/Always pass the message's permalink as source\.url/);
    expect(description).toMatch(/channel id and ts/);
    expect(description).toMatch(/Choose kind from the person's words/);
    expect(description).toMatch(/never invent, summarise or fill in content you did not read/);
  });

  it('tells the model a second save adds nothing, so it says the note exists, and what exists means', async () => {
    const description = (await listed())?.description ?? '';

    expect(description).toMatch(/A second call for the same message adds nothing/);
    expect(description).toMatch(/tell the person the note already exists/);
    expect(description).toMatch(/"exists"/);
  });

  it('lists every object in its schema as closed, so the model knows a misspelt field is refused', async () => {
    const schema = (await listed())?.inputSchema;

    expect(schema).toMatchObject({
      additionalProperties: false,
      properties: {
        source: {
          additionalProperties: false,
          properties: {
            channel: { additionalProperties: false },
            author: { additionalProperties: false },
          },
        },
        thread: {
          items: {
            additionalProperties: false,
            properties: { author: { additionalProperties: false } },
          },
        },
        attachments: { items: { additionalProperties: false } },
      },
    });
  });

  it('requires the permalink in its schema, so the model sees it must send one', async () => {
    expect((await listed())?.inputSchema).toMatchObject({
      properties: {
        source: { required: expect.arrayContaining(['channel', 'ts', 'url', 'author']) },
      },
    });
  });
});
