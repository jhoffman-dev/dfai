// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  fablesFixtureEpub,
  hostileFixtureEpub,
  HOSTILE_ORIGIN,
} from '../../../../tools/epub/fixture-epub.ts';
import { bookFiles } from './book-files.ts';
import { makeChapterSafe } from './chapter-safety.ts';
import { chapterSource } from './chapter-source.ts';
import { chapterText } from './chapter-text.ts';
import { buildChapter } from './frame-bootstrap.ts';
import { foliateEpubReader } from './foliate-reader.ts';
import { openArchive } from './zip-loader.ts';

/*
 * A hostile book made safe to show (#505, ADR-0045): the chapter of
 * tools/epub/fixture-epub.ts that tries scripts in every form, files on
 * another site, frames, a refresh, a form, links out and links hidden in
 * MathML and SVG keeps none of them, keeps its one link inside the book, and
 * keeps every node where it was, so its text and its CFIs are the book's.
 * `shown` is the chapter as its frame builds it: made safe, handed over as
 * nodes (`chapterSource`), and built by the frame's own script.
 */

const PATH = 'OEBPS/hostile.xhtml';

async function hostileChapter() {
  const archive = await openArchive(new Uint8Array(hostileFixtureEpub()));
  const source = (await archive.loadText(PATH)) ?? '';
  const parse = () => new DOMParser().parseFromString(source, 'application/xhtml+xml');
  const safe = parse();
  makeChapterSafe(safe, PATH);
  const handed = await chapterSource({
    chapter: safe,
    text: chapterText(safe),
    path: PATH,
    files: bookFiles(archive),
  });
  const shown = document.implementation.createHTMLDocument('');
  expect(buildChapter(shown, handed.nodes, handed.length)).not.toBeNull();
  return { original: parse(), safe, shown, handed };
}

const everyElement = (doc: Document) => Array.from(doc.getElementsByTagName('*'));
/** How many elements each element holds, in document order: what a CFI's even steps count. */
const shapeOf = (doc: Document) => everyElement(doc).map((element) => element.children.length);

describe('a hostile chapter made safe', () => {
  it('keeps no script, frame, plug-in, refresh or base', async () => {
    const { shown } = await hostileChapter();
    const names = new Set(everyElement(shown).map((element) => element.localName.toLowerCase()));
    for (const banned of ['script', 'iframe', 'object', 'embed', 'meta', 'base', 'link']) {
      expect(names.has(banned), banned).toBe(false);
    }
  });

  it('keeps no handler, and nothing anywhere that names the other site or runs a script', async () => {
    const { shown } = await hostileChapter();
    const attributes = everyElement(shown).flatMap((element) => Array.from(element.attributes));
    expect(attributes.length).toBeGreaterThan(10);
    expect(attributes.filter((attribute) => attribute.localName.startsWith('on'))).toEqual([]);
    const markup = new XMLSerializer().serializeToString(shown);
    expect(markup).not.toContain(HOSTILE_ORIGIN);
    expect(markup).not.toContain('beacon.example.com');
    expect(markup.toLowerCase()).not.toContain('javascript:');
    expect(markup).not.toContain('action=');
  });

  it('keeps its link inside the book as where it leads, and a link out as going nowhere', async () => {
    const { shown } = await hostileChapter();
    const inside = shown.getElementById('inside');
    expect(inside?.getAttribute('data-dfai-path')).toBe('OEBPS/calm.xhtml');
    expect(inside?.getAttribute('data-dfai-fragment')).toBe('calm');
    expect(inside?.getAttribute('href')).toBe('#');
    const out = shown.getElementById('out');
    expect(out?.getAttribute('href')).toBe('#');
    expect(out?.hasAttribute('data-dfai-path')).toBe(false);
    expect(shown.getElementById('js')?.hasAttribute('data-dfai-path')).toBe(false);
  });

  it("puts the book's own stylesheet in as a style, its other site's import and pictures as nothing", async () => {
    const { shown } = await hostileChapter();
    const styles = Array.from(
      shown.getElementsByTagName('style'),
      (style) => style.textContent ?? '',
    );
    expect(styles.some((css) => css.includes('text-indent: 1em'))).toBe(true);
    const own = styles.join('\n');
    expect(own).not.toContain('@import');
    expect(own).not.toContain('beacon.example.com');
  });

  it("writes a picture of the book's own in as data, and drops one on another site or not in the book", async () => {
    const { shown } = await hostileChapter();
    const images = Array.from(shown.getElementsByTagName('img'));
    expect(images.map((image) => image.getAttribute('src')?.slice(0, 26) ?? null)).toEqual([
      null,
      null,
      'data:image/svg+xml;base64,',
    ]);
  });

  it('keeps no address of the app’s origin anywhere: every file of the book is written in', async () => {
    const { shown, handed } = await hostileChapter();
    const values = everyElement(shown).flatMap((element) =>
      Array.from(element.attributes, (attribute) => attribute.value),
    );
    expect(values.some((value) => value.startsWith('data:'))).toBe(true);
    expect(
      values.filter((value) => /^(blob|https?|file|tauri|javascript):/i.test(value.trim())),
    ).toEqual([]);
    expect(JSON.stringify(handed.nodes)).not.toMatch(/blob:|javascript:/i);
  });

  it('gives no href to anything but a link and an SVG loader: a MathML link leads nowhere', async () => {
    const { shown } = await hostileChapter();
    const math = shown.getElementById('mathlink');
    expect(math?.localName).toBe('mtext');
    expect(math?.hasAttribute('href')).toBe(false);
    const withHref = everyElement(shown)
      .filter((element) => element.hasAttribute('href'))
      .map((element) => element.localName);
    expect(new Set(withHref)).toEqual(new Set(['a', 'use']));
    const use = shown.getElementsByTagNameNS('http://www.w3.org/2000/svg', 'use')[0];
    expect(use?.getAttribute('href')).toMatch(/^data:image\/svg\+xml;base64,/);
    const svgLink = shown.getElementById('svglink')?.parentElement;
    expect(svgLink?.getAttribute('href')).toBe('#');
    expect(svgLink?.getAttribute('data-dfai-path')).toBe('OEBPS/evil.svg');
  });

  it('drops a path a book writes as if DFAI had, so it cannot give an element a file to load', async () => {
    const { safe, shown } = await hostileChapter();
    expect(safe.getElementById('forged')?.hasAttribute('data-dfai-href')).toBe(false);
    const forged = shown.getElementById('forged');
    expect(forged?.textContent).toBe('Follow the forged path');
    expect(Array.from(forged?.attributes ?? [], (attribute) => attribute.name)).toEqual(['id']);
  });

  it('keeps every node where it was, so its text is the same and its CFIs name the same places', async () => {
    const { original, safe, shown } = await hostileChapter();
    expect(shapeOf(safe)).toEqual(shapeOf(original));
    expect(shapeOf(shown)).toEqual(shapeOf(original));
    expect(chapterText(shown).text).toBe(chapterText(original).text);
    expect(chapterText(shown).text).not.toContain('__hostileRan');
  });

  it('gives the reader none of the scripts as words', async () => {
    const book = await foliateEpubReader().open(new Uint8Array(hostileFixtureEpub()));
    const text = await book.sectionText(0);
    expect(text).toContain('A Hare one day ridiculed');
    expect(text).not.toContain('__hostileRan');
    expect(text).not.toContain('fetch(');
    book.close();
  });
});

describe('a calm chapter made safe', () => {
  it('changes nothing a reader sees', async () => {
    const archive = await openArchive(new Uint8Array(fablesFixtureEpub()));
    const source = (await archive.loadText('OEBPS/hare.xhtml')) ?? '';
    const original = new DOMParser().parseFromString(source, 'application/xhtml+xml');
    const safe = new DOMParser().parseFromString(source, 'application/xhtml+xml');
    makeChapterSafe(safe, 'OEBPS/hare.xhtml');
    expect(safe.body?.innerHTML ?? safe.documentElement.textContent).toBe(
      original.body?.innerHTML ?? original.documentElement.textContent,
    );
  });
});
