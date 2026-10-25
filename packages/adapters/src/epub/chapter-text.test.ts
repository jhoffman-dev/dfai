// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { bookCss } from './book-styles.ts';
import { chapterText } from './chapter-text.ts';
import { offsetAt, positionAt, rangeAt } from './text-positions.ts';

/*
 * A chapter's text as the EPUB reader counts it (#505), and the translation
 * between an offset of it and a place in the chapter's nodes; and a book's
 * stylesheets made to load only from the book.
 */

const chapter = (body: string) =>
  new DOMParser().parseFromString(
    `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>T</title><style>p{}</style></head><body>${body}</body></html>`,
    'application/xhtml+xml',
  );

describe("a chapter's text", () => {
  it('reads the words in order, a line break between blocks, and nothing that is not shown', () => {
    const doc = chapter(
      '<h1>Title</h1><p>One <em>two</em></p><p>three<br/>four</p><script>x()</script>',
    );
    expect(chapterText(doc).text).toBe('Title\nOne two\nthree\nfour\n');
  });

  it('turns an offset into a place in a text node and back, across inline elements', () => {
    const doc = chapter('<p>One <em>two</em> three</p>');
    const text = chapterText(doc);
    const at = text.text.indexOf('two');
    const place = positionAt(text, at + 1);
    expect(place?.node.data).toBe('two');
    expect(place?.offset).toBe(1);
    expect(offsetAt(text, place?.node as Text, 1)).toBe(at + 1);
    expect(rangeAt(text, at, at + 3)?.toString()).toBe('two');
  });

  it('puts an offset on a line break between blocks at the start of the next block', () => {
    const doc = chapter('<p>One</p><p>Two</p>');
    const text = chapterText(doc);
    expect(text.text).toBe('One\nTwo\n');
    expect(positionAt(text, 3)).toMatchObject({ offset: 3 });
    const between = positionAt(text, 4);
    expect(between?.node.data).toBe('Two');
    expect(between?.offset).toBe(0);
    expect(positionAt(text, 99)).toMatchObject({ offset: 3 });
  });

  it('reads a place between nodes as the offset of the first word after it', () => {
    const doc = chapter('<p>One</p><p>Two</p>');
    const text = chapterText(doc);
    const body = doc.getElementsByTagName('body')[0] as Element;
    expect(offsetAt(text, body, 1)).toBe(text.text.indexOf('Two'));
    expect(offsetAt(text, body, 2)).toBe(text.text.length);
    // A place inside a script is no word of the chapter: the next word after it.
    const withScript = chapter('<p>One</p><script>x()</script><p>Two</p>');
    const scripted = chapterText(withScript);
    const script = withScript.getElementsByTagName('script')[0]?.firstChild as Text;
    expect(offsetAt(scripted, script, 1)).toBe(scripted.text.indexOf('Two'));
  });

  it('has no place in a chapter with no words', () => {
    const empty = chapterText(chapter('<p></p>'));
    expect(empty.text).toBe('');
    expect(positionAt(empty, 0)).toBeNull();
    expect(rangeAt(empty, 0, 0)).toBeNull();
  });
});

describe("a book's stylesheet", () => {
  const address = async (path: string) =>
    path.endsWith('missing.png') ? null : `blob:test/${path}`;
  const sheets: Record<string, string> = {
    'OEBPS/base.css': '@import "deeper.css"; body { margin: 0; }',
    'OEBPS/deeper.css': 'h1 { background: url(img/h.png); }',
  };
  const stylesheet = async (path: string) => sheets[path] ?? null;
  const css = (text: string) =>
    bookCss({ css: text, from: 'OEBPS/ch1.xhtml', address, stylesheet });

  // The sheet comes back as the parser writes it out: jsdom's here, WebKit's in the app.
  it("gives the book's own files their addresses, and keeps data and the chapter's own places", async () => {
    expect(await css("p { background: url('img/a.png') }")).toContain(
      'url("blob:test/OEBPS/img/a.png")',
    );
    expect(await css('p { background: url(data:image/png;base64,AAA) }')).toContain(
      'data:image/png;base64,AAA',
    );
    expect(await css('rect { fill: url(#grad) }')).toContain('#grad');
    const missing = await css('p { background: url(img/missing.png); color: red }');
    expect(missing).toContain('color: red');
    expect(missing).not.toContain('missing.png');
  });

  it('drops a declaration naming anything on another site, and keeps the rest of its rule', async () => {
    const made = await css(
      'p { background: url(//example.com/a.png); color: red } h1 { cursor: url("https://beacon.example.com/c.cur"), auto }',
    );
    expect(made).toContain('color: red');
    expect(made).toContain('h1');
    expect(made).not.toContain('example.com');
  });

  it("puts the book's own imports in their place, nested, and drops any other", async () => {
    const text = await css(
      '@import url("base.css");\n@import "https://example.com/x.css" screen;\np {}',
    );
    expect(text).toMatch(/body \{ margin: 0(px)?; \}/);
    expect(text).toContain('url("blob:test/OEBPS/img/h.png")');
    expect(text).not.toContain('@import');
    expect(text).not.toContain('example.com');
  });

  // Each sheet is inlined at most once (PR #536's review): a loop no longer repeats to a depth.
  it('stops following imports that loop', async () => {
    const looping = async () => '@import "loop.css"; p { color: red; }';
    const text = await bookCss({
      css: '@import "loop.css";',
      from: 'OEBPS/ch1.xhtml',
      address,
      stylesheet: looping,
    });
    expect(text.match(/color: red/g)).toHaveLength(1);
  });
});
