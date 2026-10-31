/**
 * Third attack on PR #615 (#103): the capture's tree, written by the editor's
 * serializer, held to a reading fixpoint. A wider generator than the hostile
 * round trip's: every Slack token type, nested emphasis, code spans and code
 * blocks holding addresses, quoted lines, list and heading starts, very long
 * words, and the address edges of IPv6, ports, userinfo, IDN, trailing quote
 * and star, markdown characters in a path, and mail with `+`, quotes and IP
 * literals. Oracle, for every seed: each link the body holds is one the
 * mapper wrote with `[`, to an absolute address; nothing but words, quotes,
 * code and those links; and parsed, edited and parsed again, every character
 * reads with the same marks and links. Seeded; all names are made up.
 *
 * Test support: the seeds are run by the four
 * captures-roundtrip.attack-615c.seeds-*.property.test.ts files.
 */
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import type { Nodes, Root } from 'mdast';
import { describe, expect, it } from 'vitest';
import {
  CaptureRefusedError,
  mapCapture as mapDomainCapture,
  noteTags,
  splitFrontmatter,
  splitWikiLinksAndEmbeds,
} from '@dfai/domain';
import {
  SLACK_PERMALINK,
  SLACK_REPLY_TS,
  seededRandom,
  slackCapture,
  slackSource,
} from '@dfai/domain/testing';
import { parseMarkdownBody, renderBlock } from './markdown-blocks.ts';
import { remarkMarkdown } from './markdown-port.ts';
import { writeCaptureMarkdown } from './capture-markdown.ts';

const mapCapture = (payload: unknown) =>
  mapDomainCapture(payload, { writeMarkdown: writeCaptureMarkdown, timeZone: 'UTC' });

const editedBack = (body: string) =>
  parseMarkdownBody(body)
    .doc.content.map((node) => renderBlock(node))
    .join('\n\n');

const parse = (body: string) => unified().use(remarkParse).use(remarkGfm).parse(body) as Root;

const PIECES: readonly string[] = [
  'words',
  ' ',
  ' ',
  ' ',
  '\n',
  '\n\n',
  '&gt; ',
  '\n&gt; ',
  '> ',
  '\n- ',
  '\n* ',
  '\n+ ',
  '\n1. ',
  '\n1) ',
  '\n• ',
  '\n# ',
  '\n===',
  '\n---',
  '\n| a |',
  '#ops',
  'C#',
  'a#b',
  '#',
  '##',
  ' #x',
  '*',
  '_',
  '~',
  '`',
  "'",
  '"',
  '\\',
  '[',
  ']',
  '(',
  ')',
  '|',
  '&amp;',
  '&lt;',
  '&gt;',
  '*bold*',
  '_it_',
  '~st~',
  '*_~deep~_*',
  '_*both*_',
  '~*x*~',
  '* spaced *',
  '<@U0TOBIAS22>',
  '<@U0NOBODY99|www>',
  '<@U0NOBODY99|mara>',
  '<#C0LARK5PUR|example.com>',
  '@example.com',
  '.example.com',
  '<@U0NOBODY99|someone>',
  '<@U0NOBODY99>',
  '<#C0LARK5PUR|ops>',
  '<#C0LARK5PUR>',
  '<!here>',
  '<!channel>',
  '<!everyone>',
  '<!subteam^S0LARKPAY|@payroll>',
  '<!date^1793136000^{date}|Oct 27>',
  '<mailto:mara@example.com|mail me>',
  '<tel:+15550100|call>',
  '<slack://open|app>',
  '<javascript:alert(1)|x>',
  '<http://example.com>',
  '<www.example.com>',
  '<https://example.com/a_b*c|lab*el>',
  '<https://example.com|https://example.com>',
  '`www.example.com`',
  '`mara@example.com`',
  '`https://example.com/x`',
  '```\nhttps://example.com/in-code www.x.com a@b.co\n```',
  'https://example.com/x',
  'www.example.com',
  'WWW.EXAMPLE.COM',
  'mara@example.com',
  'http://[::1]/',
  'http://[::1]:8080/x',
  'http://example.com:8080/p',
  'http://a@example.com',
  'http://user:pw@example.com/',
  'http://exämple.рф/',
  "https://example.com/x'",
  'https://example.com/x*',
  'https://example.com/*_~`|#^',
  'https://example.com/a(b)c',
  'https://example.com/&amp;lt;',
  'a+b@example.com',
  '"a"@example.com',
  'a@[1.2.3.4]',
  'a@1.2.3.4',
  'a.b-c_d@ex-ample.co.uk',
  '[[Secret]]',
  '![[Secret]]',
  '^abc',
  ' ^abc',
  '==hi==',
  '$x$',
  '$$',
  '[^1]',
  '<b>',
  '<!-- c -->',
  'é',
  '😀',
];

function messageText(random: () => number, most: number): string {
  const count = 1 + Math.floor(random() * most);
  return Array.from({ length: count }, () => {
    if (random() < 0.02) return 'w'.repeat(2000 + Math.floor(random() * 3000));
    if (random() < 0.01) return `https://example.com/${'p'.repeat(3000)}`;
    return PIECES[Math.floor(random() * PIECES.length)];
  }).join('');
}

function payload(random: () => number) {
  return slackCapture({
    kind: random() < 0.5 ? 'note' : 'task',
    text: messageText(random, 30),
    source: slackSource({
      channel: { id: 'C0LARK5PUR', name: 'larkspur-payroll' },
      author: { name: 'Mara Quill' },
      url: SLACK_PERMALINK,
    }),
    thread: [
      { ts: SLACK_REPLY_TS, author: { name: 'Tobias Fenn' }, text: messageText(random, 15) },
    ],
    attachments: [],
    users: { U0TOBIAS22: 'Tobias Fenn' },
  });
}

function* nodesOf(node: Nodes): Generator<Nodes> {
  yield node;
  if ('children' in node) for (const child of node.children) yield* nodesOf(child as Nodes);
}

const ALLOWED = new Set([
  'root',
  'paragraph',
  'text',
  'strong',
  'emphasis',
  'delete',
  'inlineCode',
  'code',
  'blockquote',
  'link',
  'heading',
  'list',
  'listItem',
  'break',
]);
const ADDRESS = /^(?:https?:\/\/|mailto:)/i;

/** Each character of a block as a reader sees it: its block path, its marks, and its link. */
function readingOf(tree: Root): string[] {
  const out: string[] = [];
  const walk = (node: Nodes, path: string, marks: string) => {
    if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'code') {
      const kind = node.type === 'text' ? '' : node.type;
      for (const character of node.value)
        out.push(
          `${path}|${[...new Set([...marks.split(','), kind])].filter(Boolean).sort().join(',')}|${character}`,
        );
      return;
    }
    if (node.type === 'break') {
      out.push(`${path}|${marks}|\n`);
      return;
    }
    const isBlock = !['strong', 'emphasis', 'delete', 'link'].includes(node.type);
    const mark = node.type === 'link' ? `link:${node.url}` : isBlock ? '' : node.type;
    if ('children' in node)
      (node.children as Nodes[]).forEach((child, index) =>
        walk(
          child,
          isBlock && node.type !== 'paragraph' ? `${path}/${node.type}${index}` : path,
          [marks, mark].filter(Boolean).join(','),
        ),
      );
  };
  walk(tree, '', '');
  return trimmedBlocks(out);
}

function expectOnlyWords(markdown: string, written: ReadonlySet<string>): void {
  const tree = parse(markdown);
  for (const node of nodesOf(tree)) {
    expect(ALLOWED.has(node.type), `a ${node.type} the mapper did not write`).toBe(true);
    if (node.type === 'link') {
      expect(node.url, 'a link to no absolute address').toMatch(ADDRESS);
      expect(
        markdown[node.position?.start.offset ?? 0],
        `a link read from words: ${node.url}`,
      ).toBe('[');
      expect(written.has(node.url), `a link the mapper did not write: ${node.url}`).toBe(true);
    }
  }
  expect(splitWikiLinksAndEmbeds(markdown).filter((piece) => piece.kind !== 'text')).toEqual([]);
  const ranges = remarkMarkdown.textRanges(markdown);
  expect(noteTags({ tagsProperty: undefined, body: markdown, ranges })).toEqual([]);
}

function bodyOf(sent: unknown): string | null {
  try {
    return splitFrontmatter(mapCapture(sent).content).body;
  } catch (error) {
    if (error instanceof CaptureRefusedError) return null;
    throw error;
  }
}

/** The seeds the attack runs, 400 in all. */
export const SEEDS = 400;

/**
 * The seeds of each file the attack is split over, in order: seeds-1 runs the
 * first, seeds-2 the second (captures-roundtrip.attack-615c.seeds.test.ts
 * holds the files to it).
 */
export const SEED_PARTS = [
  { from: 1, to: 100 },
  { from: 101, to: 200 },
  { from: 201, to: 300 },
  { from: 301, to: 400 },
] as const;

/**
 * Seeds `from` to `to` of the attack, each its own test. The 400 are split over
 * four files (captures-roundtrip.attack-615c.seeds-*.property.test.ts) only so
 * that they run side by side: together they took five minutes on CI (#648).
 */
export function describeSeeds({ from, to }: { readonly from: number; readonly to: number }): void {
  describe(`a capture reads the same once edited, over seeds ${from} to ${to} of ${SEEDS} (third attack, PR #615)`, () => {
    it.each(Array.from({ length: to - from + 1 }, (_, at) => from + at))(
      'seed %i: only its own absolute links, and a reading fixpoint across an edit',
      (seed) => {
        const body = bodyOf(payload(seededRandom(seed * 7919)));
        if (body === null) return;
        const written = new Set(
          [...nodesOf(parse(body))].flatMap((node) => (node.type === 'link' ? [node.url] : [])),
        );
        expectOnlyWords(body, written);
        const edited = editedBack(body);
        expectOnlyWords(edited, written);
        expect(readingOf(parse(edited))).toEqual(readingOf(parse(body)));
        // The editor takes escapes off over two saves (A21-01); from the second on, nothing changes.
        const again = editedBack(edited);
        expect(readingOf(parse(again))).toEqual(readingOf(parse(body)));
        expect(editedBack(again)).toBe(again);
      },
      // A seed with a 5,000-letter word takes most of a second alone, and more on a loaded runner.
      30_000,
    );
  });
}

/** A block's reading without the white space at its ends, which the editor drops on save. */
function trimmedBlocks(reading: readonly string[]): string[] {
  const blank = (token: string) => /^[ \t\n\r]$/.test(token.slice(token.lastIndexOf('|') + 1));
  const block = (token: string) => token.slice(0, token.indexOf('|'));
  return reading.filter((token, at) => {
    if (!blank(token)) return true;
    let before = at - 1;
    while (before >= 0 && block(reading[before]!) === block(token) && blank(reading[before]!))
      before -= 1;
    let after = at + 1;
    while (
      after < reading.length &&
      block(reading[after]!) === block(token) &&
      blank(reading[after]!)
    )
      after += 1;
    const first = before < 0 || block(reading[before]!) !== block(token);
    const last = after >= reading.length || block(reading[after]!) !== block(token);
    return !first && !last;
  });
}
