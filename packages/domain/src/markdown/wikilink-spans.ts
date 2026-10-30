import type { WikiLinkOrEmbed } from './wikilink.ts';
import { escapable, WikiLinkReader } from './wikilink-reader.ts';

/** A wiki link found in markdown: where it is, where its target ends, and what it reads as. */
export interface WikiLinkSpan {
  readonly start: number;
  readonly end: number;
  /** Where the target starts and ends: what a rename rewrites. */
  readonly targetStart: number;
  readonly targetEnd: number;
  readonly link: WikiLinkOrEmbed;
}

/** A comment in the markdown, from its `<!--` to its `-->`. */
export interface CommentSpan {
  readonly start: number;
  readonly end: number;
}

/** Code in the markdown: a fenced block, fences included, or a code span, backticks included. */
export interface CodeSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * Every wiki link in a note's markdown, read as the editor reads it
 * (ADR-0004, A21-04), and every comment. A link is text, not a link, where
 * the editor's parser would see something else first:
 *
 * - escaped, `\[[x]]`;
 * - in code: a fenced block, or a code span, which wins over a link it
 *   would overlap (`WikiLinkReader`);
 * - in a comment, `<!-- [[x]] -->`, or on the line after one that starts
 *   its line, which markdown reads as HTML.
 *
 * The paragraph a code span may close in is read from the lines: it ends at
 * a blank line, a heading, a table row, a fence, a list item or a comment
 * starting its line, and a heading's or a table cell's ends with it. A table
 * row is split into cells at each unescaped `|` before a link is read, so an
 * alias's pipe there must be written `\|`. HTML blocks and tags, autolinks
 * and indented code are not modelled: a link in one is still read as a link.
 */
export function scanMarkdown(markdown: string): {
  links: WikiLinkSpan[];
  comments: CommentSpan[];
  /** In the order they start. */
  code: CodeSpan[];
} {
  return new Scan(markdown).run();
}

/** `scanMarkdown`'s links alone. */
export function wikiLinkSpans(markdown: string): WikiLinkSpan[] {
  return scanMarkdown(markdown).links;
}

/**
 * The line that would close the fenced code block a note's markdown ends in,
 * left open — the fence it opened with, after the same quote markers — or
 * null when it ends in none. Markdown reads such a block on to the end of the
 * note, so anything written after it is code until that line is.
 */
export function openFenceClosing(markdown: string): string | null {
  return new Scan(markdown).openFenceClosing();
}

/**
 * One link written alone — a `wikiLink` node's value, say: what it reads as,
 * or null when `source` is not exactly one link.
 */
export function readWikiLink(source: string): WikiLinkOrEmbed | null {
  const reader = new WikiLinkReader();
  for (let at = 0; at < source.length; at += 1) {
    const step = reader.read(source[at] as string);
    if (step === 'reject') return null;
    if (step === 'accept') return at === source.length - 1 ? reader.link : null;
  }
  return null;
}

type LineKind = 'blank' | 'text' | 'heading' | 'row' | 'fence' | 'item' | 'html';

interface Line {
  readonly start: number;
  /** The end of its text, before any `\r\n`. */
  readonly end: number;
  /** The start of the next line, or the end of the markdown. */
  readonly next: number;
  readonly kind: LineKind;
  /** Where its content starts, after any `>` quote markers. */
  readonly content: number;
}

/** Quote markers, then a list marker: what may come before a block on its line. */
const CONTAINER = /^[ \t]*(?:>[ \t]?)*/;
const FLOW_COMMENT_PREFIX = /^[ \t]*(?:>[ \t]?)*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/;

function kindOf(content: string): LineKind {
  if (content.trim() === '') return 'blank';
  if (FENCE.test(content)) return 'fence';
  if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(content)) return 'heading';
  if (/^ {0,3}\|/.test(content)) return 'row';
  if (/^ {0,3}<!--/.test(content)) return 'html';
  if (/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(content)) return 'blank';
  if (/^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/.test(content)) return 'item';
  return 'text';
}

class Scan {
  private readonly lines: Line[] = [];
  /** For each line, where the paragraph it is in ends. */
  private readonly paragraphEnd: number[] = [];
  /** `closing` is what would close a block nothing closes: its quote markers and its fence. */
  private readonly fences: { start: number; end: number; closing: string | null }[] = [];
  /** Where each run of backticks starts, by its length. */
  private readonly runs = new Map<number, number[]>();
  private readonly links: WikiLinkSpan[] = [];
  private readonly comments: CommentSpan[] = [];
  private readonly code: CodeSpan[] = [];
  /** The last `-->` searched for, and where the search began: -2 before any. */
  private close = -2;
  private closeSearchedFrom = 0;

  constructor(private readonly text: string) {
    this.readLines();
    this.readRuns();
  }

  /** The line that would close the fenced block the markdown ends in, left open; null when none is. */
  openFenceClosing(): string | null {
    return this.fences.at(-1)?.closing ?? null;
  }

  run(): { links: WikiLinkSpan[]; comments: CommentSpan[]; code: CodeSpan[] } {
    const { text } = this;
    let fence = 0;
    let at = 0;
    while (at < text.length) {
      const inFence = this.fences[fence];
      if (inFence !== undefined && at >= inFence.start) {
        this.code.push({ start: inFence.start, end: inFence.end });
        at = Math.max(at, inFence.end);
        fence += 1;
        continue;
      }
      at = this.step(at);
    }
    return { links: this.links, comments: this.comments, code: this.code };
  }

  /** Reads what starts at `at`, and returns where to read next. */
  private step(at: number): number {
    const { text } = this;
    const char = text[at];
    if (char === '\\') return at + (escapable(text[at + 1]) ? 2 : 1);
    if (char === '`') return this.codeSpan(at);
    if (char === '<' && text.startsWith('<!--', at)) return this.comment(at);
    if (char === '!' || char === '[') return this.link(at) ?? at + 1;
    return at + 1;
  }

  /** A code span from the run at `at`, or the run as text when nothing closes it. */
  private codeSpan(at: number): number {
    let end = at;
    while (this.text[end] === '`') end += 1;
    const closer = this.closer(end, end - at, this.scopeEnd(at));
    if (closer === null) return end;
    this.code.push({ start: at, end: closer + (end - at) });
    return closer + (end - at);
  }

  /** The first run of exactly `length` backticks from `from`, before `limit`. */
  private closer(from: number, length: number, limit: number): number | null {
    const starts = this.runs.get(length);
    if (starts === undefined) return null;
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((starts[middle] as number) < from) low = middle + 1;
      else high = middle;
    }
    const start = starts[low];
    return start !== undefined && start < limit ? start : null;
  }

  /**
   * `<!-- … -->`. One that starts its line is an HTML block, which runs to the
   * end of the line the comment closes on; one inside a paragraph must close in it.
   */
  private comment(at: number): number {
    const line = this.lineAt(at);
    const flow = FLOW_COMMENT_PREFIX.test(this.text.slice(line.start, at));
    const close = this.closeOfComment(at + 4);
    const limit = flow ? this.text.length : this.scopeEnd(at);
    if (close === -1 || close + 3 > limit) return flow ? this.text.length : at + 1;
    this.comments.push({ start: at, end: close + 3 });
    return flow ? this.lineAt(close).next : close + 3;
  }

  /**
   * The next `-->` from `from`, or -1. The last one found is kept, so a text
   * of unclosed comments is searched to its end once, not once per `<!--`.
   */
  private closeOfComment(from: number): number {
    const stillAhead = this.close >= from;
    const noneAfter = this.close === -1 && this.closeSearchedFrom <= from;
    if (!stillAhead && !noneAfter) {
      this.close = this.text.indexOf('-->', from);
      this.closeSearchedFrom = from;
    }
    return this.close;
  }

  /** The link starting at `at`, recorded, and where it ends; or null for none. */
  private link(at: number): number | null {
    const { text } = this;
    const reader = new WikiLinkReader();
    // A table row is split into cells before a link is read in one.
    const line = this.lineAt(at);
    const stop = line.kind === 'row' ? this.cellEnd(at, line.end) : text.length;
    for (let index = at; ; index += 1) {
      const step = reader.read(index < stop ? (text[index] as string) : null);
      if (step === 'reject') return null;
      if (step === 'more') continue;
      const end = index + 1;
      const limit = this.scopeEnd(at);
      if (reader.openers.some((length) => this.closer(end, length, limit) !== null)) return null;
      const targetStart = at + (reader.link.embed ? 3 : 2);
      this.links.push({
        start: at,
        end,
        targetStart,
        targetEnd: at + reader.targetLength,
        link: reader.link,
      });
      return end;
    }
  }

  /** Where a code span or comment opened at `at` must close by: its paragraph's or cell's end. */
  private scopeEnd(at: number): number {
    const index = this.lineIndexAt(at);
    const line = this.lines[index] as Line;
    if (line.kind === 'heading') return line.end;
    if (line.kind === 'row') return this.cellEnd(at, line.end);
    return this.paragraphEnd[index] as number;
  }

  /** The next unescaped `|` after `at` on its line, or the line's end. */
  private cellEnd(at: number, lineEnd: number): number {
    for (let index = at; index < lineEnd; index += 1) {
      const char = this.text[index];
      if (char === '\\') index += 1;
      else if (char === '|') return index;
    }
    return lineEnd;
  }

  private lineAt(at: number): Line {
    return this.lines[this.lineIndexAt(at)] as Line;
  }

  /** The index of the line holding `at`. */
  private lineIndexAt(at: number): number {
    let low = 0;
    let high = this.lines.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((this.lines[middle] as Line).start <= at) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  private readLines(): void {
    const { text } = this;
    let start = 0;
    do {
      const newline = text.indexOf('\n', start);
      const next = newline === -1 ? text.length : newline + 1;
      const end = newline === -1 ? text.length : newline - (text[newline - 1] === '\r' ? 1 : 0);
      const prefix = CONTAINER.exec(text.slice(start, end))?.[0].length ?? 0;
      const content = start + prefix;
      this.lines.push({ start, end, next, content, kind: kindOf(text.slice(content, end)) });
      start = next;
    } while (start < text.length);
    this.readFences();
    // A paragraph runs on over lines of text; anything else ends it.
    let end = text.length;
    for (let index = this.lines.length - 1; index >= 0; index -= 1) {
      const line = this.lines[index] as Line;
      this.paragraphEnd[index] = line.kind === 'blank' ? line.end : end;
      if (line.kind !== 'text') end = line.start;
    }
  }

  /** Fenced code blocks: from an opening fence to the next as long of its kind, or the end. */
  private readFences(): void {
    const { lines, text } = this;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] as Line;
      if (line.kind !== 'fence') continue;
      const fence = FENCE.exec(text.slice(line.content, line.end))?.[1] ?? '```';
      const closing = new RegExp(
        `^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`,
      );
      let close = index + 1;
      while (close < lines.length) {
        const candidate = lines[close] as Line;
        if (closing.test(text.slice(candidate.content, candidate.end))) break;
        close += 1;
      }
      const last = lines[Math.min(close, lines.length - 1)] as Line;
      const closed = close < lines.length;
      this.fences.push({
        start: line.start,
        end: closed ? last.next : text.length,
        closing: closed ? null : `${text.slice(line.start, line.content)}${fence}`,
      });
      index = close;
    }
  }

  private readRuns(): void {
    for (const match of this.text.matchAll(/`+/g)) {
      const length = match[0].length;
      const starts = this.runs.get(length) ?? [];
      starts.push(match.index);
      this.runs.set(length, starts);
    }
  }
}
