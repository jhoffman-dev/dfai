// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { bookFiles, type BookFiles } from './book-files.ts';
import { MOST_IMPORTS, STYLE_LIMITS, styleBudget, type StyleLimits } from './book-styles.ts';
import { makeChapterSafe } from './chapter-safety.ts';
import { chapterSource } from './chapter-source.ts';
import { chapterText } from './chapter-text.ts';
import { buildChapter } from './frame-bootstrap.ts';
import { offsetAt } from './text-positions.ts';

/*
 * A safe chapter as its frame is handed it (#505, ADR-0045): nodes as plain
 * data, built again by the frame into the same tree, each text saying
 * where its words begin in the chapter's text.
 */

const NO_FILES: BookFiles = {
  address: async () => null,
  stylesheet: async () => '',
  css: async (css) => css,
  declarations: async (style) => style,
  budget: styleBudget,
};

async function handed(doc: Document, path = 'OEBPS/one.xhtml') {
  makeChapterSafe(doc, path);
  const text = chapterText(doc);
  const source = await chapterSource({ chapter: doc, text, path, files: NO_FILES });
  const frame = document.implementation.createHTMLDocument('');
  const runs = buildChapter(frame, source.nodes, source.length);
  return { text, source, frame, runs };
}

describe('a safe chapter, as its frame is handed it', () => {
  it('is built by the frame into the same words, with each word at the same offset', async () => {
    const doc = new DOMParser().parseFromString(
      '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>T</title></head><body><h1>One</h1><p>Two <em>three</em></p><!-- a note --></body></html>',
      'application/xhtml+xml',
    );
    const { text, frame, runs } = await handed(doc);
    expect(frame.body.textContent).toBe('OneTwo three');
    const em = frame.getElementsByTagName('em')[0]?.firstChild as Text;
    expect(runs === null ? null : offsetAt(runs, em, 2)).toBe(text.text.indexOf('three') + 2);
    expect(runs?.length).toBe(text.length);
  });

  it("names a chapter read as HTML by its elements' own names, not their capitals", async () => {
    const doc = new DOMParser().parseFromString('<p>Not <b>well</b> formed', 'text/html');
    const { source, frame } = await handed(doc);
    expect(source.nodes[0]?.[3]).toBe('html');
    expect(frame.documentElement.localName).toBe('html');
    expect(frame.getElementsByTagName('b')).toHaveLength(1);
  });
});

// From the review of 522b35f4 on PR #536: one chapter's CSS shares one budget, linked or
// imported, and what it keeps does not hang on which file loads first.
describe("a chapter's stylesheets, within one budget", () => {
  /** A seeded generator, so each "shuffle" is the same on every run. */
  const seeded = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  /** A book whose sheets load after a seeded number of turns of the microtask queue. */
  const slowBook = (sheets: Record<string, string>, seed: number, limits?: StyleLimits) => {
    const random = seeded(seed);
    return bookFiles(
      {
        loadText: async (name) => {
          for (let turns = Math.floor(random() * 50); turns > 0; turns -= 1)
            await Promise.resolve();
          return sheets[name] ?? null;
        },
        loadBlob: async () => null,
      },
      limits,
    );
  };

  const stylesOf = async (head: string, files: BookFiles) => {
    const doc = new DOMParser().parseFromString(
      `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>T</title>${head}</head><body><p>One</p></body></html>`,
      'application/xhtml+xml',
    );
    const path = 'OEBPS/one.xhtml';
    makeChapterSafe(doc, path);
    const source = await chapterSource({ chapter: doc, text: chapterText(doc), path, files });
    const frame = document.implementation.createHTMLDocument('');
    buildChapter(frame, source.nodes, source.length);
    return Array.from(frame.getElementsByTagName('style'), (style) => style.textContent ?? '');
  };

  it('puts in no more than MOST_IMPORTS sheets across all its links', async () => {
    const sheets: Record<string, string> = {};
    const links: string[] = [];
    for (let link = 0; link < 3; link += 1) {
      const imports = Array.from({ length: MOST_IMPORTS }, (_, n) => `l${link}-${n}`);
      for (const name of imports) sheets[`OEBPS/${name}.css`] = `.${name} { color: red; }`;
      sheets[`OEBPS/link${link}.css`] = imports.map((name) => `@import "${name}.css";`).join('\n');
      links.push(`<link rel="stylesheet" type="text/css" href="link${link}.css"/>`);
    }
    const styles = await stylesOf(links.join(''), slowBook(sheets, 1));
    expect(styles).toHaveLength(3);
    expect(styles.join('\n').match(/color: red/g)?.length ?? 0).toBeLessThanOrEqual(MOST_IMPORTS);
  });

  it('keeps the same sheets, those first in the chapter, however its files load', async () => {
    // Each sheet a tenth of the most a chapter may take, made small: the first ten fit, and no more.
    const limits = { ...STYLE_LIMITS, importedLength: 1_000 };
    const size = Math.floor(limits.importedLength / 10);
    const sheets: Record<string, string> = {};
    const head: string[] = [];
    for (let n = 0; n < 15; n += 1) {
      sheets[`OEBPS/s${n}.css`] = `.s${n} { color: red; }`.padEnd(size, ' ');
      head.push(`<style>@import "s${n}.css";</style>`);
    }
    const kept = async (seed: number) =>
      (await stylesOf(head.join(''), slowBook(sheets, seed, limits))).map((css) =>
        css.includes('color'),
      );
    const first = await kept(1);
    expect(first).toEqual(Array.from({ length: 15 }, (_, n) => n < 10));
    for (const seed of [2, 3, 4, 5]) expect(await kept(seed)).toEqual(first);
  });
});
