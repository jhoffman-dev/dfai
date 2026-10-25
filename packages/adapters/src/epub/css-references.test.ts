import { describe, expect, it } from 'vitest';
import {
  addressesIn,
  declarationsIn,
  importsIn,
  namesAddress,
  namesStringOrAddress,
  namesUnknownFunction,
  nestsDeeperThan,
  valueMade,
  type AddressMade,
} from './css-references.ts';

/*
 * The addresses one CSS value names, read as CSS's tokenizer reads them
 * (#505, ADR-0045 §5). The browser's parser hands these values over already
 * read; a custom property's value it hands over as the book wrote it.
 */

const refs = (value: string) => addressesIn(value)?.map(({ ref }) => ref) ?? null;

/** The book's own files under `pics/` get an address, data and places stay, anything else is dropped. */
const made: AddressMade = async (ref) =>
  ref.startsWith('#') || ref.startsWith('data:')
    ? 'keep'
    : ref.startsWith('pics/')
      ? `data:image/png;base64,${ref.slice(5, -4).toUpperCase()}`
      : null;

describe('the addresses a CSS value names', () => {
  it('reads url() quoted and bare, src(), and the strings an image-set() or cross-fade() takes', () => {
    expect(
      refs(
        `url("a.png") url( b.png ) src('c.woff') image-set("d.png" 1x, url(e.png) 2x) cross-fade(url(f.png) 50%, image("g.png"))`,
      ),
    ).toEqual(['a.png', 'b.png', 'c.woff', 'd.png', 'e.png', 'f.png', 'g.png']);
  });

  it('reads no string that names a type, a format, a font or the words shown', () => {
    expect(
      refs(`image-set("a.png" 1x type("image/png")) format("woff") local("Georgia") "Hi"`),
    ).toEqual(['a.png']);
  });

  it('reads escapes, comments and a string joined across lines as CSS does', () => {
    expect(refs(`u\\72l(https://x.example/a.png)`)).toEqual(['https://x.example/a.png']);
    expect(refs(`url("https://bea\\\ncon.example.com/j.png")`)).toEqual([
      'https://beacon.example.com/j.png',
    ]);
    expect(refs(`image-set(/* ) */ "https://x.example/p.png" 1x)`)).toEqual([
      'https://x.example/p.png',
    ]);
    expect(refs(`image-set(/*'#*/"https://x.example/q.png" 1x/*'*/)`)).toEqual([
      'https://x.example/q.png',
    ]);
    expect(refs(`-webkit-image-set("\\68ttps://x.example/w.png" 1x)`)).toEqual([
      'https://x.example/w.png',
    ]);
  });

  it('cannot read an address built from var(), env() or attr()', () => {
    expect(addressesIn('image-set(var(--picture) 1x)')).toBeNull();
    expect(addressesIn('src(env(--x))')).toBeNull();
    expect(addressesIn('cross-fade(attr(data-x) 50%, url(a.png))')).toBeNull();
    // Outside an address, a var() names no file.
    expect(addressesIn('var(--colour) linear-gradient(red, var(--x))')).toEqual([]);
  });
});

describe('a CSS value made the book’s own', () => {
  it("gives the book's own pictures their addresses and keeps a type() and data as they are", async () => {
    expect(
      await valueMade(
        `image-set("pics/hare.png" 1x type("image/png"), "data:image/png;base64,AA==" 2x)`,
        made,
      ),
    ).toBe(
      `image-set("data:image/png;base64,HARE" 1x type("image/png"), "data:image/png;base64,AA==" 2x)`,
    );
    expect(await valueMade('url(pics/hare.png) no-repeat, url(#grad)', made)).toBe(
      'url("data:image/png;base64,HARE") no-repeat, url(#grad)',
    );
  });

  it('is dropped when it names anything else, or builds an address from var()', async () => {
    expect(await valueMade('url(pics/hare.png), url(https://x.example/a.png)', made)).toBeNull();
    expect(await valueMade('image-set(var(--p) 1x)', made)).toBeNull();
    expect(await valueMade('red', made)).toBe('red');
  });

  it('quotes an address so it cannot end its string', async () => {
    expect(await valueMade('url(x)', async () => 'data:a"b\\c')).toBe('url("data:a\\"b\\\\c")');
  });

  it('says whether a rule names an address it cannot keep as written', async () => {
    expect(await namesAddress('@property --p { initial-value: url(#k); }', made)).toBe(false);
    expect(await namesAddress('@property --p { initial-value: url(pics/a.png); }', made)).toBe(
      true,
    );
    expect(await namesAddress('@counter-style s { symbols: image-set(var(--x) 1x); }', made)).toBe(
      true,
    );
  });
});

// From the review of PR #536: WebKit writes a shorthand built with var() out whole, so each
// declaration is read again as the rule writes it out.
describe('the declarations a rule writes out', () => {
  it('splits them where a declaration ends, not inside a string, a function or a block', () => {
    expect(
      declarationsIn(
        `--a: "x; y"; background: image-set(var(--a) 1x) red; --b: { c: d; }; mask-clip: ; color: red !important`,
      ).map(({ name, value }) => [name, value]),
    ).toEqual([
      ['--a', '"x; y"'],
      ['background', 'image-set(var(--a) 1x) red'],
      ['--b', '{ c: d; }'],
      ['mask-clip', ''],
      ['color', 'red !important'],
    ]);
  });
});

describe('a value that could name an address through var()', () => {
  it('holds a string, a url() or a function that takes an address', () => {
    expect(namesStringOrAddress('"https://x.example/a.png"')).toBe(true);
    expect(namesStringOrAddress("'Georgia'")).toBe(true);
    expect(namesStringOrAddress('u\\72l(a.png)')).toBe(true);
    expect(namesStringOrAddress('IMAGE-SET(a 1x)')).toBe(true);
    expect(namesStringOrAddress('cross-fade(red, blue)')).toBe(true);
    expect(namesStringOrAddress('3px solid /* "a" */ rgb(0 0 0)')).toBe(false);
  });
});

describe('the stylesheets a sheet imports', () => {
  it('reads each @import, quoted, in url() or after a comment', () => {
    expect(
      importsIn(
        `@import "a.css"; @IMPORT url( 'b.css' ) screen; @import/**/url(c.css); @import/* x */"d.css";\np {}`,
      ),
    ).toEqual(['a.css', 'b.css', 'c.css', 'd.css']);
  });

  it('reads no import from a comment left open', () => {
    expect(importsIn('@import "a.css"; /* @import "b.css";')).toEqual(['a.css']);
  });
});

// From the review of PR #536: each of these took time growing with the square of the CSS.
describe('reading CSS a book writes to be slow', () => {
  const quickly = (read: () => unknown) => {
    const started = performance.now();
    read();
    return performance.now() - started;
  };

  it('reads a var() inside fifty thousand parentheses in linear time', () => {
    const value = `${'('.repeat(50_000)}${'var(--x)'.repeat(50_000)}`;
    expect(quickly(() => addressesIn(value))).toBeLessThan(2_000);
  });

  it('finds the imports among a hundred thousand left open in linear time', () => {
    for (const css of [
      '@import /*'.repeat(100_000),
      `${'@import /*'.repeat(100_000)}*/`,
      '@import url('.repeat(100_000),
      `@import '${'@import "'.repeat(100_000)}`,
    ]) {
      expect(quickly(() => importsIn(css))).toBeLessThan(2_000);
    }
  });
});

describe('what a value calls, and how deep it nests', () => {
  it('finds var(), env() or attr() however spelled, and none in a string or comment', () => {
    expect(namesUnknownFunction('VAR(--x) inherit')).toBe(true);
    expect(namesUnknownFunction('v\\61r(--x)')).toBe(true);
    expect(namesUnknownFunction('"var(--x)" /* env(x) */ inherit')).toBe(false);
  });

  it('counts brackets of every kind, and none in a string or comment', () => {
    expect(nestsDeeperThan('a { b: ([c]) }', 3)).toBe(false);
    expect(nestsDeeperThan('a { b: ([{c}]) }', 3)).toBe(true);
    expect(nestsDeeperThan(`"${'('.repeat(10)}" /* ${'['.repeat(10)} */`, 1)).toBe(false);
  });
});

// From the review of 522b35f4 on PR #536: the nesting check must never read a sheet as shallower
// than the browser's tokenizer does, or WebKit's quadratic parse is back.
describe('how deep CSS nests, as the tokenizer reads it', () => {
  it.each([
    ['a closer that is not its opener’s', `a{b:${'(]'.repeat(1000)}}`],
    ['a comment opened inside an unquoted url()', `a{b:url(x/*) ${'('.repeat(1000)}`],
    ['a quote inside an unquoted url()', `a{b:url(x"y) ${'('.repeat(1000)}`],
    ['an escaped closer', `a{b:${'(\\)'.repeat(1000)}}`],
  ])('counts past %s', (_, css) => {
    expect(nestsDeeperThan(css, 32)).toBe(true);
  });

  it('never counts less deep than a tokenizer written to the spec, over seeded soup', () => {
    let seed = 536;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const PIECES = [
      '(',
      ')',
      '[',
      ']',
      '{',
      '}',
      '"',
      "'",
      '/*',
      '*/',
      'url(',
      '\\',
      ';',
      'a',
      ' ',
      '\n',
    ];
    for (let run = 0; run < 3000; run += 1) {
      const length = 1 + Math.floor(random() * 120);
      const css = Array.from({ length }, () => PIECES[Math.floor(random() * PIECES.length)]).join(
        '',
      );
      const depth = specDepth(css);
      if (depth > 0) expect(nestsDeeperThan(css, depth - 1), JSON.stringify(css)).toBe(true);
    }
  });
});

/**
 * The deepest the blocks of `css` nest, as CSS Syntax Level 3 tokenizes it
 * (§4.3) and nests its blocks (§5): an opener, or a function, is closed
 * only by its own closer. Written apart from `nestsDeeperThan`, for the
 * characters the soup above is made of.
 */
function specDepth(css: string): number {
  let at = 0;
  const open: string[] = [];
  let deepest = 0;
  const isHex = (c: string | undefined) => c !== undefined && /[0-9a-f]/i.test(c);
  const isWhite = (c: string | undefined) => c === ' ' || c === '\n' || c === '\t';
  const validEscape = (i: number) =>
    css[i] === '\\' && css[i + 1] !== undefined && css[i + 1] !== '\n';
  const isNameStart = (c: string | undefined) => c !== undefined && /[a-z_\u0080-￿]/i.test(c);
  const isName = (c: string | undefined) => c !== undefined && (isNameStart(c) || /[0-9-]/.test(c));
  const startsIdent = (i: number) =>
    css[i] === '-'
      ? isNameStart(css[i + 1]) || css[i + 1] === '-' || validEscape(i + 1)
      : isNameStart(css[i]) || validEscape(i);
  /** Consumes the escape whose backslash is at `at`, and says what it stands for. */
  const escape = (): string => {
    at += 1;
    if (isHex(css[at])) {
      let hex = '';
      while (hex.length < 6 && isHex(css[at])) hex += css[at++];
      if (isWhite(css[at])) at += 1;
      return String.fromCodePoint(Math.min(Number.parseInt(hex, 16), 0x10ffff) || 0xfffd);
    }
    return css[at++] ?? '';
  };
  const push = (closer: string) => {
    open.push(closer);
    deepest = Math.max(deepest, open.length);
  };
  const remnants = () => {
    while (at < css.length) {
      if (css[at] === ')') return void (at += 1);
      if (validEscape(at)) escape();
      else at += 1;
    }
  };
  const url = () => {
    while (isWhite(css[at])) at += 1;
    while (at < css.length) {
      const c = css[at];
      if (c === ')') return void (at += 1);
      if (isWhite(c)) {
        while (isWhite(css[at])) at += 1;
        if (css[at] === ')' || at >= css.length) return void (at += 1);
        return remnants();
      }
      if (c === '"' || c === "'" || c === '(') return remnants();
      if (c === '\\') {
        if (validEscape(at)) escape();
        else return remnants();
      } else at += 1;
    }
  };
  while (at < css.length) {
    const c = css[at];
    if (c === '/' && css[at + 1] === '*') {
      const close = css.indexOf('*/', at + 2);
      at = close === -1 ? css.length : close + 2;
    } else if (c === '"' || c === "'") {
      at += 1;
      while (at < css.length && css[at] !== c && css[at] !== '\n') {
        if (css[at] === '\\') {
          if (css[at + 1] === undefined) at += 1;
          else if (css[at + 1] === '\n') at += 2;
          else escape();
        } else at += 1;
      }
      if (css[at] === c) at += 1;
    } else if (startsIdent(at)) {
      let name = '';
      while (at < css.length) {
        if (validEscape(at)) name += escape();
        else if (isName(css[at])) name += css[at++];
        else break;
      }
      if (css[at] !== '(') continue;
      at += 1;
      if (name.toLowerCase() === 'url') {
        while (isWhite(css[at]) && isWhite(css[at + 1])) at += 1;
        const next = isWhite(css[at]) ? css[at + 1] : css[at];
        if (next !== '"' && next !== "'") {
          url();
          continue;
        }
      }
      push(')');
    } else {
      if (c === '(') push(')');
      else if (c === '[') push(']');
      else if (c === '{') push('}');
      else if (c === open.at(-1)) open.pop();
      at += 1;
    }
  }
  return deepest;
}
