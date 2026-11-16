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
  /** For a quote: its text read as an answer of its own, line by line as it comes. */
  inner: BlockReader | null;
  /** An item carried on after a fence inside it: drawn only if it says more. */
  continued: boolean;
}

/** A fence opened inside a list item: its opening run, and the item's depth and text indent. */
interface ItemFence {
  opener: string;
  depth: number;
  indent: number;
}

/** A fence being read: its code so far, and the item it is in, if any. */
interface OpenFence {
  closer: RegExp;
  code: string[];
  item: ItemFence | null;
}

/**
 * The work a read does, in steps: every line any reader visits, a quote's once
 * for each quote it is in, and every reader asked whether it takes a lazy line.
 */
export interface ReadWork {
  steps: number;
}

/** Cuts an answer into its blocks, in order. */
export function answerBlocks(answer: string): RawAnswerBlock[] {
  return readAnswer(answer, { steps: 0 });
}

/** Cuts an answer into its blocks, counting the work it does in `work`. Exported for tests. */
export function readAnswer(answer: string, work: ReadWork): RawAnswerBlock[] {
  const reader = new BlockReader(work);
  for (const line of answer.replace(/\r\n?/g, '\n').split('\n')) reader.line(line);
  return reader.finish();
}

/**
 * Reads an answer a line at a time, never ahead, so a quote's reader can be
 * fed its lines as they come and asked at any point what it has open.
 */
class BlockReader {
  private readonly blocks: RawAnswerBlock[] = [];
  private open: Open | null = null;
  private fenced: OpenFence | null = null;
  /** The indent of each list level still open, outermost first. */
  private levels: number[] = [];

  constructor(private readonly work: ReadWork) {}

  line(line: string): void {
    this.work.steps += 1;
    if (this.fenced !== null && this.fenceTakes(line)) return;
    if (line.trim() === '') return this.blank();
    const inItem = this.itemFenceAt(line);
    if (inItem !== null) return this.openFence(inItem.opener, inItem);
    const fence = openingFence(line);
    if (fence !== null) return this.openFence(fence, null);
    if (HEADING.test(line)) return this.alone('heading', headingText(line));
    if (this.open?.kind === 'paragraph' && SETEXT.test(line)) return this.setext();
    if (RULE.test(line)) return this.alone('rule', line.trim());
    const item = ITEM.exec(line);
    if (item !== null && this.mayStartItem(item)) return this.item(item);
    const quote = QUOTE.exec(line);
    if (quote !== null) return this.quote(quote[1] as string);
    if (TABLE.test(line)) return this.table(line);
    this.text(line);
  }

  /** A lazy line is the text of the paragraph it carries on, whatever it looks like (CommonMark). */
  lazyLine(line: string): void {
    this.work.steps += 1;
    this.text(line);
  }

  /**
   * Whether a lazy line may carry on what was read last: only a paragraph's
   * text, in an item or a quote or not — never a rule, a heading, or a fence.
   */
  takesLazyLine(): boolean {
    this.work.steps += 1;
    const open = this.open;
    if (this.fenced !== null) return false;
    if (open?.kind === 'paragraph') return true;
    if (open?.kind === 'item') return !open.broken && (open.lines.at(-1) ?? '').trim() !== '';
    if (open?.kind === 'quote') return (open.inner as BlockReader).takesLazyLine();
    return false;
  }

  finish(): RawAnswerBlock[] {
    // An unclosed fence runs to the end of the answer.
    if (this.fenced !== null) this.endFence(false);
    this.close();
    return this.blocks;
  }

  private blank(): void {
    if (this.open === null) return;
    if (this.open.kind === 'item') this.open.broken = true;
    else this.close();
  }

  /**
   * A fence: at the top it ends at its closing run; inside a list item it ends
   * there too, or with the item — at a line less indented than the item's
   * text — as the editor reads it (mdast). The items after it are still items.
   */
  private openFence(opener: string, item: ItemFence | null): void {
    this.close();
    this.levels = item === null ? [] : this.levels.slice(0, item.depth + 1);
    this.fenced = { closer: closingFence(opener), code: [], item };
  }

  /** Whether the open fence takes this line: false when the line ends it with its item. */
  private fenceTakes(line: string): boolean {
    const fence = this.fenced as OpenFence;
    const cut = fence.item === null ? 0 : Math.min(fence.item.indent, indentOf(line));
    if (fence.item !== null && line.trim() !== '' && indentOf(line) < fence.item.indent) {
      this.endFence(false);
      return false;
    }
    if (fence.closer.test(line.slice(cut))) this.endFence(true);
    else fence.code.push(line.slice(cut));
    return true;
  }

  private endFence(closed: boolean): void {
    const { code, item } = this.fenced as OpenFence;
    this.fenced = null;
    this.push({
      kind: 'code',
      text: code.join('\n'),
      marker: null,
      depth: item?.depth ?? 0,
      quoted: false,
    });
    if (!closed || item === null) return;
    // Closed inside the item: what follows, indented to its text, still says the item's piece.
    this.open = {
      ...opened('item', null),
      depth: item.depth,
      indent: item.indent,
      continued: true,
    };
  }

  /** The paragraph above becomes a heading, as `Summary` over `=======` is one. */
  private setext(): void {
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

  private alone(kind: 'heading' | 'rule', text: string): void {
    this.close();
    this.levels = [];
    this.push({ kind, text, marker: null, depth: 0, quoted: false });
  }

  private item(match: RegExpExecArray): void {
    this.close();
    const indent = (match[1] as string).length;
    // An item is nested in the one above while it starts at or past that item's text.
    while (this.levels.length > 0 && (this.levels.at(-1) as number) > indent) this.levels.pop();
    const depth = this.levels.length;
    const marker = match[2] as string;
    const textAt = indent + marker.length + 1;
    this.levels.push(textAt);
    this.open = { ...opened('item', match[3] ?? ''), marker, depth, indent: textAt };
  }

  private quote(text: string): void {
    if (this.open?.kind !== 'quote') this.begin('quote');
    const open = this.open as Open;
    open.inner ??= new BlockReader(this.work);
    open.lines.push(text);
    open.inner.line(text);
  }

  private table(line: string): void {
    if (this.open?.kind !== 'table') this.begin('table');
    this.open?.lines.push(line.trim());
  }

  private text(line: string): void {
    const open = this.open;
    const indent = line.length - line.trimStart().length;
    if (open?.kind === 'item' && (!open.broken || indent >= open.indent)) {
      open.lines.push(open.broken ? `\n${line.trim()}` : line.trim());
      open.broken = false;
      return;
    }
    // A lazy line carries on the paragraph or quote it follows, as CommonMark reads it —
    // a quote only where it ends in a paragraph's text.
    if (open?.kind === 'paragraph') {
      open.lines.push(line.trim());
      return;
    }
    if (open?.kind === 'quote' && (open.inner as BlockReader).takesLazyLine()) {
      open.lines.push(line.trim());
      (open.inner as BlockReader).lazyLine(line.trim());
      return;
    }
    this.begin('paragraph');
    this.levels = [];
    this.open?.lines.push(line.trim());
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
      this.blocks.push(...quoteBlocks(text, (open.inner as BlockReader).finish()));
      return;
    }
    this.push({ kind: open.kind, text, marker: open.marker, depth: open.depth, quoted: false });
  }

  private push(block: RawAnswerBlock): void {
    this.blocks.push(block);
  }
}

/**
 * A quote's blocks, from its text read as an answer of its own: a list in it is
 * each item its own block, judged on its own as one outside a quote is; the
 * rest of the quote stays one quote, cited by a link on any of its lines.
 */
function quoteBlocks(text: string, inner: readonly RawAnswerBlock[]): RawAnswerBlock[] {
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
    inner: null,
    continued: false,
  };
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** The line that closes a fence opened by `opener`: the same mark, at least as long. */
function closingFence(opener: string): RegExp {
  return new RegExp(`^ {0,3}${opener[0] === '`' ? '`' : '~'}{${opener.length},}\\s*$`);
}
