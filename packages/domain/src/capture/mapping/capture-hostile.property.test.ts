import { describe, expect, it } from 'vitest';
import { relationsOf } from '../../index/relation-rows.ts';
import { splitWikiLinks } from '../../markdown/wikilink.ts';
import { hostileText, seededRandom } from '../../testing/hostile-text.ts';
import {
  SLACK_PERMALINK,
  SLACK_REPLY_TS,
  slackCapture,
  slackSource,
} from '../../testing/slack-capture.ts';
import { CaptureRefusedError } from './capture-refusal.ts';
import { mapCapture, type CaptureFile } from './capture-to-atlas.ts';

/*
 * A seeded property test (#103): messages, names, titles and channels built
 * from the pieces an attacker would send — frontmatter fences, headings,
 * tags, wiki links, embeds, block ids, HTML, fences, tables, entities,
 * control and direction characters, half surrogates — and the file every one
 * maps to held to the same rules. The real markdown parser's reading of these
 * files is checked in the adapters' integration test.
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
function mappedUnlessBlank(sent: unknown): CaptureFile | null {
  try {
    return mapCapture(sent, { timeZone: 'America/Los_Angeles' });
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
const OUR_ID = /^\^[mr]\d{10}-\d{6}$/;
// eslint-disable-next-line no-control-regex -- control characters are exactly what must not survive
const UNSAFE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\uFEFF]/u;
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** The body's lines outside fenced code, each with the quote marks before it taken off. */
function proseLines(body: string): string[] {
  let fence: string | null = null;
  const prose: string[] = [];
  for (const line of body.split('\n')) {
    const unquoted = line.replace(/^(?:> ?)+/, '');
    const run = /^(`{3,})\s*$/.exec(unquoted)?.[1];
    if (fence === null && run !== undefined) fence = run;
    else if (fence !== null && run !== undefined && run.length >= fence.length) fence = null;
    else if (fence === null) prose.push(line);
  }
  return prose;
}

/**
 * A line with its escaped characters, its code spans and its links' destinations
 * taken out, read left to right as CommonMark reads them: what markdown reads as markup.
 */
function markupOf(written: string): string {
  // A link's destination is an address, percent-encoded where it must be, not markup.
  const line = written.replace(/\]\([^()\s]*\)/g, ']');
  let kept = '';
  for (let at = 0; at < line.length;) {
    const run = /^`+/.exec(line.slice(at))?.[0];
    if (line[at] === '\\') at += 2;
    else if (run === undefined) kept += line[at++];
    else {
      const close = line.slice(at + run.length).search(new RegExp(`(?<!\`)${run}(?!\`)`));
      if (close === -1) kept += run;
      at += close === -1 ? run.length : run.length * 2 + close;
    }
  }
  return kept;
}

const SEEDS = Array.from({ length: 400 }, (_, at) => at + 1);

describe('a capture of hostile text, over 400 seeded payloads', () => {
  it.each(SEEDS)('seed %i maps to a file that says only what the contract writes', (seed) => {
    const random = seededRandom(seed);
    const sent = payload(random);
    const file = mappedUnlessBlank(sent);
    if (file === null) return;
    const [, frontmatter = '', ...rest] = file.content.split(/^---$/m);
    const body = rest.join('---');
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
    expect(file.content.split(/^---$/m).length).toBe(3 + (body.match(/^---$/gm)?.length ?? 0));
    expect(body).not.toMatch(/^---$/m);

    // No value a sender wrote is read as a relation (review of PR #615).
    expect(relationsOf(propertiesOf(frontmatter), () => null)).toEqual([]);

    // Nothing unsafe survives, anywhere in the file or its name.
    expect(file.content).not.toMatch(UNSAFE);
    expect(file.content).not.toMatch(LONE);
    expect(file.path).not.toMatch(UNSAFE);

    // Every prose line is one the mapper writes: a quote, an id, a heading of its own, a file.
    for (const line of proseLines(body)) {
      expect(
        line === '' ||
          line.startsWith('>') ||
          OUR_ID.test(line) ||
          /^## (?:Thread|Attachments)$/.test(line) ||
          line.startsWith('- ['),
      ).toBe(true);
      const bare = markupOf(line);
      if (!OUR_ID.test(line)) expect(bare).not.toMatch(/\^[A-Za-z0-9-]+\s*$/);
      expect(bare).not.toMatch(/#[\p{L}\p{N}]|<|\[\[/u);
    }
    expect(body.split('\n').filter((line) => OUR_ID.test(line))).toHaveLength(1 + replies);
    expect(splitWikiLinks(body).filter((piece) => piece.kind === 'wikiLink')).toEqual([]);

    // The same message maps to the same bytes, at a path of the Inbox's.
    expect(mapCapture(sent, { timeZone: 'America/Los_Angeles' })).toEqual(file);
    const name = file.path.slice('Inbox/Captures/'.length);
    expect(file.path.startsWith('Inbox/Captures/')).toBe(true);
    expect(name).not.toMatch(/^\.|\/|[[\]#^|]/);
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(255);
  });
});
