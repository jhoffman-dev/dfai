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
/** A table's second row, under its header: without one, a `|` row is a paragraph (GFM). */
const DELIMITER_ROW = /^\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?$/;
/**
 * How deep quotes nest before a `>` is read as text, as markdown-it's
 * `maxNesting` does: a reader per level would otherwise overflow the stack.
 * Text past it is still a quote's, and still judged.
 */
const MAX_QUOTE_NESTING = 100;

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
  private linesRead = 0;

  /**
   * `nesting` is how many quotes this reader is in; `opensUnderParagraph`, that
   * its quote broke into a paragraph, which the editor holds its first line
   * to: it starts no item a paragraph would not let start.
   */
  constructor(
    private readonly work: ReadWork,
    private readonly nesting = 0,
    private readonly opensUnderParagraph = false,
  ) {}

  line(line: string): void {
    this.work.steps += 1;
    this.linesRead += 1;
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
    const quote = this.nesting < MAX_QUOTE_NESTING ? QUOTE.exec(line) : null;
    if (quote !== null) return this.quote(quote[1] as string);
    if (TABLE.test(line)) return this.table(line);
    this.text(line);
  }

  /**
   * A lazy line is the text of the paragraph it carries on, whatever it looks
   * like (CommonMark). Asked once, at the top, whether it is one: it goes
   * straight down to the innermost quote, which takes it.
   */
  lazyLine(line: string): void {
    this.work.steps += 1;
    const inner = this.open?.inner ?? null;
    if (inner === null) return this.text(line);
    this.open?.lines.push(line);
    inner.lazyLine(line);
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
    if (open?.kind === 'item') return itemTakesLazy(open);
    if (open?.kind === 'table') return !isTable(open.lines);
    return open?.inner?.takesLazyLine() ?? false;
  }

  finish(): RawAnswerBlock[] {
    // An unclosed fence runs to the end of the answer.
    if (this.fenced !== null) this.endFence();
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
    const indent = indentOf(line);
    if (fence.item !== null && line.trim() !== '' && indent < fence.item.indent) {
      this.endFence();
      return false;
    }
    const cut = fence.item === null ? 0 : Math.min(fence.item.indent, indent);
    if (fence.closer.test(line.slice(cut))) this.closeFence();
    else fence.code.push(line.slice(cut));
    return true;
  }

  /** The fence ends at its closing run: in an item, what follows may still say the item's piece. */
  private closeFence(): void {
    const item = this.endFence();
    if (item === null) return;
    this.open = {
      ...opened('item', null),
      depth: item.depth,
      indent: item.indent,
      continued: true,
    };
  }

  /** Draws the open fence's code; returns the item it was in, if any. */
  private endFence(): ItemFence | null {
    const { code, item } = this.fenced as OpenFence;
    this.fenced = null;
    this.blocks.push({
      kind: 'code',
      text: code.join('\n'),
      marker: null,
      depth: item?.depth ?? 0,
      quoted: false,
    });
    return item;
  }

  /** The paragraph above becomes a heading, as `Summary` over `=======` is one. */
  private setext(): void {
    const open = this.open as Open;
    this.open = null;
    this.levels = [];
    this.blocks.push({
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
    const underParagraph = this.opensUnderParagraph && this.linesRead === 1;
    if (this.open?.kind !== 'paragraph' && !underParagraph) return true;
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
    this.blocks.push({ kind, text, marker: null, depth: 0, quoted: false });
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
    if (this.open?.kind !== 'quote') {
      const underParagraph =
        this.open?.kind === 'paragraph' || (this.opensUnderParagraph && this.linesRead === 1);
      this.begin('quote');
      (this.open as Open).inner = new BlockReader(this.work, this.nesting + 1, underParagraph);
    }
    const open = this.open as Open;
    open.lines.push(text);
    open.inner?.line(text);
  }

  private table(line: string): void {
    if (this.open?.kind !== 'table') this.begin('table');
    this.open?.lines.push(line.trim());
  }

  private text(line: string): void {
    const open = this.open;
    const indent = line.length - line.trimStart().length;
    // An empty item, or one a blank line broke, takes only a line indented to its text.
    if (open?.kind === 'item' && (itemTakesLazy(open) || indent >= open.indent)) {
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
    if (open?.inner?.takesLazyLine() === true) return this.lazyLine(line.trim());
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
    if (open.inner !== null) {
      this.blocks.push(...quoteBlocks(text, open.inner.finish()));
      return;
    }
    this.blocks.push({
      kind: open.kind,
      text,
      marker: open.marker,
      depth: open.depth,
      quoted: false,
    });
  }
}

/**
 * A quote's blocks, from its text read as an answer of its own. A quote of
 * prose stays one quote, cited by a link on any of its lines. A list in it is
 * each item its own block, judged on its own as one outside a quote is; code,
 * a heading or a rule in it is drawn as one, and exempt as one.
 */
function quoteBlocks(text: string, inner: readonly RawAnswerBlock[]): RawAnswerBlock[] {
  if (inner.every((block) => ['paragraph', 'table', 'quote'].includes(block.kind))) {
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

/** Whether an item's text runs on to the next line: it has text, and no blank line came after it. */
function itemTakesLazy(item: Open): boolean {
  return !item.broken && (item.lines.at(-1) ?? '').trim() !== '';
}

/** Whether a table's rows so far are one: a header with a delimiter row under it. */
function isTable(rows: readonly string[]): boolean {
  return rows.length >= 2 && DELIMITER_ROW.test(rows[1] as string);
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** The line that closes a fence opened by `opener`: the same mark, at least as long. */
function closingFence(opener: string): RegExp {
  return new RegExp(`^ {0,3}${opener[0] === '`' ? '`' : '~'}{${opener.length},}\\s*$`);
}
