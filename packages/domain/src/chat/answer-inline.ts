import type { WikiLinkOrEmbed } from '../markdown/wikilink.ts';
import { scanMarkdown } from '../markdown/wikilink-spans.ts';

/**
 * A piece of an answer's text, as Ask draws it (#37). Nothing in an answer is
 * ever HTML: text is text, a code span is code, and only two things are
 * links — a wiki link to a note (a citation) and a plain `https://` address.
 */
export type AnswerInline =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | {
      readonly kind: 'cite';
      /** The link as written, `[[Kickoff#^t0003]]`: what following it reads. */
      readonly link: string;
      /** What the citation is shown as: its alias, else the note's name, with nothing invisible in it. */
      readonly label: string;
    }
  | {
      readonly kind: 'web';
      readonly url: string;
      readonly label: string;
      /**
       * The host the address opens, when the label does not already show it:
       * `[the portal](https://evil.example.com)` is drawn with
       * `evil.example.com` beside it, so the words cannot pass for another site.
       */
      readonly host: string | null;
    };

/**
 * Characters that draw nothing, or reorder what is drawn: zero-width spaces,
 * the word joiner, the byte-order mark, the soft hyphen, and the bidi marks
 * (the Arabic letter mark too), embeddings, overrides and isolates (U+202E
 * would draw a name backwards, as another note's, or the host beside a web
 * link's label). The zero-width joiner and non-joiner are kept: they shape
 * Persian words and join emoji, and reorder nothing.
 */
const INVISIBLE = /[\u00AD\u061C\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
/** Joiners and space only: nothing anyone could read. */
const ONLY_JOINERS = /^[\u200C\u200D\s]*$/;
const WEB_SCHEME = 'https://';
/** What ends a sentence rather than an address: left out of a bare one. */
const TRAILING = /[.,;:!?'"]+$/;
/** What ends a bare address: space, and the brackets markdown and HTML wrap one in. */
const ADDRESS_END = /[\s<>[\]]/;

/**
 * The pieces of a block's text, in order. Wiki links and code spans are read
 * as the editor reads them (`scanMarkdown`): a link inside code, or escaped,
 * is text, and so cites nothing. Neither does a link to no note — `[[#^id]]`,
 * `[[]]`, or a name that is only invisible characters: Ask is on no note, so
 * there is nothing for it to open.
 */
export function answerInline(text: string): AnswerInline[] {
  const { links, code } = scanMarkdown(text);
  const marks = [
    ...links.flatMap((span) => {
      const piece = citeOf(text.slice(span.start, span.end), span.link);
      return piece === null ? [] : [{ ...span, piece }];
    }),
    ...code.map((span) => ({ ...span, piece: codeOf(text.slice(span.start, span.end)) })),
  ].sort((a, b) => a.start - b.start);
  const pieces: AnswerInline[] = [];
  let cursor = 0;
  for (const mark of marks) {
    if (mark.start < cursor) continue;
    pieces.push(...webPieces(text.slice(cursor, mark.start)));
    pieces.push(mark.piece);
    cursor = mark.end;
  }
  pieces.push(...webPieces(text.slice(cursor)));
  return joinText(pieces);
}

/** A wiki link as a citation, or null for one that names no note anyone can see. */
function citeOf(written: string, link: WikiLinkOrEmbed): AnswerInline | null {
  if (visible(link.target) === '') return null;
  const name = visible(link.target.split('/').pop() ?? link.target);
  const alias = link.alias === null ? '' : visible(link.alias);
  return {
    kind: 'cite',
    link: written.startsWith('!') ? written.slice(1) : written,
    label: alias === '' ? name : alias,
  };
}

/** Text without what draws nothing or reorders the rest, trimmed; empty when only joiners are left. */
function visible(text: string): string {
  const shown = text.replace(INVISIBLE, '').trim();
  return ONLY_JOINERS.test(shown) ? '' : shown;
}

/**
 * A code span without its backticks, and the one space CommonMark strips from
 * each side. A fence left open has no closing run: every character after its
 * opening is kept.
 */
function codeOf(written: string): AnswerInline {
  const ticks = /^`+/.exec(written)?.[0].length ?? 1;
  const closing = /`+$/.exec(written.slice(ticks))?.[0].length ?? 0;
  const inner = written.slice(ticks, written.length - (closing === ticks ? ticks : 0));
  const trimmed = /^ .* $/s.test(inner) && inner.trim() !== '' ? inner.slice(1, -1) : inner;
  return { kind: 'code', text: trimmed };
}

/**
 * Text, with its web links read out of it: `[label](https://…)`, a bare
 * `https://…` and the autolink `<https://…>`. A markdown link to anything
 * else — `http:`, `file:`, `javascript:`, a path, an address with a user
 * part — stays as the text it was written as, never hidden.
 *
 * Read in one pass: each `(` is matched to its `)` up front, within its run
 * of non-space characters, and a label's scan stops at the next `[`, so no
 * character is read more than a few times however the text is made — a
 * streamed answer is read again on every word.
 */
function webPieces(text: string): AnswerInline[] {
  if (text === '') return [];
  const closes = matchedParentheses(text);
  const pieces: AnswerInline[] = [];
  let plain = 0;
  let at = 0;
  while (at < text.length) {
    const link = text[at] === '[' ? markdownLinkAt(text, at, closes) : null;
    if (link === null) {
      at += 1;
      continue;
    }
    pieces.push(...barePieces(text.slice(plain, at), closes, plain));
    pieces.push(link.piece);
    at = link.end;
    plain = at;
  }
  pieces.push(...barePieces(text.slice(plain), closes, plain));
  return pieces;
}

/** For each `(`, where its `)` is, counting nested pairs, within the run of non-space characters it is in. */
function matchedParentheses(text: string): Map<number, number> {
  const closes = new Map<number, number>();
  const open: number[] = [];
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at] as string;
    if (char === '(') open.push(at);
    else if (char === ')') {
      const from = open.pop();
      if (from !== undefined) closes.set(from, at);
    } else if (/\s/.test(char)) open.length = 0;
  }
  return closes;
}

/** `[label](https://…)` starting at `at`, or null when there is none to open there. */
function markdownLinkAt(
  text: string,
  at: number,
  closes: ReadonlyMap<number, number>,
): { piece: AnswerInline; end: number } | null {
  let close = at + 1;
  while (close < text.length && !'[]\n'.includes(text[close] as string)) close += 1;
  if (text[close] !== ']' || close === at + 1 || text[close + 1] !== '(') return null;
  const end = closes.get(close + 1);
  if (end === undefined) return null;
  const url = text.slice(close + 2, end);
  if (!isWebAddress(url)) return null;
  const label = text.slice(at + 1, close);
  return { piece: webPiece({ url, label }), end: end + 1 };
}

/** The bare addresses in `text` (which starts at `offset` of the text `closes` was read from). */
function barePieces(
  text: string,
  closes: ReadonlyMap<number, number>,
  offset: number,
): AnswerInline[] {
  const pieces: AnswerInline[] = [];
  let plain = 0;
  let from = text.indexOf(WEB_SCHEME);
  while (from !== -1) {
    const url = bareAddressAt(text, from, closes, offset);
    if (!isWebAddress(url)) {
      // Past what was read: an address inside a refused one is not looked for again,
      // so a run of `https://` with no space between them is read once.
      from = text.indexOf(WEB_SCHEME, from + Math.max(url.length, WEB_SCHEME.length));
      continue;
    }
    // `<https://…>`: an autolink, drawn without its brackets.
    const bracketed = text[from - 1] === '<' && text[from + url.length] === '>';
    const start = bracketed ? from - 1 : from;
    if (start > plain) pieces.push({ kind: 'text', text: text.slice(plain, start) });
    pieces.push(webPiece({ url, label: url }));
    plain = from + url.length + (bracketed ? 1 : 0);
    from = text.indexOf(WEB_SCHEME, plain);
  }
  if (plain < text.length) pieces.push({ kind: 'text', text: text.slice(plain) });
  return pieces;
}

/**
 * The bare address at `from`, up to a space or a bracket, keeping a `( )`
 * pair it holds — `…/wiki/Foo_(bar)` — and leaving a sentence's end out.
 */
function bareAddressAt(
  text: string,
  from: number,
  closes: ReadonlyMap<number, number>,
  offset: number,
): string {
  let end = from + WEB_SCHEME.length;
  while (end < text.length && !ADDRESS_END.test(text[end] as string)) {
    if (text[end] === ')') break;
    if (text[end] === '(') {
      const close = closes.get(end + offset);
      if (close === undefined) break;
      end = close - offset + 1;
      continue;
    }
    end += 1;
  }
  return text.slice(from, end).replace(TRAILING, '');
}

/**
 * A web link, its label without what reorders or hides text, with its host
 * shown beside the label unless the label is that
 * host or that address, exactly: `mybank.example` naming `k.example`, or
 * `example.com.attacker.example` naming `example.com`, shows the host.
 */
function webPiece({ url, label }: { url: string; label: string }): AnswerInline {
  const host = new URL(url).host;
  // What the model wrote may not reorder the host drawn after it (#557).
  const shown = visible(label) === '' ? url : visible(label);
  const named = shown.toLowerCase() === host || shown === url;
  return { kind: 'web', url, label: shown, host: named ? null : host };
}

/** Neighbouring text pieces as one, so a link that was not read leaves no seam. */
function joinText(pieces: readonly AnswerInline[]): AnswerInline[] {
  const joined: AnswerInline[] = [];
  for (const piece of pieces) {
    const last = joined.at(-1);
    if (piece.kind === 'text' && last?.kind === 'text') {
      joined[joined.length - 1] = { kind: 'text', text: last.text + piece.text };
    } else joined.push(piece);
  }
  return joined;
}

/** The longest address Ask opens: anything longer is text, never handed to `new URL`. */
const MAX_ADDRESS = 2048;

/**
 * The one mending allowed: the `/` the parser puts before a query or a
 * fragment of an address with no path, `https://example.com?q=1`.
 */
function onlySlashAdded(parsed: URL, url: string): boolean {
  const next = url[parsed.origin.length];
  if (next !== '?' && next !== '#') return false;
  return parsed.href === `${parsed.origin}/${url.slice(parsed.origin.length)}`;
}

/**
 * Whether an address is one Ask opens: `https://` with a host and no user
 * part, written exactly as it parses — so the host it shows is the host it
 * opens. An address `new URL` would mend (`https:///host`, `https://\host`,
 * a capital, a space) is left as text.
 */
export function isWebAddress(url: string): boolean {
  if (!url.startsWith(WEB_SCHEME) || url.length > MAX_ADDRESS) return false;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === '' || parsed.username !== '' || parsed.password !== '') return false;
    return parsed.href === url || parsed.href === `${url}/` || onlySlashAdded(parsed, url);
  } catch {
    // Not an address at all: shown as the text it is.
    return false;
  }
}
