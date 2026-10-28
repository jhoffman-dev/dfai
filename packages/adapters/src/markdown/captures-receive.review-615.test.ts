/**
 * Regressions from PR #615's review (#103): a sender's text must never make
 * a link, a relation, an embed or a crash out of a capture. Each payload is
 * the review's own, run through the real YAML reader, parser and index.
 * All names are made up.
 */
import { describe, expect, it } from 'vitest';
import { apiFixture, bodyOf, codeOf } from '@dfai/application';
import { atlasQueryIndex } from '@dfai/application/testing/sqlite';
import {
  noteTags,
  relationsOf,
  slackToMarkdown,
  splitFrontmatter,
  splitWikiLinksAndEmbeds,
} from '@dfai/domain';
import { SLACK_PERMALINK, slackCapture, slackSource } from '@dfai/domain/testing';
import { parseMarkdownBody, renderBlock } from './markdown-blocks.ts';
import { remarkMarkdown } from './markdown-port.ts';

const MARA = '---\ntype: person\nemail: mara.quill@example.com\n---\n\nPayroll lead.\n';

function vault(files: Record<string, string> = { 'People/Mara Quill.md': MARA }) {
  return apiFixture({
    files,
    markdown: remarkMarkdown,
    index: { query: atlasQueryIndex({ files, markdown: remarkMarkdown }) },
  });
}

/** The capture's file once written, or a failure naming what the route answered. */
async function written(body: unknown): Promise<string> {
  const api = vault();
  const response = await api.send({ method: 'POST', path: '/v1/captures', body });
  if (response.status !== 201)
    throw new Error(`answered ${response.status}: ${JSON.stringify(response.body)}`);
  const path = (bodyOf(response)['capture'] as { path: string }).path;
  return api.files.get(path)?.text ?? '';
}

const relationsIn = (text: string) =>
  relationsOf(remarkMarkdown.frontmatterProperties(splitFrontmatter(text).frontmatter), () => null);

const refused = async (body: unknown) =>
  codeOf(await vault().send({ method: 'POST', path: '/v1/captures', body }));

describe('review #615 MAJOR 1: sender text in the frontmatter makes no relation', () => {
  it('writes an author’s and a channel’s brackets so they link nothing', async () => {
    const text = await written(
      slackCapture({
        source: slackSource({
          author: { name: 'Tobias [[Mara Quill]]' },
          channel: { id: 'C0LARK5PUR', name: 'ops [[Payroll]]' },
        }),
        thread: [],
      }),
    );
    expect(relationsIn(text)).toEqual([]);
  });

  it('refuses an address holding brackets', async () => {
    const author = { name: 'Tobias', email: 'a@[[Board]]' };
    expect(await refused(slackCapture({ source: slackSource({ author }) }))).toBe('invalid');
  });

  it('refuses a permalink whose query holds brackets', async () => {
    const url = `${SLACK_PERMALINK}?x=[[Secret]]`;
    expect(await refused(slackCapture({ source: slackSource({ url }), thread: [] }))).toBe(
      'invalid',
    );
  });
});

/** The wiki links and embeds the body holds, as the index reads them. */
const linksIn = (text: string) =>
  splitWikiLinksAndEmbeds(splitFrontmatter(text).body).filter((piece) => piece.kind !== 'text');

describe('review #615 MAJOR 2: a link’s address holds no wiki link or embed', () => {
  it.each([
    ['a labelled link', '<https://example.com/[[Mara]]|see>'],
    ['a bare link', '<https://example.com/[[Mara]]>'],
    ['a mail link', '<mailto:[[Mara]]@example.com>'],
    ['an embed in a link', '<https://example.com/![[Mara]]|see>'],
    ['a link amid words', 'see <https://example.com/[[Mara]]|this> now'],
    ['angle brackets in a link', '<https://example.com/a&lt;b&gt;|see>'],
  ])('writes %s so the index reads no link in it', async (_, text) => {
    // An author no Person matches, so the only links there could be are the sender's.
    const author = { name: 'Tobias Fenn' };
    const written_ = await written(
      slackCapture({ text, source: slackSource({ author }), thread: [], attachments: [] }),
    );
    expect(linksIn(written_)).toEqual([]);
    expect(splitFrontmatter(written_).body).toMatch(/\]\(https?:|\]\(mailto:/);
  });

  it('refuses an attachment whose link holds brackets', async () => {
    const attachments = [{ name: 'a', url: 'https://files.slack.com/[[Mara Quill]].pdf' }];
    expect(await refused(slackCapture({ attachments }))).toBe('invalid');
  });
});

/** The body as the editor writes it back once each of its blocks is edited. */
function editedBack(body: string): string {
  return parseMarkdownBody(body)
    .doc.content.map((node) => renderBlock(node))
    .join('\n\n');
}

const readAsMarkup = (markdown: string) => ({
  links: splitWikiLinksAndEmbeds(markdown).filter((piece) => piece.kind !== 'text'),
  tags: noteTags({
    tagsProperty: undefined,
    body: markdown,
    ranges: remarkMarkdown.textRanges(markdown),
  }),
});

describe('review #615 MAJOR 3: a bare address stays words after the paragraph is edited', () => {
  it.each([
    ['a wiki link after an address', 'https://example.com/[[Mara]] x'],
    ['a tag after an address', 'https://example.com/a #tag'],
    ['an address with no scheme', 'see www.example.com/[[Mara]] and #ops'],
    ['an address ending a sentence', 'read https://example.com/a. Then [[Mara]] #ops'],
    ['an address in brackets', '(https://example.com/a) [[Mara]] #ops'],
    ['an email address', 'mail mara@example.com [[Mara]] #ops'],
  ])('keeps %s from becoming a link or a tag', (_, text) => {
    const body = slackToMarkdown(text).join('\n');
    expect(readAsMarkup(body)).toEqual({ links: [], tags: [] });
    expect(readAsMarkup(editedBack(body))).toEqual({ links: [], tags: [] });
  });

  it('holds for the whole note, its quote edited', async () => {
    const author = { name: 'Tobias Fenn' };
    const text = await written(
      slackCapture({
        text: 'https://example.com/[[Mara]] x #tag',
        source: slackSource({ author }),
        thread: [],
      }),
    );
    const edited = editedBack(splitFrontmatter(text).body);
    expect(readAsMarkup(edited)).toEqual({ links: [], tags: [] });
  });
});

describe('review #615 MAJOR 4: a mention never reads a name through the prototype', () => {
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    'writes <@%s> by what it says, and is saved',
    async (id) => {
      const author = { name: 'Tobias Fenn' };
      const text = await written(
        slackCapture({
          text: `hey <@${id}>`,
          source: slackSource({ author }),
          thread: [],
          users: {},
        }),
      );
      expect(splitFrontmatter(text).body).toContain(`> hey @${id.replace(/_/g, '\\_')}`);
    },
  );

  it('answers a failure that is not a refusal as internal, writing nothing', async () => {
    const api = apiFixture({
      markdown: remarkMarkdown,
      index: { query: async () => Promise.reject(new Error('index closed')) },
    });
    const response = await api.send({ method: 'POST', path: '/v1/captures', body: slackCapture() });
    expect(response.status).toBe(500);
    expect(codeOf(response)).toBe('internal');
    expect(api.writes).toEqual([]);
  });
});
