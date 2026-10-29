/**
 * `atlas_capture` (#106, ADR-0049) is `POST /v1/captures` and nothing else:
 * the tool's input becomes a capture/v1 payload, the route's answer comes
 * back as it is, and a capture with no permalink never leaves the server.
 * All names are made up.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { AtlasClient } from '../client.ts';
import { createAtlasServer } from '../server.ts';
import { errorBody, startFakeAtlas, type FakeAtlas } from '../testing/fake-atlas.ts';
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
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const connect = async () => ({ baseUrl: atlas.baseUrl, token: 'capture-token' });
  await createAtlasServer(new AtlasClient({ connect })).connect(serverSide);
  mcp = new Client({ name: 'test', version: '1.0.0' });
  await mcp.connect(clientSide);
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

  it('requires the permalink in its schema, so the model sees it must send one', async () => {
    expect((await listed())?.inputSchema).toMatchObject({
      properties: {
        source: { required: expect.arrayContaining(['channel', 'ts', 'url', 'author']) },
      },
    });
  });
});
