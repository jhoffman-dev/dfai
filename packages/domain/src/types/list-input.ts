/*
 * A list as one line of text, for a box the person edits: commas between the
 * items, as a list is typed everywhere in DFAI. An item can hold a comma of
 * its own — `[[Larkspur Payroll, Inc.]]`, `Quill, Mara` — so one that does is
 * written in double quotes, a quote inside it doubled, as a CSV cell is.
 * Reading the line back gives the same list, so editing one item never cuts
 * another in two. A proposal's list properties and a term's variants are both
 * edited this way.
 */

const QUOTE = '"';

/** The items as the box shows them: commas between, an item holding a comma or a quote quoted. */
export function listAsInput(items: readonly string[]): string {
  return items.map(quotedWhereNeeded).join(', ');
}

function quotedWhereNeeded(item: string): string {
  if (!item.includes(',') && !item.includes(QUOTE)) return item;
  return `${QUOTE}${item.replaceAll(QUOTE, QUOTE + QUOTE)}${QUOTE}`;
}

/**
 * The items typed into one box: split at the commas outside quotes, trimmed,
 * blanks dropped. A quote never closed runs to the end of the line.
 */
export function listFromInput(typed: string): string[] {
  return listInputCells(typed)
    .map((cell) => cell.trim())
    .filter((cell) => cell !== '');
}

/**
 * Whether the line has a quote opened around text and not closed yet — the
 * moment while `"Quill, Mara` is being typed, or a closing quote has just been
 * deleted. Read then, the open cell runs to the end of the line and takes in
 * every item after it, so a box written as it is typed holds its save until
 * the quote closes. A lone quote with nothing after it yet opens nothing: the
 * line still says the items before it.
 */
export function hasOpenQuote(typed: string): boolean {
  let at = 0;
  while (at <= typed.length) {
    const { cell, next, open } = readCell(typed, at);
    if (open && cell.trim() !== '') return true;
    at = next + 1;
  }
  return false;
}

/**
 * The cells of the line as typed, quotes taken off and nothing else done to
 * them — for a reader with its own idea of a blank or a repeat. A cell is
 * quoted when its first non-space character is a quote.
 */
export function listInputCells(typed: string): string[] {
  const cells: string[] = [];
  let at = 0;
  while (at <= typed.length) {
    const { cell, next } = readCell(typed, at);
    cells.push(cell);
    at = next + 1;
  }
  return cells;
}

/**
 * One cell from `from`, where the comma ending it is (the line's length when
 * none is), and whether it is a quoted cell the line ends inside.
 */
function readCell(typed: string, from: number): { cell: string; next: number; open: boolean } {
  const start = from + (/^\s*/u.exec(typed.slice(from))?.[0].length ?? 0);
  if (typed[start] !== QUOTE) {
    const comma = typed.indexOf(',', from);
    const next = comma === -1 ? typed.length : comma;
    return { cell: typed.slice(from, next), next, open: false };
  }
  let cell = '';
  let at = start + 1;
  while (at < typed.length) {
    if (typed[at] === QUOTE && typed[at + 1] === QUOTE) {
      cell += QUOTE;
      at += 2;
    } else if (typed[at] === QUOTE) {
      // What follows the closing quote, up to the comma, is kept as typed.
      const comma = typed.indexOf(',', at + 1);
      const next = comma === -1 ? typed.length : comma;
      return { cell: cell + typed.slice(at + 1, next), next, open: false };
    } else {
      cell += typed[at];
      at += 1;
    }
  }
  return { cell, next: typed.length, open: true };
}
