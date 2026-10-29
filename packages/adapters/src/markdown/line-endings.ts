/**
 * Line endings put back on text that was edited with them taken out.
 *
 * The frontmatter writer edits a block with every `\r\n` made `\n`, so a
 * block whose lines end in a mix of the two — a file edited on two machines —
 * would come back all one way. These restore each line's own ending:
 *
 * - a line the edit left as it was, or only moved, keeps the ending it had;
 * - a changed line takes the ending of the line it replaced: the one of the
 *   same key, else the one in its place when as many lines went as came;
 * - any other line takes the ending most of the block's lines had.
 *
 * Every byte belongs to a line: a lone `\r` is part of a line's text, and
 * only a final `\r\n` or `\n` is its ending, so nothing is ever dropped.
 */

/** A line's text without its ending, and the ending. */
interface Line {
  readonly text: string;
  readonly ending: string;
}

/** The original's lines: each ends at a `\n`, with the `\r` before it, if any, part of the ending. */
function originalLines(text: string): Line[] {
  const pieces = text.split('\n');
  const last = pieces.pop() ?? '';
  const lines = pieces.map((piece) =>
    piece.endsWith('\r')
      ? { text: piece.slice(0, -1), ending: '\r\n' }
      : { text: piece, ending: '\n' },
  );
  return last === '' ? lines : [...lines, { text: last, ending: '' }];
}

/** The edited text's lines: written with `\n` alone, so any `\r` is the line's own. */
function editedLines(text: string): Line[] {
  const pieces = text.split('\n');
  const last = pieces.pop() ?? '';
  const lines = pieces.map((piece) => ({ text: piece, ending: '\n' }));
  return last === '' ? lines : [...lines, { text: last, ending: '' }];
}

/** The ending most of `lines` have, `fallback` when there are none or as many of each. */
export function dominantEnding(lines: readonly { readonly ending: string }[], fallback: string) {
  const crlf = lines.filter(({ ending }) => ending === '\r\n').length;
  const lf = lines.filter(({ ending }) => ending === '\n').length;
  if (crlf === lf) return fallback;
  return crlf > lf ? '\r\n' : '\n';
}

/** The most cells the matching table may have: past it, the middle is left unmatched. */
const MAX_CELLS = 1_000_000;

/** Longest common subsequence of two short runs, as pairs of their indexes. */
function commonLines(before: readonly string[], after: readonly string[]): [number, number][] {
  const width = after.length + 1;
  const table = new Int32Array((before.length + 1) * width);
  const at = (i: number, j: number) => table[i * width + j] ?? 0;
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        before[i] === after[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (at(i + 1, j) >= at(i, j + 1)) i += 1;
    else j += 1;
  }
  return pairs;
}

/**
 * For each of `after`'s lines, the index of the `before` line it is unchanged
 * from, or -1; and how many cells the table between the common head and tail
 * needed, which is what the matching costs. The usual edit changes one key,
 * so that table is a cell or two.
 */
export function matchLines(
  before: readonly string[],
  after: readonly string[],
): { matched: number[]; cells: number } {
  const matched = new Array<number>(after.length).fill(-1);
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) {
    matched[head] = head;
    head += 1;
  }
  let tail = 0;
  const room = Math.min(before.length, after.length) - head;
  while (tail < room && before[before.length - 1 - tail] === after[after.length - 1 - tail]) {
    matched[after.length - 1 - tail] = before.length - 1 - tail;
    tail += 1;
  }
  const middleBefore = before.slice(head, before.length - tail);
  const middleAfter = after.slice(head, after.length - tail);
  const cells = middleBefore.length * middleAfter.length;
  if (cells > MAX_CELLS) return { matched, cells: 0 };
  for (const [i, j] of commonLines(middleBefore, middleAfter)) matched[head + j] = head + i;
  return { matched, cells };
}

/** A top-level key a line starts, `key: …`, or null for a list item, comment or blank. */
function keyOf(text: string): string | null {
  return /^([^\s#\-:][^:]*):(?:\s|$)/.exec(text)?.[1] ?? null;
}

/** The original lines no edited line was matched to, found by their text and their key. */
class Leftovers {
  private readonly free: boolean[];
  private readonly byText = new Map<string, number[]>();

  constructor(
    private readonly before: readonly Line[],
    matched: readonly number[],
  ) {
    this.free = before.map(() => true);
    for (const at of matched) if (at !== -1) this.free[at] = false;
    before.forEach(({ text }, at) => {
      if (this.free[at] === true) this.byText.set(text, [...(this.byText.get(text) ?? []), at]);
    });
  }

  /** Takes a free line by index, answering its ending, or null when it is taken. */
  take(at: number): string | null {
    if (this.free[at] !== true) return null;
    this.free[at] = false;
    return this.before[at]?.ending ?? null;
  }

  /** A free line of exactly this text anywhere: a line the writer moved. */
  moved(text: string): string | null {
    for (const at of this.byText.get(text) ?? []) {
      const ending = this.take(at);
      if (ending !== null) return ending;
    }
    return null;
  }

  /** A free line of the same key between `from` and `to`: the one a changed key replaced. */
  sameKey(text: string, from: number, to: number): string | null {
    const key = keyOf(text);
    if (key === null) return null;
    for (let at = from; at < to; at += 1) {
      if (this.free[at] === true && keyOf(this.before[at]?.text ?? '') === key)
        return this.take(at);
    }
    return null;
  }
}

/** Each edited line's ending, run by run of unmatched lines. */
function endingsFor(before: readonly Line[], after: readonly Line[], dominant: string): string[] {
  const { matched } = matchLines(
    before.map(({ text }) => text),
    after.map(({ text }) => text),
  );
  const left = new Leftovers(before, matched);
  const endings: (string | null)[] = matched.map((from) =>
    from === -1 ? null : (before[from]?.ending ?? dominant),
  );
  let start = 0;
  while (start < after.length) {
    if (matched[start] !== -1) {
      start += 1;
      continue;
    }
    let end = start;
    while (end < after.length && matched[end] === -1) end += 1;
    // The original lines between the matched ones around this run.
    const gapFrom = start === 0 ? 0 : (matched[start - 1] ?? -1) + 1;
    const gapTo = end === after.length ? before.length : (matched[end] ?? before.length);
    const sameSize = gapTo - gapFrom === end - start;
    for (let at = start; at < end; at += 1) {
      const text = after[at]?.text ?? '';
      endings[at] =
        left.moved(text) ??
        left.sameKey(text, gapFrom, gapTo) ??
        (sameSize ? left.take(gapFrom + at - start) : null) ??
        dominant;
    }
    start = end;
  }
  return endings.map((ending) => ending ?? dominant);
}

/**
 * `edited`, written with `\n` alone, given back the endings `original` had
 * line by line. `fallback` is the ending for new lines when `original` has
 * as many of each, or none. Text whose lines all ended one way comes back
 * all that way, as before.
 */
export function withOriginalEndings({
  original,
  edited,
  fallback,
}: {
  original: string;
  edited: string;
  fallback: string;
}): string {
  // Lines all ending one way, as nearly every file's do, need no matching.
  const crlf = original.includes('\r\n');
  const lf = /(?<!\r)\n/.test(original);
  if (!crlf && !lf) return fallback === '\n' ? edited : edited.replace(/\n/g, fallback);
  if (crlf !== lf) return crlf ? edited.replace(/\n/g, '\r\n') : edited;
  const before = originalLines(original);
  const after = editedLines(edited);
  const endings = endingsFor(before, after, dominantEnding(before, fallback));
  // A last line written without an ending keeps none.
  return after.map(({ text, ending }, at) => text + (ending === '' ? '' : endings[at])).join('');
}
