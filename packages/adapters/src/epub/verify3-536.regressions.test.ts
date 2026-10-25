// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { bookFiles } from './book-files.ts';
import { makeChapterSafe } from './chapter-safety.ts';

/*
 * From the third verification of PR #536 (#505, ADR-0045). Each test is one
 * invariant the cleaning layer claims and a book can break; the frame's
 * policy still stands behind the address ones in WebKit.
 */

const BEACON = 'beacon.example.com';

describe("a chapter's SVG presentation attributes", () => {
  const chapterWith = (rect: string) =>
    new DOMParser().parseFromString(
      `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>T</title></head><body>
<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60">${rect}</svg></body></html>`,
      'application/xhtml+xml',
    );
  const attributesOf = (doc: Document) =>
    Array.from(doc.getElementsByTagNameNS('http://www.w3.org/2000/svg', 'rect'), (rect) =>
      Array.from(rect.attributes, (a) => a.value).join(' '),
    ).join('\n');

  // WebKit reads a presentation attribute as CSS, and fetches each of these for `mask`.
  it.each([
    ['a url() whose name is a CSS escape', `<rect mask="u\\72l(https://${BEACON}/escaped.png)"/>`],
    ['a url() left open at the end', `<rect mask="url(https://${BEACON}/unclosed.png"/>`],
    ['a bare string in image-set()', `<rect mask='image-set("https://${BEACON}/set.png" 1x)'/>`],
    ['a cursor in image-set()', `<rect cursor='image-set("https://${BEACON}/c.png" 1x), auto'/>`],
  ])('keep no other site named in %s', (_, rect) => {
    const doc = chapterWith(rect);
    makeChapterSafe(doc, 'OEBPS/chapter.xhtml');
    expect(attributesOf(doc)).not.toContain(BEACON);
  });
});

describe("a book's stylesheets, imported", () => {
  it('reads a stylesheet that many <style>s import once per book, as it does one they link', async () => {
    const reads: string[] = [];
    const files = bookFiles({
      loadText: async (name) => {
        reads.push(name);
        return name === 'OEBPS/shared.css' ? 'p { color: red; }' : null;
      },
      loadBlob: async () => null,
    });
    // A chapter of a thousand `<style>`s, each importing the same sheet: each made on its own.
    for (let at = 0; at < 1000; at += 1) {
      await files.css('@import "shared.css";', 'OEBPS/chapter.xhtml');
    }
    expect(reads.filter((name) => name === 'OEBPS/shared.css')).toHaveLength(1);
  });
});
