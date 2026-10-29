/*
 * Slack's emphasis marks paired in one pass (review of PR #615): a regular
 * expression that looked for each mark's closer read on to the end of the
 * line for every unclosed mark, so a 40,000-character message of them held
 * the app for half a second, and a long thread for seconds.
 */

export type EmphasisMark = '*' | '_' | '~';

const MARKS: ReadonlySet<string> = new Set(['*', '_', '~']);
const WORD = /^[\p{L}\p{N}]$/u;
const SPACE = /^\s$/u;

/** Which marks in a line open emphasis and where each closes, and how much work finding them took. */
export interface EmphasisPairs {
  /** By the opening mark's place in the line's characters (code points), the closing mark's. */
  readonly closes: ReadonlyMap<number, number>;
  /** Characters looked at and marks set aside: a test holds it to the line's length. */
  readonly steps: number;
}

/**
 * Slack's rule for one line: a mark opens at a word's start (nothing, or
 * neither a letter nor a digit, before it; neither a space nor the same mark
 * after it) and closes at a word's end (no space before it; no letter or
 * digit after it). A closer pairs with the latest open mark like it; marks
 * of other kinds opened after that one stay as written. Each mark is set
 * aside at most once, so the work is linear in the line.
 */
export function pairEmphasis(characters: readonly string[]): EmphasisPairs {
  const open: Record<EmphasisMark, number[]> = { '*': [], _: [], '~': [] };
  const closes = new Map<number, number>();
  let steps = 0;
  for (const [at, character] of characters.entries()) {
    steps += 1;
    if (!MARKS.has(character)) continue;
    const mark = character as EmphasisMark;
    const before = characters[at - 1];
    const after = characters[at + 1];
    const opener = open[mark].at(-1);
    if (opener !== undefined && closesHere(before, after)) {
      open[mark].pop();
      closes.set(opener, at);
      steps += dropOpenedAfter(open, opener);
    } else if (opensHere(before, after, mark)) {
      open[mark].push(at);
    }
  }
  return { closes, steps };
}

function opensHere(before: string | undefined, after: string | undefined, mark: string): boolean {
  const atWordStart = before === undefined || !WORD.test(before);
  return atWordStart && after !== undefined && !SPACE.test(after) && after !== mark;
}

function closesHere(before: string | undefined, after: string | undefined): boolean {
  return before !== undefined && !SPACE.test(before) && (after === undefined || !WORD.test(after));
}

/** Sets aside the open marks of every kind opened after `opener`; answers how many. */
function dropOpenedAfter(open: Record<EmphasisMark, number[]>, opener: number): number {
  let dropped = 0;
  for (const stack of Object.values(open)) {
    while ((stack.at(-1) ?? -1) > opener) {
      stack.pop();
      dropped += 1;
    }
  }
  return dropped;
}
