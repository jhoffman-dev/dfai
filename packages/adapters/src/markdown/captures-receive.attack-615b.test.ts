import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import type { Nodes, Root } from 'mdast';
import { describe, expect, it } from 'vitest';
import {
  mapCapture as mapDomainCapture,
  noteTags,
  splitFrontmatter,
  splitWikiLinksAndEmbeds,
} from '@dfai/domain';
import { slackCapture, SLACK_REPLY_TS } from '@dfai/domain/testing';
import { parseMarkdownBody, renderBlock } from './markdown-blocks.ts';
import { remarkMarkdown } from './markdown-port.ts';
import { writeCaptureMarkdown } from './capture-markdown.ts';
import type { CaptureOptions } from '@dfai/domain';
/** The domain's mapper with the editor's serializer, as the app maps a capture (ADR-0049). */
const mapCapture = (payload: unknown, options: Partial<CaptureOptions> = {}) =>
  mapDomainCapture(payload, { writeMarkdown: writeCaptureMarkdown, ...options });

/*
 * Second attack on PR #615 (#103), on its one writer of a sender's words.
 * GFM reads `www.` as an address however it is escaped — it finds addresses
 * in a text node's words once escapes are read — and runs it on over `[`,
 * `]`, a held part (a mention, a code span) and a space beyond ASCII, where
 * the writer's own address pattern stops. And a mail address is read across
 * a mention's edge, which the writer never sees whole. All names are made up.
 */

const editedBack = (body: string) =>
  parseMarkdownBody(body)
    .doc.content.map((node) => renderBlock(node))
    .join('\n\n');

const bodyOfFile = (payload: Record<string, unknown>) =>
  splitFrontmatter(mapCapture(payload, { timeZone: 'UTC' }).content).body;

const parse = (body: string) => unified().use(remarkParse).use(remarkGfm).parse(body) as Root;

function* nodesOf(node: Nodes): Generator<Nodes> {
  yield node;
  if ('children' in node) for (const child of node.children) yield* nodesOf(child as Nodes);
}

/** The links GFM reads from words: those whose source does not open with `[`. */
const bareLinks = (markdown: string) =>
  [...nodesOf(parse(markdown))].flatMap((node) =>
    node.type === 'link' && markdown[node.position?.start.offset ?? 0] !== '[' ? [node.url] : [],
  );

const linksIn = (markdown: string) =>
  splitWikiLinksAndEmbeds(markdown).filter((piece) => piece.kind !== 'text');

const tagsIn = (markdown: string) =>
  noteTags({
    tagsProperty: undefined,
    body: markdown,
    ranges: remarkMarkdown.textRanges(markdown),
  });

const quiet = { thread: [], attachments: [] };

describe('a `www.` the writer leaves as words never runs on into structure once edited', () => {
  it.each([
    ['`]` after it, in the message', { text: 'see www.]x/[[Payroll secrets]] now' }],
    ['`[` after it, in the message', { text: 'see www.[x/![[Payroll secrets]] now' }],
    [
      'a mention after it',
      { text: 'www.<@U0TOBIAS22> now', users: { U0TOBIAS22: 'x/[[Payroll secrets]]' } },
    ],
    [
      '`]` after it, in a reply',
      {
        thread: [
          {
            ts: SLACK_REPLY_TS,
            author: { name: 'Tobias Fenn' },
            text: 'www.]x/[[Payroll secrets]] now',
          },
        ],
      },
    ],
  ])('no wiki link or embed: %s', (_, fields) => {
    const body = bodyOfFile(slackCapture({ ...quiet, ...fields }));
    expect(linksIn(editedBack(body))).toEqual([]);
  });

  it('no tag: `www.]x #ops` edited', () => {
    const body = bodyOfFile(slackCapture({ ...quiet, text: 'see www.]x #ops now' }));
    expect(tagsIn(editedBack(body))).toEqual([]);
  });
});

describe('the note as written holds no link read from words', () => {
  it.each([
    ['`www.]` in the message', { text: 'see www.]x now' }],
    ['`www.` before a code span', { text: 'see www.`x` now' }],
    ['`www.` before a no-break space', { text: 'see www. x now' }],
    ['`www.` before a mention', { text: 'see www.<@U0TOBIAS22> now' }],
    ['`www.` in an author name', { source: { ...sourceOf(), author: { name: 'www.]x' } } }],
    ['a mention before `@` and a domain', { text: 'mail <@U0TOBIAS22>@example.com' }],
    ['a channel inside a mail address', { text: 'mail mara<#C0LARK5PUR|ops>@example.com' }],
  ])('%s', (_, fields) => {
    const body = bodyOfFile(slackCapture({ ...quiet, ...fields }));
    expect(bareLinks(body)).toEqual([]);
  });
});

describe('every link the writer makes of a bare address opens an address', () => {
  // trimAddress cuts trailing `.` and `_` off `www._` into its own `www.`, leaving `www`,
  // which linkBareWeb writes as `[www](www "www")`: a relative link a sender made.
  it.each([['www._'], ['www.)'], ['www.?']])('%s is no relative link', (text) => {
    const body = bodyOfFile(slackCapture({ ...quiet, text: `see ${text} now` }));
    const urls = [...nodesOf(parse(body))].flatMap((node) =>
      node.type === 'link' ? [node.url] : [],
    );
    for (const url of urls) expect(url).toMatch(/^(?:https?:\/\/|mailto:|xmpp:)/i);
  });
});

describe('the writer is linear in the words', () => {
  // BARE_MAIL (capture-mrkdwn.ts:259) tries a local part from every letter of a run with no
  // `@` and scans the run each time: quadratic, about 2.7 s for one 40 000-letter message
  // here and run on the app's only JS thread. A capture holds 1 000 000 characters, so 24
  // replies like it block the app for over a minute; linear mapping takes milliseconds.
  // Timed coarsely, as meetings-receive.attack.test.ts is: the work is inside one regex.
  it('maps 25 messages of 40 000 letters each in time far from quadratic', () => {
    const letters = 'a'.repeat(40_000);
    const thread = Array.from({ length: 24 }, (_, at) => ({
      ts: `17931363${String(at).padStart(2, '0')}.000200`,
      author: { name: 'Tobias Fenn' },
      text: letters,
    }));
    const started = performance.now();
    mapCapture(slackCapture({ text: letters, thread, attachments: [] }), { timeZone: 'UTC' });
    expect(performance.now() - started).toBeLessThan(10_000);
  }, 300_000);
});

function sourceOf() {
  return slackCapture().source as Record<string, unknown>;
}
