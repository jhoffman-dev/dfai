// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { bookFiles, mediaTypeOf } from './book-files.ts';
import { MOST_IMPORTS, styleBudget } from './book-styles.ts';

/*
 * A book's files as its chapters' frames are given them (#505, ADR-0045):
 * written in as `data:` addresses, never `blob:` ones of the app's origin;
 * each read once per open book, a stylesheet most chapters share made once.
 */

function archive(files: Record<string, string>) {
  const reads: string[] = [];
  return {
    reads,
    loadText: async (name: string) => {
      reads.push(name);
      return files[name] ?? null;
    },
    loadBlob: async (name: string, type?: string) => {
      reads.push(name);
      const text = files[name];
      return text === undefined ? null : new Blob([text], { type: type ?? '' });
    },
  };
}

describe("a book's files, as its frame is given them", () => {
  it('writes a picture in as a data: address of its own type', async () => {
    const files = bookFiles(
      archive({ 'OEBPS/a.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>' }),
    );
    const address = await files.address('OEBPS/a.svg');
    expect(address).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(atob(address?.split(',')[1] ?? '')).toBe('<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(await files.address('OEBPS/missing.png')).toBeNull();
  });

  it('reads each file once, and makes a shared stylesheet once for every chapter', async () => {
    const book = archive({
      'OEBPS/style.css': 'p { color: red; background: url("fonts/a.woff"); }',
      'OEBPS/fonts/a.woff': 'font bytes',
    });
    const files = bookFiles(book);
    const [first, second] = await Promise.all([
      files.stylesheet('OEBPS/style.css'),
      files.stylesheet('OEBPS/style.css'),
    ]);
    expect(await files.stylesheet('OEBPS/style.css')).toBe(first);
    expect(second).toBe(first);
    expect(first).toMatch(/url\("data:font\/woff;base64,[^"]+"\)/);
    expect(first).not.toContain('fonts/a.woff');
    await files.css('b { background: url(fonts/a.woff) }', 'OEBPS/chapter.xhtml');
    expect(book.reads.filter((name) => name === 'OEBPS/style.css')).toHaveLength(1);
    expect(book.reads.filter((name) => name === 'OEBPS/fonts/a.woff')).toHaveLength(1);
  });

  it('reads a file again after a read of it failed', async () => {
    let fails = true;
    const book = {
      loadText: async () => null,
      loadBlob: async () => {
        if (fails) throw new Error('the archive hiccuped');
        return new Blob(['x'], { type: 'image/png' });
      },
    };
    const files = bookFiles(book);
    await expect(files.address('OEBPS/a.png')).rejects.toThrow('hiccuped');
    fails = false;
    expect(await files.address('OEBPS/a.png')).toMatch(/^data:image\/png;base64,/);
  });

  it('names a file by its type only when it knows it', () => {
    expect(mediaTypeOf('OEBPS/A.SVG')).toBe('image/svg+xml');
    expect(mediaTypeOf('OEBPS/x.woff2')).toBe('font/woff2');
    expect(mediaTypeOf('OEBPS/script.js')).toBe('application/octet-stream');
    expect(mediaTypeOf('OEBPS/noext')).toBe('application/octet-stream');
  });
});

// From the third verification of PR #536: a sheet a chapter links and a sheet its `<style>`s
// import are the same file, read once; and one chapter's `<style>`s share one import budget.
describe("a book's stylesheets, linked and imported", () => {
  it('reads a stylesheet once, whether a chapter links it or a <style> imports it', async () => {
    const book = archive({ 'OEBPS/a.css': 'p { color: red; }' });
    const files = bookFiles(book);
    expect(await files.stylesheet('OEBPS/a.css')).toContain('color: red');
    expect(await files.css('@import "a.css";', 'OEBPS/chapter.xhtml')).toContain('color: red');
    expect(book.reads).toEqual(['OEBPS/a.css']);
  });

  it("puts in no more than MOST_IMPORTS sheets across one chapter's <style>s", async () => {
    const sheets: Record<string, string> = {};
    for (let n = 0; n <= MOST_IMPORTS; n += 1) sheets[`OEBPS/s${n}.css`] = `.s${n} { color: red; }`;
    const files = bookFiles(archive(sheets));
    const budget = styleBudget();
    const made: string[] = [];
    for (let n = 0; n <= MOST_IMPORTS; n += 1) {
      made.push(await files.css(`@import "s${n}.css";`, 'OEBPS/chapter.xhtml', budget));
    }
    expect(made.filter((css) => css.includes('color: red'))).toHaveLength(MOST_IMPORTS);
    // Another chapter, or the same one shown again, has a budget of its own.
    expect(await files.css(`@import "s${MOST_IMPORTS}.css";`, 'OEBPS/chapter.xhtml')).toContain(
      'color: red',
    );
  });
});
