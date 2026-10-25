// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { makeChapterSafe } from './chapter-safety.ts';
import { chapterText } from './chapter-text.ts';
import { offsetAt, rangeAt } from './text-positions.ts';

/*
 * Regressions from the attack on PR #536 (#505, ADR-0045): DOM clobbering
 * on the reader's side. A chapter that is not well-formed XHTML is parsed
 * as HTML, and an HTML document's named properties shadow its own members:
 * `<img name="body">` makes `doc.body` that picture. jsdom keeps these named
 * properties as WebKit does, so the shadowing here is the real one.
 */

const htmlChapter = (body: string) =>
  new DOMParser().parseFromString(
    `<!doctype html><html><head><title>T</title></head><body>${body}</body></html>`,
    'text/html',
  );

const SHADOWING =
  '<img name="body" alt=""><img name="createRange" alt=""><img name="getElementsByTagName" alt="">' +
  '<form name="documentElement"><input name="attributes"><input id="localName"></form>' +
  '<p id="title">Slow but steady wins the race.</p><a name="top">Back</a>';

describe("a chapter's names that shadow its document's members", () => {
  it('are read past: the text is the body’s, and its places are found, before the cleaning', () => {
    const doc = htmlChapter(SHADOWING);
    expect(doc.body).toBeInstanceOf(HTMLImageElement);
    const text = chapterText(doc);
    expect(text.text).toContain('Slow but steady wins the race.');
    const at = text.text.indexOf('steady');
    const range = rangeAt(text, at, at + 'steady'.length);
    expect(range?.toString()).toBe('steady');
    expect(offsetAt(text, range?.startContainer as Node, range?.startOffset ?? -1)).toBe(at);
  });

  it('are taken away by the cleaning, so the document’s members are its own again', () => {
    const doc = htmlChapter(SHADOWING);
    makeChapterSafe(doc, 'OEBPS/hare.html');
    expect(doc.body?.localName).toBe('body');
    expect(typeof doc.createRange).toBe('function');
    expect(typeof doc.getElementsByTagName).toBe('function');
    expect(doc.documentElement.localName).toBe('html');
    const names = Array.from(doc.querySelectorAll('img, form, input'), (element) => [
      element.getAttribute('name'),
      element.getAttribute('id'),
    ]);
    expect(names).toEqual([
      [null, null],
      [null, null],
      [null, null],
      [null, null],
      [null, null],
      [null, null],
    ]);
  });

  it('are the only names taken away: a paragraph’s id and a link’s name stay places to lead to', () => {
    const doc = htmlChapter(`${SHADOWING}<img name="hare" id="tortoise" alt="">`);
    makeChapterSafe(doc, 'OEBPS/hare.html');
    expect(doc.getElementById('title')?.textContent).toBe('Slow but steady wins the race.');
    expect(doc.querySelector('a')?.getAttribute('name')).toBe('top');
    const kept = doc.querySelectorAll('img')[3];
    expect([kept?.getAttribute('name'), kept?.id]).toEqual(['hare', 'tortoise']);
  });
});

// From the third verification of PR #536: an SVG presentation attribute is read as CSS.
describe("a chapter's SVG presentation attributes, read as CSS", () => {
  it('keep a place in the chapter, and lose one that names anything else or builds one', () => {
    const doc = new DOMParser().parseFromString(
      `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>T</title></head><body>
<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url( #grad ) red" filter="url(other.svg#f)"
 mask="image-set(var(--m) 1x)" stroke="blue"/></svg></body></html>`,
      'application/xhtml+xml',
    );
    makeChapterSafe(doc, 'OEBPS/chapter.xhtml');
    const rect = doc.getElementsByTagNameNS('http://www.w3.org/2000/svg', 'rect')[0];
    expect(rect?.getAttribute('fill')).toBe('url( #grad ) red');
    expect(rect?.getAttribute('stroke')).toBe('blue');
    expect(rect?.hasAttribute('filter')).toBe(false);
    expect(rect?.hasAttribute('mask')).toBe(false);
  });
});
