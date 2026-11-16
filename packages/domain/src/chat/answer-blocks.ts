/**
 * An answer's markdown, cut into the blocks the citation check judges one by
 * one (#37): paragraphs, list items, quotes and tables say something, so each
 * must cite where it came from; headings, rules and fenced code do not.
 *
 * This is not a markdown parser. It reads the shapes a model writes an answer
 * in — the line kinds CommonMark starts a block with — and nothing it cannot
 * read is lost: every line of the answer lands in some block, as text.
 */

export type AnswerBlockKind =
  'paragraph' | 'item' | 'quote' | 'table' | 'heading' | 'rule' | 'code';

/** One block of an answer, with its markers taken off: what the block says, as written. */
export interface RawAnswerBlock {
  readonly kind: AnswerBlockKind;
  /** The block's text: a quote without its `>`, an item without its marker, code without its fences. */
  readonly text: string;
  /** A list item's marker as written (`-`, `2.`); null for every other block. */
  readonly marker: string | null;
  /** How deep a list item is nested, from 0; 0 for every other block. */
  readonly depth: number;
  /** Inside a `>` quote: a list there is drawn in the quote, each item judged on its own. */
  readonly quoted: boolean;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}#{1,6}(?:\s|$)/;
const RULE = /^ {0,3}([-*_])(?: *\1){2,} *$/;
/** A line of `=` or `-` under a paragraph: it makes the paragraph a heading (setext). */
const SETEXT = /^ {0,3}(?:=+|-+) *$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(?:\s+(.*))?$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const TABLE = /^\s*\|/;

/** What the block being read is, while lines may still join it. */
interface Open {
  kind: 'paragraph' | 'item' | 'quote' | 'table';
  lines: string[];
  marker: string | null;
  depth: number;
  /** Where an item's own text starts: a later line indented this far is still the item. */
  indent: number;
  /** A blank line came after it: only an indented line, for an item, may still join it. */
  broken: boolean;
  /** For a quote: whether a lazy line may carry it on, once read; null until then. */
  takesLazy: boolean | null;
  /** An item carried on after a fence inside it: drawn only if it says more. */
  continued: boolean;
  /** For a quote: which of its lines came lazily, without a `>`. */
  lazy: Set<number>;
}

/** A fence opened inside a list item: its opening run, and the item's depth and text indent. */
interface ItemFence {
  opener: string;
  depth: number;
  indent: number;
}

/** Cuts an answer into its blocks, in order. */
export function answerBlocks(answer: string): RawAnswerBlock[] {
  return readBlocks(answer, new Set());
}

/** Cuts an answer into its blocks; the `lazy` lines may only carry a paragraph on. */
function readBlocks(answer: string, lazy: ReadonlySet<number>): RawAnswerBlock[] {
  return readLines(answer.replace(/\r\n?/g, '\n').split('\n'), lazy).finish();
}

/** A reader that has read these lines, with what it last read still open. */
function readLines(lines: readonly string[], lazy: ReadonlySet<number>): BlockReader {
  const reader = new BlockReader(lazy);
  for (let at = 0; at < lines.length; at += 1) at = reader.line(lines, at);
  return reader;
}

class BlockReader {
  private readonly blocks: RawAnswerBlock[] = [];
  private open: Open | null = null;
  /** The indent of each list level still open, outermost first. */
  private levels: number[] = [];

  constructor(private readonly lazy: ReadonlySet<number>) {}

  /** Reads the line at `at`; returns the last line it took (a fence takes several). */
  line(lines: readonly string[], at: number): number {
    const line = lines[at] as string;
    if (line.trim() === '') return this.blank(at);
    // A lazy line is the text of the paragraph it carries on, whatever it looks like (CommonMark).
    if (this.lazy.has(at)) return this.text(line, at);
    const inItem = this.itemFenceAt(line);
    if (inItem !== null) return this.itemFence(lines, at, inItem);
    const fence = openingFence(line);
    if (fence !== null) return this.fence(lines, at, fence);
    if (HEADING.test(line)) return this.alone('heading', headingText(line), at);
    if (this.open?.kind === 'paragraph' && SETEXT.test(line)) return this.setext(at);
    if (RULE.test(line)) return this.alone('rule', line.trim(), at);
    const item = ITEM.exec(line);
    if (item !== null && this.mayStartItem(item)) return this.item(item, at);
    const quote = QUOTE.exec(line);
    if (quote !== null) return this.quote(quote[1] as string, at);
    if (TABLE.test(line)) return this.table(line, at);
    return this.text(line, at);
  }

  /**
   * Whether a lazy line may carry on what was read last: only a paragraph's
   * text, in an item or a quote or not — never a rule, a heading, or a fence.
   */
  takesLazyLine(): boolean {
    const open = this.open;
    if (open?.kind === 'paragraph') return true;
    if (open?.kind === 'item') return !open.broken && (open.lines.at(-1) ?? '').trim() !== '';
    if (open?.kind === 'quote') return quoteTakesLazy(open);
    return false;
  }

  finish(): RawAnswerBlock[] {
    this.close();
    return this.blocks;
  }

  private blank(at: number): number {
    if (this.open === null) return at;
    if (this.open.kind === 'item') this.open.broken = true;
    else this.close();
    return at;
  }

  private fence(lines: readonly string[], at: number, opener: string): number {
    this.close();
    this.levels = [];
    const closer = closingFence(opener);
    let end = at + 1;
    while (end < lines.length && !closer.test(lines[end] as string)) end += 1;
    this.push({
      kind: 'code',
      text: lines.slice(at + 1, end).join('\n'),
      marker: null,
      depth: 0,
      quoted: false,
    });
    // An unclosed fence runs to the end of the answer.
    return Math.min(end, lines.length - 1);
  }

  /** The paragraph above becomes a heading, as `Summary` over `=======` is one. */
  private setext(at: number): number {
    const open = this.open as Open;
    this.open = null;
    this.levels = [];
    this.push({
      kind: 'heading',
      text: open.lines.join(' '),
      marker: null,
      depth: 0,
      quoted: false,
    });
    return at;
  }

  /**
   * Whether a marker starts an item here. In a paragraph only a bullet or a
   * `1.` with words after it does, as CommonMark has it: a wrapped line that
   * begins `2026.` carries the sentence on.
   */
  private mayStartItem(item: RegExpExecArray): boolean {
    if (this.open?.kind !== 'paragraph') return true;
    const marker = item[2] as string;
    const empty = (item[3] ?? '').trim() === '';
    return !empty && (!/^\d/.test(marker) || Number.parseInt(marker, 10) === 1);
  }

  /**
   * The fence a line opens inside an open item — indented to the text of the
   * innermost one it reaches, which closes the items nested in that — or null.
   */
  private itemFenceAt(line: string): ItemFence | null {
    // The list stays open after a fence that ended with its item: the lines under it may be the outer item's.
    if (this.levels.length === 0) return null;
    const depth = this.levels.findLastIndex((textAt) => textAt <= indentOf(line));
    if (depth < 0) return null;
    const indent = this.levels[depth] as number;
    const opener = openingFence(line.slice(indent));
    return opener === null ? null : { opener, depth, indent };
  }

  /**
   * A fence inside a list item: it ends at its closing run, or with the item —
   * at a line less indented than the item's text — as the editor reads it
   * (mdast). The items after it are still items, and still judged.
   */
  private itemFence(lines: readonly string[], at: number, item: ItemFence): number {
    this.close();
    this.levels = this.levels.slice(0, item.depth + 1);
    const closer = closingFence(item.opener);
    let end = at + 1;
    let closed = false;
    for (; end < lines.length; end += 1) {
      const line = lines[end] as string;
      if (line.trim() !== '' && indentOf(line) < item.indent) break;
      if (closer.test(line.slice(Math.min(item.indent, indentOf(line))))) {
        closed = true;
        break;
      }
    }
    const code = lines
      .slice(at + 1, end)
      .map((line) => line.slice(Math.min(item.indent, indentOf(line))));
    this.push({
      kind: 'code',
      text: code.join('\n'),
      marker: null,
      depth: item.depth,
      quoted: false,
    });
    if (!closed) return end - 1;
    // Closed inside the item: what follows, indented to its text, still says the item's piece.
    this.open = {
      ...opened('item', null),
      depth: item.depth,
      indent: item.indent,
      continued: true,
    };
    return end;
  }

  private alone(kind: 'heading' | 'rule', text: string, at: number): number {
    this.close();
    this.levels = [];
    this.push({ kind, text, marker: null, depth: 0, quoted: false });
    return at;
  }

  private item(match: RegExpExecArray, at: number): number {
    this.close();
    const indent = (match[1] as string).length;
    // An item is nested in the one above while it starts at or past that item's text.
    while (this.levels.length > 0 && (this.levels.at(-1) as number) > indent) this.levels.pop();
    const depth = this.levels.length;
    const marker = match[2] as string;
    const textAt = indent + marker.length + 1;
    this.levels.push(textAt);
    this.open = { ...opened('item', match[3] ?? ''), marker, depth, indent: textAt };
    return at;
  }

  private quote(text: string, at: number): number {
    if (this.open?.kind !== 'quote') this.begin('quote');
    const open = this.open as Open;
    open.lines.push(text);
    open.takesLazy = null;
    return at;
  }

  private table(line: string, at: number): number {
    if (this.open?.kind !== 'table') this.begin('table');
    this.open?.lines.push(line.trim());
    return at;
  }

  private text(line: string, at: number): number {
    const open = this.open;
    const indent = line.length - line.trimStart().length;
    if (open?.kind === 'item' && (!open.broken || indent >= open.indent)) {
      open.lines.push(open.broken ? `\n${line.trim()}` : line.trim());
      open.broken = false;
      return at;
    }
    // A lazy line carries on the paragraph or quote it follows, as CommonMark reads it —
    // a quote only where it ends in a paragraph's text.
    if (open?.kind === 'paragraph' || (open?.kind === 'quote' && quoteTakesLazy(open))) {
      if (open.kind === 'quote') open.lazy.add(open.lines.length);
      open.lines.push(line.trim());
      return at;
    }
    this.begin('paragraph');
    this.levels = [];
    this.open?.lines.push(line.trim());
    return at;
  }

  private begin(kind: Open['kind']): void {
    this.close();
    if (kind !== 'paragraph') this.levels = [];
    this.open = opened(kind, null);
  }

  private close(): void {
    const open = this.open;
    if (open === null) return;
    this.open = null;
    if (open.continued && open.lines.every((line) => line.trim() === '')) return;
    const text = open.lines.join('\n');
    if (open.kind === 'quote') {
      this.blocks.push(...quoteBlocks(text, open.lazy));
      return;
    }
    this.push({ kind: open.kind, text, marker: open.marker, depth: open.depth, quoted: false });
  }

  private push(block: RawAnswerBlock): void {
    this.blocks.push(block);
  }
}

/**
 * A quote's blocks. Its text is read as an answer of its own: a list in it is
 * each item its own block, judged on its own as one outside a quote is; the
 * rest of the quote stays one quote, cited by a link on any of its lines.
 */
function quoteBlocks(text: string, lazy: ReadonlySet<number>): RawAnswerBlock[] {
  const inner = readBlocks(text, lazy);
  if (!inner.some((block) => block.kind === 'item')) {
    return [{ kind: 'quote', text, marker: null, depth: 0, quoted: false }];
  }
  return inner.map((block) => ({
    ...block,
    kind: block.kind === 'paragraph' || block.kind === 'table' ? 'quote' : block.kind,
    quoted: true,
  }));
}

/**
 * The fence a line opens, or null. A backtick fence's info string may hold
 * no backtick (CommonMark): "```ls``` lists…" is a code span in a paragraph.
 */
function openingFence(line: string): string | null {
  const fence = FENCE.exec(line);
  if (fence === null) return null;
  const opener = fence[1] as string;
  if (opener.startsWith('`') && (fence[2] ?? '').includes('`')) return null;
  return opener;
}

/** A heading without its `#` marks, before and closing. */
function headingText(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s*/, '')
    .replace(/\s+#+$/, '');
}

function opened(kind: Open['kind'], first: string | null): Open {
  return {
    kind,
    lines: first === null ? [] : [first],
    marker: null,
    depth: 0,
    indent: 0,
    broken: false,
    takesLazy: null,
    continued: false,
    lazy: new Set(),
  };
}

/**
 * Whether a lazy line may carry on an open quote: read as an answer of its
 * own, the quote ends in a paragraph's text. Kept once read, as a lazy line
 * that joins it leaves that text open.
 */
function quoteTakesLazy(open: Open): boolean {
  open.takesLazy ??= readLines(open.lines, open.lazy).takesLazyLine();
  return open.takesLazy;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** The line that closes a fence opened by `opener`: the same mark, at least as long. */
function closingFence(opener: string): RegExp {
  return new RegExp(`^ {0,3}${opener[0] === '`' ? '`' : '~'}{${opener.length},}\\s*$`);
}
