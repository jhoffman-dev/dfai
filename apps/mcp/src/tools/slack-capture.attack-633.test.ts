/**
 * Attack on PR #633 (#106): what `atlas_capture` sends is what the model's
 * JSON said. capture/v1 refuses a key it does not have, "so a misspelt one
 * cannot drop content" (capture-payload.ts:113); `__proto__` is such a key,
 * and JSON.parse reads it as an own key like any other. All names are made up.
 * The schema-against-contract cases are in tools/capture-contract/.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { connectInMemoryMcp } from '../testing/in-memory-mcp.ts';

type Json = Record<string, unknown>;

const CHANNEL = 'C0LARK5PUR';
const TS = '1793136000.000100';
const PERMALINK = `https://larkspur.slack.com/archives/${CHANNEL}/p1793136000000100`;
const REPLY_TS = '1793136300.000200';
const REPLY_LINK = `https://larkspur.slack.com/archives/${CHANNEL}/p1793136300000200`;

/** A message with every field the tool takes, each one valid. */
function fullMessage(): Json {
  return {
    kind: 'note',
    title: 'Larkspur renewal',
    source: {
      channel: { id: CHANNEL, name: 'larkspur-payroll' },
      ts: TS,
      url: PERMALINK,
      author: { id: 'U0MARAQ111', name: 'Mara Quill', email: 'mara.quill@example.com' },
    },
    text: 'Send the *Larkspur* renewal by Friday <@U0TOBIAS22>',
    thread: [
      {
        ts: REPLY_TS,
        author: { id: 'U0TOBIAS22', name: 'Tobias Fenn', email: 'tobias.fenn@example.com' },
        text: 'On it.',
        url: REPLY_LINK,
      },
    ],
    attachments: [{ name: 'renewal.pdf', url: 'https://files.slack.com/renewal.pdf' }],
    users: { U0TOBIAS22: 'Tobias Fenn' },
    timeZone: 'America/Los_Angeles',
  };
}

let mcp: Client;
let sent: unknown[] = [];

beforeAll(async () => {
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({ capture: { path: 'Inbox/Captures/x.md', outcome: 'written' } }),
      {
        status: 201,
        headers: { 'content-type': 'application/json' },
      },
    );
  }) as typeof globalThis.fetch;
  mcp = await connectInMemoryMcp({ fetch });
});

afterAll(async () => {
  await mcp.close();
});

async function call(input: Json): Promise<{ refused: boolean; text: string; body: unknown }> {
  sent = [];
  const result = await mcp.callTool({ name: 'atlas_capture', arguments: input });
  const [first] = result.content as { text: string }[];
  return { refused: result.isError === true, text: first?.text ?? '', body: sent[0] };
}

describe('atlas_capture and the text it is given (attack on PR #633)', () => {
  it('sends a message’s NUL, bidi mark, emoji and accents as the model gave them', async () => {
    const text = 'Renewal\u0000 ‮Friday😀 café \ud83d';
    const tool = await call({ ...fullMessage(), text, title: '😀 Ren\u0000ewal' });

    expect(tool.refused).toBe(false);
    expect((tool.body as Json)['text']).toBe(text);
    expect((tool.body as Json)['title']).toBe('😀 Ren\u0000ewal');
  });
});

describe('atlas_capture and a "__proto__" key (attack on PR #633)', () => {
  const message = () => JSON.stringify(fullMessage());

  it('refuses a "__proto__" name in users, as the contract does, rather than dropping it', async () => {
    const input = JSON.parse(
      message().replace('"users":{', '"users":{"__proto__":"Ines Halloway",'),
    ) as Json;
    expect(Object.keys(input['users'] as Json)).toContain('__proto__');

    const tool = await call(input);

    expect({ refused: tool.refused, sent: tool.body !== undefined }).toEqual({
      refused: true,
      sent: false,
    });
  });

  // MCP SDK drops __proto__ before tools see it; follow-up.
  it.fails(
    'refuses a "__proto__" key at the top, as it does one inside source.channel',
    async () => {
      const input = JSON.parse(
        message().replace('{"kind"', '{"__proto__":{"replies":[]},"kind"'),
      ) as Json;
      expect(Object.keys(input)).toContain('__proto__');

      const tool = await call(input);

      expect({ refused: tool.refused, sent: tool.body !== undefined }).toEqual({
        refused: true,
        sent: false,
      });
      expect(tool.text).toMatch(/__proto__/);
    },
  );

  it('refuses a "__proto__" key inside source.channel (the guard the top lacks)', async () => {
    const input = JSON.parse(
      message().replace('"channel":{', '"channel":{"__proto__":{"a":1},'),
    ) as Json;

    const tool = await call(input);

    expect(tool.refused).toBe(true);
    expect(tool.text).toMatch(/Unrecognized key: "__proto__"/);
    expect(tool.body).toBeUndefined();
  });
});
