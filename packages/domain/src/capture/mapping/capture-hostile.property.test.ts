import { describe, expect, it } from 'vitest';
import { relationsOf } from '../../index/relation-rows.ts';
import { hostileText, seededRandom } from '../../testing/hostile-text.ts';
import {
  SLACK_PERMALINK,
  SLACK_REPLY_TS,
  slackCapture,
  slackSource,
} from '../../testing/slack-capture.ts';
import { linkifyWords } from './capture-linkify.ts';
import { CaptureRefusedError } from './capture-refusal.ts';
import { mapCapture, type CaptureFile } from './capture-to-atlas.ts';
import type { MdRoot } from './capture-tree.ts';

/*
 * A seeded property test (#103): messages, names, titles and channels built
 * from the pieces an attacker would send — frontmatter fences, headings,
 * tags, wiki links, embeds, block ids, HTML, fences, tables, entities,
 * control and direction characters, half surrogates — and the file every one
 * maps to held to the same rules: its frontmatter, its path, and the tree its
 * body is written from. How that tree reads once written, and once edited, is
 * the adapters' round-trip property test's.
 */

function payload(random: () => number) {
  const replies = Math.floor(random() * 4);
  return slackCapture({
    kind: random() < 0.5 ? 'note' : 'task',
    title: random() < 0.3 ? hostileText(random, 8) : null,
    text: hostileText(random, 40),
    source: slackSource({
      channel: { id: 'C0LARK5PUR', name: hostileText(random, 5).slice(0, 70) },
      author: { name: hostileText(random, 6), email: 'mara.quill@example.com' },
      url: SLACK_PERMALINK,
    }),
    thread: Array.from({ length: replies }, (_, at) => ({
      ts: `${SLACK_REPLY_TS.slice(0, -1)}${at}`,
      author: { name: hostileText(random, 6) },
      text: hostileText(random, 40),
    })),
    attachments: [{ name: hostileText(random, 6), url: 'https://files.slack.com/a.pdf' }],
    users: { U0TOBIAS22: hostileText(random, 6) },
  });
}

/**
 * The payload's file, or null when the only reasons it is refused are a name
 * that cleans away to nothing: names are hostile text, not prefixed to be safe.
 */
function mappedUnlessBlank(sent: unknown, trees: MdRoot[]): CaptureFile | null {
  try {
    const writeMarkdown = (root: MdRoot) => {
      trees.push(root);
      return JSON.stringify(root);
    };
    return mapCapture(sent, { timeZone: 'America/Los_Angeles', writeMarkdown });
  } catch (error) {
    if (!(error instanceof CaptureRefusedError)) throw error;
    for (const reason of error.reasons)
      expect(reason).toMatch(/(?:\bname|^users\["U0TOBIAS22"\]): is blank$/);
    return null;
  }
}

/** The frontmatter as YAML reads the mapper's lines: single-quoted, `''` a quote. */
function propertiesOf(frontmatter: string): Record<string, string> {
  return Object.fromEntries(
    frontmatter
      .trim()
      .split('\n')
      .map((line) => {
        const value = line.slice(line.indexOf(': ') + 2);
        const read = value.startsWith("'") ? value.slice(1, -1).replace(/''/g, "'") : value;
        return [line.slice(0, line.indexOf(':')), read];
      }),
  );
}

const FRONTMATTER_LINE = /^[a-z_]+: (?:'(?:[^'\n]|'')*'|[a-z0-9/]+)$/;
// eslint-disable-next-line no-control-regex -- control characters are exactly what must not survive
const UNSAFE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\uFEFF]/u;
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Every node in a tree, depth first; a link's label not, since GFM reads no address inside a link. */
function* nodesOf(node: unknown): Generator<Record<string, unknown>> {
  if (typeof node !== 'object' || node === null) return;
  yield node as Record<string, unknown>;
  if ((node as { type?: string }).type === 'link') return;
  for (const child of (node as { children?: unknown[] }).children ?? []) yield* nodesOf(child);
}

/** What a link's address may hold as written: ASCII, with none of the characters that end or embed one. */
const ENCODED_ADDRESS = /^(?:https?:\/\/|mailto:)[!-~]+$/i;

const SEEDS = Array.from({ length: 400 }, (_, at) => at + 1);

describe('a capture of hostile text, over 400 seeded payloads', () => {
  it.each(SEEDS)(
    'seed %i maps to a file and a tree that say only what the contract writes',
    (seed) => {
      const sent = payload(seededRandom(seed));
      const trees: MdRoot[] = [];
      const file = mappedUnlessBlank(sent, trees);
      if (file === null) return;
      const [, frontmatter = ''] = file.content.split(/^---$/m);
      const replies = (sent.thread as unknown[]).length;

      // The frontmatter is the contract's keys, one line each, every free value quoted.
      const lines = frontmatter.trim().split('\n');
      for (const line of lines) expect(line).toMatch(FRONTMATTER_LINE);
      const keys = lines.map((line) => line.slice(0, line.indexOf(':')));
      const task = sent.kind === 'task' ? ['type', 'status'] : [];
      expect(keys).toEqual([
        ...task,
        'atlas_import',
        'provider',
        'external_id',
        'source',
        'author',
        'author_email',
        'channel',
        'sent_at',
      ]);
      // No value a sender wrote is read as a relation (review of PR #615).
      expect(relationsOf(propertiesOf(frontmatter), () => null)).toEqual([]);

      // Nothing unsafe survives, anywhere in the file or its name.
      expect(file.content).not.toMatch(UNSAFE);
      expect(file.content).not.toMatch(LONE);
      expect(file.path).not.toMatch(UNSAFE);

      // The body is written a block at a time: each message, its thread's heading, its files.
      const blockquotes = trees.filter((tree) => tree.children[0]?.type === 'blockquote');
      expect(blockquotes).toHaveLength(1 + replies);
      expect(file.content.match(/^\^[mr]\d{10}-\d{6}$/gm)).toHaveLength(1 + replies);
      for (const node of trees.flatMap((tree) => [...nodesOf(tree)])) {
        // Words hold no address GFM could read: each is a link of the mapper's.
        if (node['type'] === 'text')
          expect(linkifyWords(String(node['value'])).pieces).toHaveLength(
            String(node['value']) === '' ? 0 : 1,
          );
        if (node['type'] === 'link') expect(String(node['url'])).toMatch(ENCODED_ADDRESS);
        if (node['type'] === 'code') expect(node['lang']).toBeNull();
        expect(['html', 'image', 'table', 'thematicBreak']).not.toContain(node['type']);
      }

      // The same message maps to the same bytes, at a path of the Inbox's.
      expect(mappedUnlessBlank(sent, [])).toEqual(file);
      const name = file.path.slice('Inbox/Captures/'.length);
      expect(file.path.startsWith('Inbox/Captures/')).toBe(true);
      expect(name).not.toMatch(/^\.|^\s|\/|[[\]#^|]/);
      expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(255);
    },
  );
});
