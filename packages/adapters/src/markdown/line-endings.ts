/**
 * Line endings put back on text that was edited with them taken out.
 *
 * The frontmatter writer edits a block with every `\r\n` made `\n`, so a
 * block whose lines end in a mix of the two — a file edited on two machines —
 * would come back all one way. These restore each line's own ending: a line
 * the edit left as it was keeps the ending it had; a changed line takes the
 * ending of the line it replaced; a line that is new takes the ending most of
 * the block's lines had.
 */

/** A line's text without its ending, and the ending. */
interface Line {
  readonly text: string;
  readonly ending: string;
}

/** Text as lines, each with its ending; a last line without one has ''. */
function linesOf(text: string): Line[] {
  const found: Line[] = [];
  const pattern = /([^\r\n]*)(\r\n|\n|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match[0] === '') break;
    found.push({ text: match[1] ?? '', ending: match[2] ?? '' });
  }
  return found;
}

/** The ending most of `lines` have, `fallback` when there are none or as many of each. */
export function dominantEnding(lines: readonly { readonly ending: string }[], fallback: string) {
  const crlf = lines.filter(({ ending }) => ending === '\r\n').length;
  const lf = lines.filter(({ ending }) => ending === '\n').length;
  if (crlf === lf) return fallback;
  return crlf > lf ? '\r\n' : '\n';
}

/** For each of `after`'s lines, the index of the `before` line it is unchanged from, or -1. */
function unchangedFrom(before: readonly string[], after: readonly string[]): number[] {
  // Longest common subsequence, in one flat table: a block is a few hundred lines at most.
  const width = after.length + 1;
  const table = new Int32Array((before.length + 1) * width);
  const at = (i: number, j: number) => table[i * width + j] ?? 0;
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        before[i] === after[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const matched = new Array<number>(after.length).fill(-1);
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      matched[j] = i;
      i += 1;
      j += 1;
    } else if (at(i + 1, j) >= at(i, j + 1)) i += 1;
    else j += 1;
  }
  return matched;
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
  const before = linesOf(original);
  const after = linesOf(edited);
  const dominant = dominantEnding(before, fallback);
  const matched = unchangedFrom(
    before.map(({ text }) => text),
    after.map(({ text }) => text),
  );
  let nextBefore = 0;
  return after
    .map((line, at) => {
      const from = matched[at] ?? -1;
      const endsHere = line.ending === '' ? '' : null;
      if (from !== -1) {
        nextBefore = from + 1;
        return line.text + (endsHere ?? before[from]?.ending ?? dominant);
      }
      // A changed line stands where an unmatched line of the original did.
      const replaced = before[nextBefore];
      const isReplaced = replaced !== undefined && !matched.includes(nextBefore);
      if (isReplaced) nextBefore += 1;
      const ending = isReplaced && replaced.ending !== '' ? replaced.ending : dominant;
      return line.text + (endsHere ?? ending);
    })
    .join('');
}
