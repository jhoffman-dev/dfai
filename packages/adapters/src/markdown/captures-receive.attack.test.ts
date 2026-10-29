import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import type { Nodes, Root } from 'mdast';
import { describe, expect, it } from 'vitest';
import { apiFixture, bodyOf } from '@dfai/application';
import { atlasQueryIndex } from '@dfai/application/testing/sqlite';
import {
  mapCapture as mapDomainCapture,
  splitFrontmatter,
  splitWikiLinksAndEmbeds,
} from '@dfai/domain';
import { slackCapture, slackSource } from '@dfai/domain/testing';
import { parseMarkdownBody, renderBlock } from './markdown-blocks.ts';
import { remarkMarkdown } from './markdown-port.ts';
import { writeCaptureMarkdown } from './capture-markdown.ts';
import type { CaptureOptions } from '@dfai/domain';
/** The domain's mapper with the editor's serializer, as the app maps a capture (ADR-0049). */
const mapCapture = (payload: unknown, options: Partial<CaptureOptions> = {}) =>
  mapDomainCapture(payload, { writeMarkdown: writeCaptureMarkdown, ...options });

/*
 * Adversarial cases for POST /v1/captures (#103, attack on PR #615). Each
 * test names one promise ADR-0049 makes — "everything else a sender wrote is
 * words", "a bare address is written as an explicit link", "a line of `-` is
 * kept from being a rule", "a message is saved once" — and an input that
 * breaks it. All names are made up.
 */

type ApiFixture = ReturnType<typeof apiFixture>;

/** The body as the editor writes it back once each of its blocks is edited. */
const editedBack = (body: string) =>
  parseMarkdownBody(body)
    .doc.content.map((node) => renderBlock(node))
    .join('\n\n');

const bodyOfFile = (payload: Record<string, unknown>) =>
  splitFrontmatter(mapCapture(payload).content).body;

/** The wiki links and embeds the index would read in `markdown`. */
const linksIn = (markdown: string) =>
  splitWikiLinksAndEmbeds(markdown).filter((piece) => piece.kind !== 'text');

function* nodesOf(node: Nodes): Generator<Nodes> {
  yield node;
  if ('children' in node) for (const child of node.children) yield* nodesOf(child as Nodes);
}

const parse = (body: string) => unified().use(remarkParse).use(remarkGfm).parse(body) as Root;

const ADDRESS = 'https://example.com/[[Mara Quill]]';
const EMBED = 'https://example.com/![[Payroll secrets]]';

describe('a bare address in a sender’s words never becomes a wiki link once edited', () => {
  // tokenText (capture-mrkdwn.ts:256-270) writes a mention's name and a token's label with
  // writer.words alone, never through linkBareAddresses: the escaped `https\://…\[\[…\]\]`
  // is read by the editor as one autolink, and written back without its escapes.
  it.each([
    ['a mention named by `users`', { text: 'cc <@U0TOBIAS22>', users: { U0TOBIAS22: ADDRESS } }],
    ['a mention’s own label', { text: `cc <@U0NOBODY99|${ADDRESS}>` }],
    ['a channel mention’s label', { text: `see <#C0LARK5PUR|${ADDRESS}>` }],
    ['a user group’s label', { text: `<!subteam^S0LARKPAY|${ADDRESS}>` }],
    ['a date’s fallback', { text: `<!date^1793136000^{date}|${ADDRESS}>` }],
    ['the label of a link of another scheme', { text: `<javascript:alert(1)|${ADDRESS}>` }],
  ])('%s', (_, fields) => {
    const body = bodyOfFile(slackCapture({ ...fields, thread: [], attachments: [] }));
    expect(linksIn(body)).toEqual([]);
    expect(linksIn(editedBack(body))).toEqual([]);
  });

  // BARE_ADDRESS (capture-mrkdwn.ts:161) links an address only after a character that is not
  // a letter, a digit or `_`, but the editor's autolink starts after any non-ASCII letter or
  // digit too, and swallows the escapes after it.
  it.each([
    ['after a non-ASCII letter', `é${ADDRESS}`],
    ['after a non-ASCII digit', `٣${ADDRESS}`],
    ['as an embed, after a non-ASCII letter', `é${EMBED}`],
  ])('in a message’s text, %s', (_, text) => {
    const body = bodyOfFile(slackCapture({ text, thread: [], attachments: [] }));
    expect(linksIn(body)).toEqual([]);
    expect(linksIn(editedBack(body))).toEqual([]);
  });

  it('in an author’s name, after a non-ASCII letter', () => {
    const source = slackSource({ author: { name: `é${ADDRESS}` } });
    const body = bodyOfFile(slackCapture({ source, thread: [], attachments: [] }));
    expect(linksIn(body)).toEqual([]);
    expect(linksIn(editedBack(body))).toEqual([]);
  });
});

describe('a link GFM reads in a message is only one the mapper wrote', () => {
  // After `_` BARE_ADDRESS does not link the address and SPECIAL leaves its `:` alone
  // (no \b between `_` and `h`), so GFM autolinks `https://example.com/\#tag`: a link to an
  // address with a backslash in it, its label showing the escape.
  it.each(['a_https://example.com/#tag', '_www.example.com/#tag'])('%s', (text) => {
    const body = bodyOfFile(slackCapture({ text, thread: [], attachments: [] }));
    const links = [...nodesOf(parse(body))].filter((node) => node.type === 'link');
    for (const link of links) {
      expect(body.slice(link.position?.start.offset, (link.position?.start.offset ?? 0) + 1)).toBe(
        '[',
      );
    }
  });
});

describe('a line of dashes is never a rule', () => {
  // RULE_LINE (capture-mrkdwn.ts:50) escapes a line that is only marks, but `1. ---` is a
  // list item whose content is a thematic break.
  it.each(['1. ---', '1) - - -', '- 1. ---'])('%s', (text) => {
    const body = bodyOfFile(slackCapture({ text, thread: [], attachments: [] }));
    const kinds = new Set([...nodesOf(parse(body))].map((node) => node.type));
    expect(kinds.has('thematicBreak')).toBe(false);
  });
});

function vault(files: Record<string, string> = {}): ApiFixture {
  const indexed = atlasQueryIndex({ files, markdown: remarkMarkdown });
  return apiFixture({ files, markdown: remarkMarkdown, index: { query: indexed } });
}

const send = (api: ApiFixture, body: unknown) =>
  api.send({ method: 'POST', path: '/v1/captures', body });

/** A message in C0LARK5PUR at `ts`, with its permalink. */
const messageAt = (ts: string) =>
  slackCapture({
    title: 'Follow up',
    source: slackSource({
      ts,
      url: `https://larkspur.slack.com/archives/C0LARK5PUR/p${ts.replace('.', '')}`,
    }),
    thread: [],
  });

describe('two messages are two notes, whatever their keys hash to', () => {
  // The path's only key was shortHash, 32-bit FNV-1a: these two keys, 71 seconds apart in
  // one channel, shared `0cf0ba11`, and with one title the second was refused `exists`.
  // (Amended with the fix: the suffix is now 64 bits, so this pair no longer collides, and a
  // collision that does happen is written at a numbered path. The first assertion of the
  // attack, that the pair shares an ending, could only hold for the 32-bit hash.)
  const first = messageAt('1793136261.009000');
  const second = messageAt('1793136332.080000');

  it('saves the second message of the attack’s pair, whose names no longer clash', async () => {
    expect(mapCapture(first).keyEnding).not.toBe(mapCapture(second).keyEnding);
    const api = vault();
    expect((await send(api, first)).status).toBe(201);
    const response = await send(api, second);
    expect(response.status).toBe(201);
    expect(bodyOf(response)).toMatchObject({ capture: { outcome: 'written' } });
  });

  it('saves the second message of a hash collision, at a numbered path', async () => {
    // The clash made by hand: the first message's note at the second's own path.
    const taken = mapCapture(second).path;
    const api = vault({ [taken]: mapCapture(first).content });
    const response = await send(api, second);
    expect(response.status).toBe(201);
    expect(bodyOf(response)).toEqual({
      capture: { path: taken.replace(').md', ' 2).md'), outcome: 'written' },
    });
    expect(api.files.get(taken)?.text).toBe(mapCapture(first).content);
  });
});
