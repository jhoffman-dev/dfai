// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { bookCss, MOST_IMPORTED_LENGTH, MOST_IMPORTS, STYLE_LIMITS } from './book-styles.ts';
import {
  bookDeclarations,
  MOST_NESTING,
  MOST_RULE_LENGTH,
  MOST_SHEET_LENGTH,
  sheetMade,
} from './chapter-styles.ts';

/*
 * Regressions from the attack on and verification of PR #536 (#505, ADR-0045 §5): the reader's cleaning of a book's CSS
 * is meant to stand alone — "each layer assumes the others failed" — so no
 * reference to another site may survive it, whatever spelling CSS allows. The
 * frame's policy still refuses these loads in WebKit; these are gaps in the
 * cleaning layer only.
 */

const BEACON = 'beacon.example.com';

const made = (css: string) =>
  bookCss({
    css,
    from: 'OEBPS/chapter.xhtml',
    address: async () => null,
    stylesheet: async () => null,
  });

describe("a book's CSS made the book's own", () => {
  it('keeps no other site named in a url() whose name is written with a CSS escape', async () => {
    // `u\72l(` is the url token to a CSS parser: `\72` is "r".
    const css = `p { background: u\\72l(https://${BEACON}/escaped.png); }`;
    expect(await made(css)).not.toContain(BEACON);
  });

  it('keeps no other site named as a plain string in image-set()', async () => {
    // image-set() takes a string as a URL, with no url() around it.
    const css = `p { background-image: image-set("https://${BEACON}/set.png" 1x); }`;
    expect(await made(css)).not.toContain(BEACON);
  });

  it('keeps no other site named by an @import whose name is written with a CSS escape', async () => {
    const css = `@\\69mport "https://${BEACON}/escaped.css";\np { color: red; }`;
    expect(await made(css)).not.toContain(BEACON);
  });

  it('keeps no other site named in a -webkit-image-set(), by an @import in capitals, or one with a comment for its space', async () => {
    const css = [
      `p { background-image: -webkit-image-set('https://${BEACON}/webkit.png' 1x); }`,
      `@IMPORT "https://${BEACON}/capitals.css";`,
      `@import/**/"https://${BEACON}/comment.css";`,
      `@import url(https://${BEACON}/bare.css) screen;`,
      `h1 { background: image-set(u\\rl("https://${BEACON}/nested.png") 1x); }`,
    ].join('\n');
    expect(await made(css)).not.toContain(BEACON);
  });

  // jsdom's parser drops image-set() and a font's src, so the book's own picture in one is
  // made in css-references.test.ts, and shown in WebKit by e2e/epub-reader.spec.ts.
  it("keeps a book's own picture at its address, and a declaration beside one it drops", async () => {
    const kept = await bookCss({
      css: `p { background-image: url("pics/hare.png"); } q { color: red; background: url(https://${BEACON}/q.png); }`,
      from: 'OEBPS/chapter.xhtml',
      address: async (path) =>
        path === 'OEBPS/pics/hare.png' ? 'data:image/png;base64,HARE' : null,
      stylesheet: async () => null,
    });
    expect(kept).toContain('url("data:image/png;base64,HARE")');
    expect(kept).toContain('color: red');
    expect(kept).not.toContain(BEACON);
  });

  it('leaves every escape meaning what it meant, as the parser reads it', async () => {
    const css = `.\\31 0\\41 { content: "\\"\\2f\\2a"; } \\41 b { color: r\\65 d; }`;
    const read = (text: string) => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(text);
      return Array.from(sheet.cssRules, (rule) => rule.cssText);
    };
    expect(read(await made(css))).toEqual(read(css));
  });
});

/** The CSS as a browser reads its strings: a backslash before a line break joins the lines. */
const asRead = (css: string) => css.replace(/\\\r?\n/g, '');

// From the verification of PR #536: spellings WebKit loads (seen asking a fake
// server for each, with the frame's policy taken away) that the cleaning kept.
describe("a book's CSS made the book's own, in the spellings WebKit still loads", () => {
  it('keeps no other site named in a url() string broken across two lines with a backslash', async () => {
    // In a CSS string, a backslash before a line break is no character: the address is one line.
    const css = `p { background: url("https://bea\\\ncon.example.com/joined.png"); }`;
    expect(asRead(await made(css))).not.toContain(BEACON);
  });

  it('keeps no other site named in an image-set() after a comment holding a closing parenthesis', async () => {
    const css = `p { background-image: image-set(/* ) */ "https://${BEACON}/paren.png" 1x); }`;
    expect(await made(css)).not.toContain(BEACON);
  });

  it('keeps no other site named in an image-set() between comments holding quotes', async () => {
    // Read as one string, `'#*/"https://…" 1x/*'` begins with `#` and is kept as a place in the chapter.
    const css = `p { background-image: image-set(/*'#*/"https://${BEACON}/quote.png" 1x/*'*/); }`;
    expect(await made(css)).not.toContain(BEACON);
  });
});

// From the review of PR #536: a book's imports, followed into each other.
describe("a book's imports", () => {
  /** The book's stylesheets by path; one read more often than `most` stops the test. */
  const book = (sheets: Record<string, string>, most = 200, limits = STYLE_LIMITS) => {
    const reads: string[] = [];
    const stylesheet = async (path: string) => {
      reads.push(path);
      if (reads.length > most) throw new Error(`${reads.length} stylesheets read`);
      return sheets[path] ?? null;
    };
    const made = (css: string, from = 'OEBPS/chapter.xhtml') =>
      bookCss({ css, from, address: async () => null, stylesheet, limits });
    return { made, reads };
  };

  it('inlines a sheet that imports itself a hundred times once', async () => {
    const loop = `${'@import "loop.css";\n'.repeat(100)}p { color: red; }`;
    const { made, reads } = book({ 'OEBPS/loop.css': loop });
    const text = await made('@import "loop.css"; @import "loop.css";');
    expect(text.match(/color: red/g)).toHaveLength(1);
    expect(reads).toEqual(['OEBPS/loop.css']);
  });

  it('never inlines the sheet it is making', async () => {
    const { made, reads } = book({ 'OEBPS/style.css': 'p { color: red; }' });
    expect(await made('@import "style.css"; h1 { color: blue; }', 'OEBPS/style.css')).not.toMatch(
      /color: red/,
    );
    expect(reads).toEqual([]);
  });

  it(`reads no more than ${MOST_IMPORTS} imported sheets in all`, async () => {
    const sheets: Record<string, string> = {};
    const fan = (prefix: string) =>
      Array.from({ length: 20 }, (_, n) => `@import "${prefix}${n}.css";`).join('\n');
    for (let n = 0; n < 20; n += 1) sheets[`OEBPS/a${n}.css`] = `${fan(`b${n}-`)} .a${n} {}`;
    for (let n = 0; n < 400; n += 1) sheets[`OEBPS/b${Math.floor(n / 20)}-${n % 20}.css`] = '';
    const { made, reads } = book(sheets);
    await made(fan('a'));
    expect(reads.length).toBe(MOST_IMPORTS);
  });

  // The limits made small, so the rules run on small sheets; the e2e suite reads them at full size.
  const small = { ...STYLE_LIMITS, sheetLength: 100, importedLength: 200 };

  it('holds a book to the limits of today by default', () => {
    expect(STYLE_LIMITS).toMatchObject({
      sheetLength: MOST_SHEET_LENGTH,
      imports: MOST_IMPORTS,
      importedLength: MOST_IMPORTED_LENGTH,
    });
    // Two sheets of the most one may be fill the most all may be.
    expect(MOST_IMPORTED_LENGTH).toBe(2 * MOST_SHEET_LENGTH);
  });

  it('drops an imported sheet longer than the most one may be, and stops at the most in all', async () => {
    const long = (n: number) => `p.s${n} { color: red; }`.padEnd(small.sheetLength - 1, ' ');
    const sheets: Record<string, string> = { 'OEBPS/huge.css': `${long(0)}  ` };
    for (let n = 1; n <= 4; n += 1) sheets[`OEBPS/s${n}.css`] = long(n);
    const { made } = book(sheets, 200, small);
    const text = await made(
      ['huge', 's1', 's2', 's3', 's4'].map((name) => `@import "${name}.css";`).join(''),
    );
    expect(text).not.toContain('p.s0');
    expect(text).toContain('p.s1');
    expect(text).toContain('p.s2');
    expect(text).not.toContain('p.s3');
    expect(text).not.toContain('p.s4');
  });

  it('makes nothing of a sheet longer than the most one may be', async () => {
    const { made } = book({}, 200, small);
    expect(await made(`p { color: red; }${' '.repeat(small.sheetLength)}`)).toBe('');
    expect(await made('p { color: red; }')).toContain('color: red');
  });
});

describe("a custom property in a book's CSS", () => {
  it('is dropped when it holds a string or an address, and kept when it does not', async () => {
    const text = await made(
      `p { --a: "https://${BEACON}/a.png"; --b: url(#k); --c: image-set(red 1x); --d: 3px; }`,
    );
    expect(text).not.toContain('--a');
    expect(text).not.toContain('--b');
    expect(text).not.toContain('--c');
    expect(text).toContain('--d: 3px');
  });

  it('is dropped from a style= too', async () => {
    const style = await bookDeclarations({
      style: `--a: 'https://${BEACON}/a.png'; color: red`,
      from: 'OEBPS/chapter.xhtml',
      address: async () => null,
    });
    expect(style).not.toContain(BEACON);
    expect(style).toContain('color: red');
  });
});

// From the third verification of PR #536: CSS WebKit, or the cleaning, reads in more than linear time.
describe("a book's CSS that would be slow to read", () => {
  const own = async (css: string, most = 50_000) =>
    (
      await sheetMade({
        css,
        from: 'OEBPS/style.css',
        address: async () => null,
        budget: { lookups: 0, most },
      })
    ).own;

  it(`drops a sheet nesting brackets more than ${MOST_NESTING} deep, and keeps one that does not`, async () => {
    const deep = (n: number) =>
      `p { color: red; } q { background: ${'('.repeat(n)}${')'.repeat(n)} }`;
    expect(await own(deep(MOST_NESTING + 1))).toBe('');
    expect(await own(deep(MOST_NESTING - 2))).toContain('color: red');
    expect(
      await bookDeclarations({
        style: `color: red; background: ${'['.repeat(MOST_NESTING + 1)}`,
        from: 'OEBPS/chapter.xhtml',
        address: async () => null,
      }),
    ).toBe('');
  });

  it(`drops the declarations of a rule listing more than ${MOST_RULE_LENGTH}`, async () => {
    const many = Array.from({ length: MOST_RULE_LENGTH + 1 }, (_, n) => `--v${n}: 1;`).join(' ');
    const made = await own(`p { ${many} } q { color: red; }`);
    expect(made).not.toContain('--v');
    expect(made).toContain('color: red');
  });

  it('drops the declarations of every rule past the most a sheet may read', async () => {
    const rules = Array.from({ length: 5 }, (_, n) => `p.r${n} { color: red; }`).join('\n');
    expect((await own(rules, 3)).match(/color: red/g)).toHaveLength(3);
  });

  it('drops an all built from var(), and keeps the rest of its rule', async () => {
    const made = await own('h1 { all: var(--unset) inherit; color: red; } h2 { all: inherit; }');
    expect(made).not.toMatch(/all: var/);
    expect(made).toContain('color: red');
  });
});
