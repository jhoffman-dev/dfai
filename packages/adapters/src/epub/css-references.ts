/*
 * The addresses one CSS value names, read as CSS's tokenizer reads them
 * (#505, ADR-0045 §5): a `url(…)`, quoted or not; the string of a `src()`;
 * and each string an `image-set()`, `-webkit-image-set()`, `image()` or
 * `cross-fade()` takes as an address. Comments, escapes and a backslash
 * that joins two lines of a string are read as CSS reads them, so no
 * spelling hides an address. The browser's own parser has already split
 * the stylesheet into rules and declarations; this reads one value of one.
 */

/** What a value's address becomes: kept as written, or the address it is given; null drops the value. */
export type AddressMade = (ref: string) => Promise<string | 'keep' | null>;

/** Functions whose strings are addresses. `url` and `src` take one; the others take images. */
const ADDRESS_FUNCTIONS = new Set([
  'url',
  'src',
  'image-set',
  '-webkit-image-set',
  'image',
  'cross-fade',
  '-webkit-cross-fade',
]);
/** Functions whose value is not known until the page is styled: an address built from one cannot be read here. */
const UNKNOWN_FUNCTIONS = new Set(['var', 'env', 'attr']);

interface Found {
  readonly start: number;
  readonly end: number;
  readonly ref: string;
  /** How the made address is written back: a `url()` token is replaced whole, a string as a string. */
  readonly form: 'url' | 'string';
}

/**
 * `value` with every address it names made by `made`; null when any address
 * may not stay, or when one is built from a value not known here.
 */
export async function valueMade(value: string, made: AddressMade): Promise<string | null> {
  const found = addressesIn(value);
  if (found === null) return null;
  const pieces: string[] = [];
  let last = 0;
  for (const { start, end, ref, form } of found) {
    const address = await made(ref);
    if (address === null) return null;
    const written =
      address === 'keep'
        ? value.slice(start, end)
        : form === 'url'
          ? `url(${quoted(address)})`
          : quoted(address);
    pieces.push(value.slice(last, start), written);
    last = end;
  }
  pieces.push(value.slice(last));
  return pieces.join('');
}

/** Whether `css` names any address `made` would not keep as it is written. */
export async function namesAddress(css: string, made: AddressMade): Promise<boolean> {
  const found = addressesIn(css);
  if (found === null) return true;
  for (const { ref } of found) if ((await made(ref)) !== 'keep') return true;
  return false;
}

/** Each address `value` names, in order; null when one is built from `var()`, `env()` or `attr()`. */
export function addressesIn(value: string): Found[] | null {
  const found: Found[] = [];
  const open: string[] = [];
  // How many of the functions open are address functions: counted, so a var() costs no walk of them.
  let inAddress = 0;
  let at = 0;
  while (at < value.length) {
    if (value.startsWith('/*', at)) {
      const close = value.indexOf('*/', at + 2);
      at = close === -1 ? value.length : close + 2;
    } else if (value[at] === '"' || value[at] === "'") {
      const string = stringAt(value, at);
      if (ADDRESS_FUNCTIONS.has(open.at(-1) ?? '')) {
        found.push({ start: at, end: string.end, ref: string.text, form: 'string' });
      }
      at = string.end;
    } else if (startsName(value, at)) {
      const name = nameAt(value, at);
      at = name.end;
      if (value[at] !== '(') continue;
      const fn = name.text.toLowerCase();
      if (UNKNOWN_FUNCTIONS.has(fn) && inAddress > 0) return null;
      const bare = fn === 'url' ? bareUrlAt(value, at + 1) : null;
      if (bare !== null) {
        found.push({ start: name.start, end: bare.end, ref: bare.text, form: 'url' });
        at = bare.end;
      } else {
        open.push(fn);
        if (ADDRESS_FUNCTIONS.has(fn)) inAddress += 1;
        at += 1;
      }
    } else {
      if (value[at] === '(') open.push('');
      else if (value[at] === ')' && ADDRESS_FUNCTIONS.has(open.pop() ?? '')) inAddress -= 1;
      at += value[at] === '\\' ? 2 : 1;
    }
  }
  return found;
}

/**
 * Whether `value` holds a string, a `url()` or a function that takes an
 * address. A custom property holding one could hand an address to a `var()`
 * inside an address function, where it is only known once the page is styled.
 */
export function namesStringOrAddress(value: string): boolean {
  let at = 0;
  while (at < value.length) {
    if (value.startsWith('/*', at)) {
      const close = value.indexOf('*/', at + 2);
      at = close === -1 ? value.length : close + 2;
    } else if (value[at] === '"' || value[at] === "'") {
      return true;
    } else if (startsName(value, at)) {
      const name = nameAt(value, at);
      at = name.end;
      if (value[at] === '(' && ADDRESS_FUNCTIONS.has(name.text.toLowerCase())) return true;
    } else {
      at += value[at] === '\\' ? 2 : 1;
    }
  }
  return false;
}

/** Whether `value` calls `var()`, `env()` or `attr()`: a value not known until the page is styled. */
export function namesUnknownFunction(value: string): boolean {
  let at = 0;
  while (at < value.length) {
    if (value.startsWith('/*', at)) {
      const close = value.indexOf('*/', at + 2);
      at = close === -1 ? value.length : close + 2;
    } else if (isQuote(value[at])) {
      at = stringAt(value, at).end;
    } else if (startsName(value, at)) {
      const name = nameAt(value, at);
      at = name.end;
      if (value[at] === '(' && UNKNOWN_FUNCTIONS.has(name.text.toLowerCase())) return true;
    } else {
      at += value[at] === '\\' ? 2 : 1;
    }
  }
  return false;
}

/**
 * Whether the blocks of `css` nest more than `most` deep anywhere, read as
 * CSS's tokenizer reads them, in one pass: `(`, a function, `[` and `{` each
 * open a block that only its own closer ends; a closer of another kind is
 * an ordinary token. Strings, comments, escapes, numbers and the body of an
 * unquoted `url(` (a bad one ends at its `)`) hold no blocks. WebKit's
 * parser reads deeply nested blocks in time growing with the square of
 * their depth. Where this differs from the tokenizer it counts deeper, never
 * shallower.
 */
export function nestsDeeperThan(css: string, most: number): boolean {
  const closers: string[] = [];
  const open = (closer: string) => {
    closers.push(closer);
    return closers.length > most;
  };
  let at = 0;
  while (at < css.length) {
    const character = css[at];
    if (css.startsWith('/*', at)) {
      const close = css.indexOf('*/', at + 2);
      at = close === -1 ? css.length : close + 2;
    } else if (isQuote(character)) {
      at = stringAt(css, at).end;
    } else if (startsNumber(css, at)) {
      at = numberEnd(css, at);
      // A unit is a name, never a function: `1url(` is a number, a unit and a `(`.
      if (startsName(css, at)) at = nameAt(css, at).end;
    } else if ((character === '#' || character === '@') && startsNameAfterSign(css, at + 1)) {
      at = nameAt(css, at + 1).end;
    } else if (startsName(css, at)) {
      const name = nameAt(css, at);
      at = name.end;
      if (css[at] !== '(') continue;
      const bare = name.text.toLowerCase() === 'url' ? bareUrlAt(css, at + 1) : null;
      if (bare !== null) at = bare.end;
      else if (open(')')) return true;
      else at += 1;
    } else {
      const closer = CLOSERS[character ?? ''];
      if (closer !== undefined && open(closer)) return true;
      if (closer === undefined && character === closers.at(-1)) closers.pop();
      at += 1;
    }
  }
  return false;
}

/** The closer each block's opener is ended by. */
const CLOSERS: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' };

/** Whether a number starts at `at`: a digit, or a sign or a point before one. */
function startsNumber(css: string, at: number): boolean {
  const digit = (offset: number) => isDigit(css[at + offset]);
  const character = css[at];
  if (character === '+' || character === '-') return digit(1) || (css[at + 1] === '.' && digit(2));
  if (character === '.') return digit(1);
  return digit(0);
}

/** Where the number starting at `start` ends: its sign, digits, point, digits and exponent. */
function numberEnd(css: string, start: number): number {
  let at = start;
  if (css[at] === '+' || css[at] === '-') at += 1;
  while (isDigit(css[at])) at += 1;
  if (css[at] === '.' && isDigit(css[at + 1])) {
    at += 1;
    while (isDigit(css[at])) at += 1;
  }
  const sign = css[at + 1] === '+' || css[at + 1] === '-' ? 1 : 0;
  if ((css[at] === 'e' || css[at] === 'E') && isDigit(css[at + 1 + sign])) {
    at += 1 + sign;
    while (isDigit(css[at])) at += 1;
  }
  return at;
}

/** Whether a hash's or an at-keyword's name follows its sign at `at`. */
const startsNameAfterSign = (css: string, at: number) =>
  isNameCharacter(css[at]) ||
  (css[at] === '\\' && css[at + 1] !== undefined && !isNewline(css[at + 1]));

/** One declaration as a rule writes it out: its name, its value, and its text. */
export interface Declaration {
  readonly name: string;
  readonly value: string;
  readonly text: string;
}

/**
 * The declarations of `cssText`, as a rule's style writes them out, split
 * where each ends: at a `;` outside any string, comment, function or block.
 */
export function declarationsIn(cssText: string): Declaration[] {
  const declarations: Declaration[] = [];
  let depth = 0;
  let start = 0;
  let at = 0;
  const end = () => {
    const text = cssText.slice(start, at).trim();
    const colon = text.indexOf(':');
    if (colon !== -1) {
      declarations.push({
        name: text.slice(0, colon).trim(),
        value: text.slice(colon + 1).trim(),
        text: `${text};`,
      });
    }
    start = at + 1;
  };
  while (at < cssText.length) {
    const character = cssText[at];
    if (cssText.startsWith('/*', at)) {
      const close = cssText.indexOf('*/', at + 2);
      at = close === -1 ? cssText.length : close + 2;
      continue;
    }
    if (character === '"' || character === "'") {
      at = stringAt(cssText, at).end;
      continue;
    }
    if (character === '(' || character === '[' || character === '{') depth += 1;
    else if ((character === ')' || character === ']' || character === '}') && depth > 0) depth -= 1;
    else if (character === ';' && depth === 0) end();
    at += character === '\\' ? 2 : 1;
  }
  at = cssText.length;
  end();
  return declarations;
}

/**
 * The stylesheet each `@import` in `css` names, in order: quoted, or in a
 * `url()`, after any space and comments. Comments and strings are passed
 * over as CSS reads them, in one pass that never goes back, so no spelling
 * makes it slow; a comment left open ends the reading, as it ends the sheet.
 */
export function importsIn(css: string): string[] {
  const found: string[] = [];
  let at = 0;
  while (at < css.length) {
    if (css.startsWith('/*', at)) {
      const close = css.indexOf('*/', at + 2);
      if (close === -1) break;
      at = close + 2;
    } else if (isQuote(css[at])) {
      at = stringAt(css, at).end;
    } else if (css[at] === '@' && css.slice(at, at + 7).toLowerCase() === '@import') {
      const reference = importAt(css, at + 7);
      if (reference === null) break;
      if (reference.text !== null) found.push(reference.text);
      at = reference.end;
    } else {
      at += css[at] === '\\' ? 2 : 1;
    }
  }
  return found;
}

/** The stylesheet an `@import` whose name ends at `start` names, if any, and where it ends; null when a comment is left open. */
function importAt(css: string, start: number): { end: number; text: string | null } | null {
  const at = spaceAndCommentsAfter(css, start);
  if (at === null) return null;
  if (isQuote(css[at])) return stringAt(css, at);
  if (css.slice(at, at + 4).toLowerCase() !== 'url(') return { end: at, text: null };
  // Inside `url(`, only space comes before a string: a comment there is the address's own.
  let inside = at + 4;
  while (isSpace(css[inside])) inside += 1;
  return isQuote(css[inside])
    ? stringAt(css, inside)
    : (bareUrlAt(css, at + 4) ?? { end: inside, text: null });
}

/** Where the space and comments from `start` end; null when a comment is left open to the end. */
function spaceAndCommentsAfter(css: string, start: number): number | null {
  let at = start;
  for (;;) {
    while (isSpace(css[at])) at += 1;
    if (!css.startsWith('/*', at)) return at;
    const close = css.indexOf('*/', at + 2);
    if (close === -1) return null;
    at = close + 2;
  }
}

/** The string token at `start`, its escapes read; it ends at its quote, or unclosed at a line break. */
function stringAt(css: string, start: number): { end: number; text: string } {
  const quote = css[start];
  let text = '';
  let at = start + 1;
  while (at < css.length && css[at] !== quote && !isNewline(css[at])) {
    if (css[at] === '\\') {
      const escape = escapeAt(css, at);
      text += escape.text;
      at = escape.end;
    } else {
      text += css[at];
      at += 1;
    }
  }
  return { end: Math.min(at + 1, css.length), text };
}

/** The unquoted `url(` token whose contents begin at `start`; null when a quoted string follows instead. */
function bareUrlAt(css: string, start: number): { end: number; text: string } | null {
  let at = start;
  while (isSpace(css[at])) at += 1;
  if (css[at] === '"' || css[at] === "'") return null;
  let text = '';
  while (at < css.length && css[at] !== ')') {
    if (css[at] === '\\') {
      const escape = escapeAt(css, at);
      text += escape.text;
      at = escape.end;
    } else {
      text += css[at];
      at += 1;
    }
  }
  return { end: Math.min(at + 1, css.length), text: text.trim() };
}

/** A name (an ident) at `start`, its escapes read: `u\72l` is `url`. */
function nameAt(css: string, start: number): { start: number; end: number; text: string } {
  let text = '';
  let at = start;
  while (at < css.length) {
    if (css[at] === '\\' && !isNewline(css[at + 1])) {
      const escape = escapeAt(css, at);
      text += escape.text;
      at = escape.end;
    } else if (isNameCharacter(css[at])) {
      text += css[at];
      at += 1;
    } else break;
  }
  return { start, end: at, text };
}

/**
 * The escape at `start`, a backslash: up to six hex digits and one white
 * space that ends them, a line break that is no character (in a string), or
 * the one character it stands for.
 */
function escapeAt(css: string, start: number): { end: number; text: string } {
  const next = css[start + 1];
  if (next === undefined) return { end: start + 1, text: '' };
  if (next === '\r' && css[start + 2] === '\n') return { end: start + 3, text: '' };
  if (isNewline(next)) return { end: start + 2, text: '' };
  const hex = /^[0-9a-f]{1,6}/i.exec(css.slice(start + 1, start + 7))?.[0];
  if (hex === undefined) return { end: start + 2, text: next };
  let end = start + 1 + hex.length;
  if (css[end] === '\r' && css[end + 1] === '\n') end += 2;
  else if (isSpace(css[end])) end += 1;
  const code = Number.parseInt(hex, 16);
  const ok = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
  return { end, text: ok ? String.fromCodePoint(code) : '\uFFFD' };
}

function startsName(css: string, at: number): boolean {
  const character = css[at];
  if (character === '\\') return !isNewline(css[at + 1]) && css[at + 1] !== undefined;
  return character !== undefined && /[a-z_\u0080-\uFFFF-]/i.test(character);
}

const isNameCharacter = (character: string | undefined) =>
  character !== undefined && /[\w\u0080-\uFFFF-]/.test(character);
const isNewline = (character: string | undefined) =>
  character === '\n' || character === '\r' || character === '\f';
const isDigit = (character: string | undefined) =>
  character !== undefined && character >= '0' && character <= '9';
const isQuote = (character: string | undefined) => character === '"' || character === "'";
const isSpace = (character: string | undefined) =>
  character === ' ' || character === '\t' || isNewline(character);

/** `text` as a CSS string, quoted. */
const quoted = (text: string) =>
  `"${text.replace(/[\\"]/g, '\\$&').replace(/[\n\r\f]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)}"`;
