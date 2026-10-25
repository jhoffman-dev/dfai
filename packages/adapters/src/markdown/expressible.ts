import {
  BLOCK_ANCHOR_ATTR,
  TABLE_CELL_TYPES,
  nestedBlockOf,
  withAnchorsAtPlaces,
  type EditorMark,
  type EditorNode,
} from '@dfai/domain';

/**
 * A block as markdown can hold it, which is how the writer writes it and what
 * it checks each writing against (A21-03). The editor holds two things a line
 * of markdown cannot:
 *
 * - **Spaces and tabs at either end of a line**, and a line break that ends
 *   the block. Markdown drops them when it reads, so remark writes them as
 *   `&#x20;` — "# Title " reached the file as "# Title&#x20;". They are
 *   dropped here instead. Inline code keeps its spaces: they are its content,
 *   and so do words a block id follows, which end no line (A26-01).
 *   A line break in a heading or a cell is written `<br>`, which ends no line,
 *   so the spaces beside it are kept there.
 * - **Bold, italic or strike on whitespace at the edge of its run.** `**See **`
 *   is not bold in markdown, so remark wrote `**See&#x20;**`. The space is
 *   moved outside the run: `**See** [[Name]]`, which looks the same.
 *
 * And a table cell holds one line, so its paragraphs are run together, and
 * some of its code needs one more backslash (`cellCode`).
 *
 * And a block id is kept only where the file has a place for it
 * (`withAnchorsAtPlaces`, P26-01).
 *
 * Only an edited block comes through here; an untouched one keeps its bytes.
 */
export function expressible(node: EditorNode): EditorNode {
  return expressibleIn(withAnchorsAtPlaces(node));
}

/**
 * `beforeAnId`: the node's words are followed by its block id (P26-01) —
 * its own, or, for an item's first paragraph, the item's. The spaces they
 * end with are then not at the end of a line, and are kept (A26-01).
 */
function expressibleIn(node: EditorNode, beforeAnId = holdsAnId(node)): EditorNode {
  if (TABLE_CELL_TYPES.has(node.type)) {
    const blocks = node.content ?? [];
    const inline = blocks.flatMap((block) => nestedBlockOf(block).content ?? []);
    const content = expelled(htmlBreaksTrimmed(inline)).map(cellCode);
    // A block with no words to run into the line — raw HTML, a highlight, a rule — is
    // kept after it for the writer to refuse (#569): run into the line it would be
    // nothing, and the person would lose it without a word. Judged by its type, not
    // by a missing `content`: ProseMirror leaves that out of an empty node's JSON,
    // and an empty heading (`# ` typed in the cell) collapses into the line.
    const wordless = blocks.filter((block) => WORDLESS_TYPES.has(nestedBlockOf(block).type));
    return { ...node, content: [{ type: 'paragraph', content }, ...wordless] };
  }
  if (node.type === 'heading') {
    const content = expelled(htmlBreaksTrimmed(node.content ?? []));
    return { ...node, content: beforeAnId ? endingAsTyped(content, node.content) : content };
  }
  if (node.type === 'paragraph') {
    const content = expelled(lineTrimmed(node.content ?? []));
    return { ...node, content: beforeAnId ? endingAsTyped(content, node.content) : content };
  }
  if (node.content === undefined) return node;
  const item = ITEMS.has(node.type);
  const content = node.content.map((child, index) =>
    expressibleIn(child, item ? beforeAnId && index === 0 : holdsAnId(child)),
  );
  return { ...node, content: CONTAINERS.has(node.type) ? withoutEmpty(node, content) : content };
}

const holdsAnId = (node: EditorNode): boolean => {
  const id = node.attrs?.[BLOCK_ANCHOR_ATTR];
  return typeof id === 'string' && id !== '';
};

/** `trimmed` with the spaces and tabs `typed` ended with put back after it. */
function endingAsTyped(
  trimmed: readonly EditorNode[],
  typed: readonly EditorNode[] = [],
): EditorNode[] {
  const spaces = trailingSpaces(typed);
  return spaces === '' || trimmed.length === 0
    ? [...trimmed]
    : merged([...trimmed, { type: 'text', text: spaces }]);
}

/** The spaces and tabs a run of words ends with; none where the last line is only those. */
function trailingSpaces(nodes: readonly EditorNode[]): string {
  let spaces = '';
  for (let at = nodes.length - 1; at >= 0; at -= 1) {
    const node = nodes[at]!;
    if (node.type === 'hardBreak') return '';
    if (!isPlainText(node)) return spaces;
    const text = node.text ?? '';
    const run = /[ \t]*$/.exec(text)?.[0] ?? '';
    spaces = run + spaces;
    if (run.length < text.length) return spaces;
  }
  return '';
}

/**
 * A container's blocks without the paragraphs left empty, which markdown has
 * no way to write: `- [x]` then a blank line ends the item before the next
 * paragraph, and a quote's `>` line holds nothing. An item that held nothing
 * else keeps one, as its bullet alone. A task's checkbox is read only before
 * a paragraph with something in it, so a task that starts with none starts
 * with a space, which remark writes as `&#x20;` — or, when it holds an id and
 * its first paragraph is empty, with that id after its box (A26-01).
 */
function withoutEmpty(node: EditorNode, content: readonly EditorNode[]): EditorNode[] {
  const kept = content.filter((child) => !isEmptyParagraph(child));
  if (node.type === 'taskItem' && kept[0]?.type !== 'paragraph') {
    const [first] = content;
    const box = first !== undefined && isEmptyParagraph(first) && holdsAnId(node) ? first : SPACE;
    return [box, ...kept];
  }
  if (kept.length > 0) return kept;
  return content.length > 0 ? [content[0]!] : [];
}

/**
 * Code in a table cell as a cell can hold it (A21-04). A cell writes its code's
 * `|` as `\|`, and reads `\|` back as `|` but `\\` as itself, so an odd run
 * of backslashes before a `|` has no writing: `\\|` ends the cell there. One
 * more backslash makes the run one a cell can hold; nothing is lost.
 */
function cellCode(node: EditorNode): EditorNode {
  if (node.type !== 'text' || !isCode(node)) return node;
  const text = (node.text ?? '').replace(/(\\+)\|/g, (run: string, backslashes: string) =>
    backslashes.length % 2 === 1 ? `\\${run}` : run,
  );
  return { ...node, text };
}

const SPACE: EditorNode = { type: 'paragraph', content: [{ type: 'text', text: ' ' }] };

/**
 * The block types that never hold text, as a cell's line could take it: a raw
 * block (HTML, a highlight) and a rule. A card, a shown block and a query are
 * already their link or fence here (`nestedBlockOf`).
 */
const WORDLESS_TYPES: ReadonlySet<string> = new Set(['rawBlock', 'horizontalRule']);

const isEmptyParagraph = (node: EditorNode): boolean =>
  node.type === 'paragraph' && (node.content ?? []).length === 0;

const CONTAINERS: ReadonlySet<string> = new Set(['listItem', 'taskItem', 'blockquote', 'callout']);

const ITEMS: ReadonlySet<string> = new Set(['listItem', 'taskItem']);

/** Marks that markdown cannot open or close next to whitespace. */
const EDGE_MARKS = ['bold', 'italic', 'strike'] as const;

const isCode = (node: EditorNode): boolean =>
  (node.marks ?? []).some((mark) => mark.type === 'code');

const isPlainText = (node: EditorNode): boolean => node.type === 'text' && !isCode(node);

/** Whitespace off both ends of each line, and the line breaks that end the block. */
function lineTrimmed(nodes: readonly EditorNode[]): EditorNode[] {
  const out: EditorNode[] = [];
  let line: EditorNode[] = [];
  const endLine = () => {
    out.push(...trimmedLine(line));
    line = [];
  };
  for (const node of nodes) {
    if (node.type !== 'hardBreak') line.push(node);
    else {
      endLine();
      out.push(node);
    }
  }
  endLine();
  while (out.at(-1)?.type === 'hardBreak') out.pop();
  return out;
}

/**
 * Whitespace off both ends, and the line breaks that end the block, where a
 * line break is written `<br>` — in a heading or a cell (A21-04). There it
 * ends no line of markdown, so the spaces beside it are kept, as read.
 */
function htmlBreaksTrimmed(nodes: readonly EditorNode[]): EditorNode[] {
  let out = trimmedLine(nodes);
  while (out.at(-1)?.type === 'hardBreak') out = trimmedLine(out.slice(0, -1));
  return out;
}

function trimmedLine(line: readonly EditorNode[]): EditorNode[] {
  let start = 0;
  let end = line.length;
  while (start < end && isLineSpace(line[start]!)) start += 1;
  while (end > start && isLineSpace(line[end - 1]!)) end -= 1;
  const trimmed = line.slice(start, end);
  const edited = (at: number, pattern: RegExp) => {
    const node = trimmed[at];
    if (node !== undefined && isPlainText(node))
      trimmed[at] = { ...node, text: (node.text ?? '').replace(pattern, '') };
  };
  edited(0, /^[ \t]+/);
  edited(trimmed.length - 1, /[ \t]+$/);
  return trimmed;
}

/**
 * Spaces and tabs, which markdown strips from either end of a line. Any other
 * space — a no-break space, `&nbsp;` — it keeps, and so is kept.
 */
const isLineSpace = (node: EditorNode): boolean =>
  isPlainText(node) && /^[ \t]+$/.test(node.text ?? '');

/** Each text node split into its runs of whitespace and of anything else. */
const segments = (nodes: readonly EditorNode[]): EditorNode[] =>
  nodes.flatMap((node) =>
    isPlainText(node)
      ? (node.text ?? '')
          .split(/(\s+)/u)
          .filter((text) => text !== '')
          .map((text) => ({ ...node, text }))
      : [node],
  );

const isBlank = (node: EditorNode): boolean => isPlainText(node) && /^\s+$/u.test(node.text ?? '');

const hasMark = (node: EditorNode | undefined, type: string): boolean =>
  (node?.marks ?? []).some((mark) => mark.type === type);

function withoutMark(node: EditorNode, type: string): EditorNode {
  const marks = (node.marks ?? []).filter((mark) => mark.type !== type);
  return { type: node.type, text: node.text ?? '', ...(marks.length > 0 && { marks }) };
}

/** Bold, italic and strike taken off whitespace that is not inside a run of them. */
function expelled(nodes: readonly EditorNode[]): EditorNode[] {
  const out = segments(nodes);
  for (const type of EDGE_MARKS) {
    // A blank that loses its mark can leave the next one at an edge in turn.
    for (let changed = true; changed;) {
      changed = false;
      out.forEach((node, at) => {
        if (!isBlank(node) || !hasMark(node, type)) return;
        if (hasMark(out[at - 1], type) && hasMark(out[at + 1], type)) return;
        out[at] = withoutMark(node, type);
        changed = true;
      });
    }
  }
  return merged(out);
}

const marksKey = (marks: readonly EditorMark[] | undefined): string => JSON.stringify(marks ?? []);

/**
 * Adjacent text with the same marks as one node. Two pieces of inline code
 * side by side must be one: written apart, `` `a``b` `` reads as one span
 * holding the backticks between them.
 */
function merged(nodes: readonly EditorNode[]): EditorNode[] {
  const out: EditorNode[] = [];
  for (const node of nodes) {
    const previous = out.at(-1);
    const same =
      previous?.type === 'text' &&
      node.type === 'text' &&
      marksKey(previous.marks) === marksKey(node.marks);
    if (same) out[out.length - 1] = { ...previous, text: `${previous.text}${node.text}` };
    else out.push(node);
  }
  return out;
}
