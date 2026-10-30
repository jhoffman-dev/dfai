import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MdBlock, MdPhrasing, MdRoot } from '@dfai/domain';
import { writeCaptureMarkdown } from '../../packages/adapters/src/markdown/capture-markdown.ts';
import { HOSTILE_PIECES, seededRandom } from '../../packages/domain/src/testing/index.ts';
import { bundleCaptureMarkdown, CAPTURE_MARKDOWN_BUNDLE } from './capture-bundle.ts';

/*
 * Third attack on PR #615 (#103): n8n's bundled writer against the app's,
 * on trees the mapper does not limit itself to — every node type a capture
 * tree may hold, nested to depth, lists holding quotes and code, links with
 * any address and title, hostile words in every value. The same bytes in
 * Node from the app's module, in Node from the bundle, and in JavaScriptCore
 * from the bundle; and the bundle built twice is one file. Seeded.
 */

const JSC = '/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc';

const EXTRA = [
  '"',
  ')',
  '(',
  '\\"',
  '`'.repeat(4),
  '😀',
  '\uD83D',
  'http://[::1]:8080/',
  'a@b.co',
  '#ops',
  '  ',
  '\t',
];

function words(random: () => number, most: number): string {
  const pieces = [...HOSTILE_PIECES, ...EXTRA];
  const count = Math.floor(random() * most);
  return Array.from({ length: count }, () => pieces[Math.floor(random() * pieces.length)]).join('');
}

function phrasing(random: () => number, depth: number): MdPhrasing[] {
  return Array.from({ length: 1 + Math.floor(random() * 4) }, (): MdPhrasing => {
    const roll = random();
    if (depth > 0 && roll < 0.25) {
      const type = (['strong', 'emphasis', 'delete'] as const)[Math.floor(random() * 3)]!;
      return { type, children: phrasing(random, depth - 1) };
    }
    if (depth > 0 && roll < 0.4) {
      const url = `https://example.com/${words(random, 3)}`;
      const title = random() < 0.5 ? null : words(random, 4);
      return { type: 'link', url, title, children: phrasing(random, depth - 1) };
    }
    if (roll < 0.5) return { type: 'inlineCode', value: words(random, 3) };
    if (roll < 0.55) return { type: 'wikiLink', value: '[[Mara Quill]]' };
    return { type: 'text', value: words(random, 5) };
  });
}

function blocks(random: () => number, depth: number): MdBlock[] {
  return Array.from({ length: 1 + Math.floor(random() * 3) }, (): MdBlock => {
    const roll = random();
    if (depth > 0 && roll < 0.2) return { type: 'blockquote', children: blocks(random, depth - 1) };
    if (depth > 0 && roll < 0.35)
      return {
        type: 'list',
        ordered: false,
        start: null,
        spread: false,
        children: Array.from({ length: 1 + Math.floor(random() * 3) }, () => ({
          type: 'listItem' as const,
          spread: false as const,
          checked: null,
          children: blocks(random, depth - 1),
        })),
      };
    if (roll < 0.45) return { type: 'code', lang: null, meta: null, value: words(random, 6) };
    if (roll < 0.5) return { type: 'heading', depth: 2, children: phrasing(random, 2) };
    return { type: 'paragraph', children: phrasing(random, 3) };
  });
}

const trees: MdRoot[] = Array.from({ length: 500 }, (_, at) => ({
  type: 'root',
  children: blocks(seededRandom(at + 615), 3),
}));

const WRITE = (bundle: string) =>
  `${bundle}\nvar written = trees.map(function (tree) { try { return dfaiCaptureMarkdown.writeCaptureMarkdown(tree); } catch (error) { return 'threw: ' + error.message; } });`;

const inApp = (tree: MdRoot) => {
  try {
    return writeCaptureMarkdown(tree);
  } catch (error) {
    return `threw: ${(error as Error).message}`;
  }
};

describe('the bundled capture writer, against the app’s (third attack on PR #615)', () => {
  it('builds the same bundle twice, and it is the one kept', async () => {
    const first = await bundleCaptureMarkdown();
    expect(await bundleCaptureMarkdown()).toBe(first);
    expect(readFileSync(CAPTURE_MARKDOWN_BUNDLE, 'utf8')).toBe(first);
  });

  it('writes every one of the 500 trees, none refused, so the comparison is of bytes', () => {
    expect(trees.map(inApp).filter((written) => written.startsWith('threw: '))).toEqual([]);
  });

  it('writes 500 seeded trees in Node byte for byte as the app does', () => {
    const run = new Function(
      'trees',
      `${WRITE(readFileSync(CAPTURE_MARKDOWN_BUNDLE, 'utf8'))}\nreturn written;`,
    );
    expect(run(trees)).toEqual(trees.map(inApp));
  });

  it.skipIf(!existsSync(JSC))(
    'writes 500 seeded trees in JavaScriptCore byte for byte as the app does',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'dfai-capture-jsc-'));
      try {
        const file = join(dir, 'driver.js');
        writeFileSync(
          file,
          `var trees = ${JSON.stringify(trees)};\n${WRITE(readFileSync(CAPTURE_MARKDOWN_BUNDLE, 'utf8'))}\nprint(JSON.stringify(written));`,
        );
        const written = JSON.parse(
          execFileSync(JSC, [file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
        ) as string[];
        expect(written).toEqual(trees.map(inApp));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
