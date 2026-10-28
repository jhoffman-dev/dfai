/**
 * Every capture survives an edit (#103, attack on PR #615): hostile payloads
 * mapped, each block of the body parsed the way the editor holds it and
 * written back as an edit writes it, then read again. Whatever the sender
 * wrote and wherever — text, thread, names, channel, mention names, token
 * labels, titles, attachment names — the note holds no link the mapper did
 * not write, and no wiki link, embed, tag, rule, table, HTML or image, before
 * the edit or after. A bare address in a new context fails here by property,
 * not by luck. Seeded; all names are made up.
 */
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import type { Nodes, Root } from 'mdast';
import { describe, expect, it } from 'vitest';
import {
  CaptureRefusedError,
  mapCapture,
  noteTags,
  splitFrontmatter,
  splitWikiLinksAndEmbeds,
} from '@dfai/domain';
import {
  HOSTILE_PIECES,
  SLACK_PERMALINK,
  SLACK_REPLY_TS,
  seededRandom,
  slackCapture,
  slackSource,
} from '@dfai/domain/testing';
import { parseMarkdownBody, renderBlock } from './markdown-blocks.ts';
import { remarkMarkdown } from './markdown-port.ts';

const editedBack = (body: string) =>
  parseMarkdownBody(body)
    .doc.content.map((node) => renderBlock(node))
    .join('\n\n');

const parse = (body: string) => unified().use(remarkParse).use(remarkGfm).parse(body) as Root;

function* nodesOf(node: Nodes): Generator<Nodes> {
  yield node;
  if ('children' in node) for (const child of node.children) yield* nodesOf(child as Nodes);
}

/** Markup no sender may make: none of it is ever the mapper's either. */
const FORBIDDEN = new Set([
  'html',
  'image',
  'imageReference',
  'table',
  'thematicBreak',
  'definition',
  'footnoteDefinition',
  'footnoteReference',
  'linkReference',
]);

/**
 * The edges of an address the writer's own patterns may not see as GFM does
 * (second attack on PR #615): a bare `www.` or scheme with what GFM runs an
 * address on over (`[`, `]`, a space beyond ASCII), an address's start in
 * any case, a mail address's parts on either side of a mention, angle and
 * other-scheme forms, and entities for the characters markup is made of.
 */
const ADDRESS_EDGES: readonly string[] = [
  'www.',
  'WWW.',
  'https://',
  'HTTP://',
  'ftp://',
  'xmpp:',
  'mailto:',
  '@example.com',
  'mara',
  '<https://example.com/a>',
  '[',
  ']',
  '(',
  ')',
  '.',
  '\u00a0',
  '\u2003',
  'exämple.рф',
  '&#x5b;&#x5b;',
  '&lsqb;',
  '&#35;',
  '&#33;',
  '&#124;',
];

/** As `hostileText` from the domain's testing kit, with the address edges among the pieces. */
function edgyText(random: () => number, most: number): string {
  const pieces = [...HOSTILE_PIECES, ...ADDRESS_EDGES, ...ADDRESS_EDGES];
  const count = 1 + Math.floor(random() * most);
  return Array.from({ length: count }, () => pieces[Math.floor(random() * pieces.length)]).join('');
}

/** A payload with hostile text in every field a sender writes. */
function hostilePayload(random: () => number) {
  const tokenLabel = () => edgyText(random, 4).replace(/[<>|\n]/g, ' ');
  const text = [
    edgyText(random, 25),
    `<@U0NOBODY99|${tokenLabel()}>`,
    `<#C0LARK5PUR|${tokenLabel()}>`,
    `<!subteam^S0LARKPAY|${tokenLabel()}>`,
    `<!date^1793136000^{date}|${tokenLabel()}>`,
    `<javascript:alert(1)|${tokenLabel()}>`,
    `<https://example.com/a|${tokenLabel()}>`,
    '<@U0TOBIAS22>',
    edgyText(random, 10),
  ].join(random() < 0.5 ? ' ' : '');
  return slackCapture({
    kind: random() < 0.5 ? 'note' : 'task',
    title: random() < 0.5 ? edgyText(random, 6) : null,
    text,
    source: slackSource({
      channel: { id: 'C0LARK5PUR', name: edgyText(random, 4).slice(0, 70) },
      author: { name: edgyText(random, 5) },
      url: SLACK_PERMALINK,
    }),
    thread: [
      {
        ts: SLACK_REPLY_TS,
        author: { name: edgyText(random, 5) },
        text: edgyText(random, 20),
      },
    ],
    attachments: [{ name: edgyText(random, 4), url: 'https://files.slack.com/a.pdf' }],
    users: { U0TOBIAS22: edgyText(random, 5) },
  });
}

/** The mapped body, or null when the payload is refused only for a name that cleans away to nothing. */
function mappedBody(payload: unknown): string | null {
  try {
    return splitFrontmatter(mapCapture(payload, { timeZone: 'UTC' }).content).body;
  } catch (error) {
    if (!(error instanceof CaptureRefusedError)) throw error;
    for (const reason of error.reasons)
      expect(reason).toMatch(/(?:\bname|^users\[[^\]]+\]): is blank$/);
    return null;
  }
}

/** The links a tree holds, each with whether its source opens with `[`, as the mapper writes every link. */
const linksOf = (tree: Root, source: string) =>
  [...nodesOf(tree)].flatMap((node) =>
    node.type === 'link'
      ? [{ url: node.url, explicit: source[node.position?.start.offset ?? 0] === '[' }]
      : [],
  );

/** What every link the mapper writes opens: an address, never a path in the vault. */
const ADDRESS = /^(?:https?:\/\/|mailto:|xmpp:)/i;

function expectOnlyWords(markdown: string, written: ReadonlySet<string>): void {
  const tree = parse(markdown);
  for (const url of written) expect(url, `a link to no address: ${url}`).toMatch(ADDRESS);
  for (const node of nodesOf(tree)) expect(FORBIDDEN.has(node.type), node.type).toBe(false);
  for (const link of linksOf(tree, markdown)) {
    expect(link.explicit, `a link read from words: ${link.url}`).toBe(true);
    expect(written.has(link.url), `a link the mapper did not write: ${link.url}`).toBe(true);
  }
  expect(splitWikiLinksAndEmbeds(markdown).filter((piece) => piece.kind !== 'text')).toEqual([]);
  const ranges = remarkMarkdown.textRanges(markdown);
  expect(noteTags({ tagsProperty: undefined, body: markdown, ranges })).toEqual([]);
}

describe('a hostile capture, edited and written back, over 300 seeded payloads', () => {
  it.each(Array.from({ length: 300 }, (_, at) => at + 1))(
    'seed %i holds only words and its own links',
    (seed) => {
      const body = mappedBody(hostilePayload(seededRandom(seed)));
      if (body === null) return;
      const written = new Set(linksOf(parse(body), body).map((link) => link.url));
      expectOnlyWords(body, written);
      const edited = editedBack(body);
      expectOnlyWords(edited, written);
      // Read and written once more, it is what it was: an edit has nothing left to undo.
      const again = editedBack(edited);
      expectOnlyWords(again, written);
      // However many times more, nothing changes.
      expect(editedBack(again)).toBe(again);
    },
  );
});
