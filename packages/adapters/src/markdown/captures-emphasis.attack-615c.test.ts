import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import type { Nodes, Root } from 'mdast';
import { describe, expect, it } from 'vitest';
import { mapCapture, splitFrontmatter } from '@dfai/domain';
import { slackCapture } from '@dfai/domain/testing';
import { parseMarkdownBody, renderBlock } from './markdown-blocks.ts';
import { writeCaptureMarkdown } from './capture-markdown.ts';

/*
 * Third attack on PR #615 (#103): two of Slack's bold or italic side by side
 * are written `**a**__b__` — the second neighbour's marker is `_`
 * (`emphasis-handlers.ts`) — and `_` is a character of a mail address's
 * name. With a domain after it, GFM reads `__b__@example.com` as a mail
 * link: a link the mapper did not write, and the bold gone. All names are
 * made up.
 */

const parse = (markdown: string) =>
  unified().use(remarkParse).use(remarkGfm).parse(markdown) as Root;

function* nodesOf(node: Nodes): Generator<Nodes> {
  yield node;
  if ('children' in node) for (const child of node.children) yield* nodesOf(child as Nodes);
}

const messageOf = (text: string) => {
  const { body } = splitFrontmatter(
    mapCapture(slackCapture({ text, thread: [], attachments: [] }), {
      writeMarkdown: writeCaptureMarkdown,
      timeZone: 'UTC',
    }).content,
  );
  return body;
};

const mailLinks = (markdown: string) =>
  [...nodesOf(parse(markdown))].flatMap((node) =>
    node.type === 'link' && node.url.startsWith('mailto:') ? [node.url] : [],
  );

const edited = (body: string) =>
  parseMarkdownBody(body)
    .doc.content.map((node) => renderBlock(node))
    .join('\n\n');

describe('emphasis side by side before a domain makes no mail link (third attack on PR #615)', () => {
  it.each([
    ['two bolds', '*Mara**Quill*@example.com'],
    ['two italics', '_Mara__Quill_@example.com'],
    ['two bold italics', '_*Mara*__*Quill*_@example.com'],
  ])('%s: no link the mapper did not write, as written and once edited', (_, text) => {
    const body = messageOf(text);
    expect(mailLinks(body)).toEqual([]);
    expect(mailLinks(edited(body))).toEqual([]);
  });

  it('keeps the second bold bold', () => {
    const body = messageOf('*Mara**Quill*@example.com');
    const bold = [...nodesOf(parse(body))].filter((node) => node.type === 'strong');
    const words = bold.map((node) =>
      [...nodesOf(node)].flatMap((n) => (n.type === 'text' ? [n.value] : [])).join(''),
    );
    expect(words).toContain('Quill');
  });
});

describe('the editor’s own save of bold then italic before a domain (on main too)', () => {
  it('reads back as bold, italic and words, with no mail link', () => {
    const typed = {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Mara', marks: [{ type: 'bold' }] },
        { type: 'text', text: 'Quill', marks: [{ type: 'italic' }] },
        { type: 'text', text: '@example.com' },
      ],
    };
    const saved = renderBlock(typed as Parameters<typeof renderBlock>[0]);
    expect(mailLinks(saved)).toEqual([]);
    const [read] = parseMarkdownBody(`${saved}\n`).doc.content;
    expect(read?.content).toEqual(typed.content);
  });
});
