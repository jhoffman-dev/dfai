/**
 * Putting the editor's caret at a line's end or start, or the note's end, and
 * waiting until the editor holds it there (#445, #448).
 *
 * The click lands at the line's start on purpose: where a click lands is not
 * to be relied on, so the key that follows must move the caret from anywhere
 * on the line. End and Home do not: in WebKit on macOS they scroll and leave
 * the caret where it was. ⌘→ and ⌘← are the Mac's end and start of line.
 *
 * And the key alone is not enough. For 20 ms after it is focused, ProseMirror
 * puts its own selection back on the page unless it has read the page's by
 * then; under load the caret the click or the key moved is put back at the
 * note's start, and the typing after it lands there. So the editor's own
 * selection is what is waited on, the page's caret must be at the same place
 * (an editor that has not read the page yet holds an old one), and the click
 * and the key are both done
 * again if it was undone: the key alone would only move the put-back caret
 * along the note's first line, never back to this one (#489). The reset runs
 * once per focus, so the second click is not undone. Pressing the key also
 * collapses the word or line a quick second or third click selects.
 *
 * ⌘→ goes to the end of the line as drawn, so on a paragraph that wraps it
 * stops short of the block's end: the check then fails loudly, never passes.
 *
 * The keys are the platform's own (platform.ts): End and Home on Linux.
 */
import { expect, type Locator } from '@playwright/test';
import { LINE_END, LINE_START, TEXT_END } from './platform.ts';

/**
 * How long one try's action may take: well under the retry's own 5 s, so a
 * line that cannot be clicked or tapped fails with the action's own message,
 * not only with the retry's time running out.
 */
const ONE_TRY = { timeout: 1_000 };

/** Click the line `line` is in, and put the caret at that line's end. */
export async function caretAtLineEnd(line: Locator): Promise<void> {
  await caretAt(line, 'end');
}

/** Click the line `line` is in, and put the caret at that line's start. */
export async function caretAtLineStart(line: Locator): Promise<void> {
  await caretAt(line, 'start');
}

/**
 * Put the caret at the end of the note `editor` shows (the editor, or what
 * holds it): click its last paragraph or heading, and ⌘↓ to the end of the
 * whole text, so a last paragraph that wraps is reached too. Held as
 * caretAtNoteEndBy holds it: the editor's caret and the page's agree, at the
 * end of the note's last block.
 */
export async function caretAtNoteEnd(editor: Locator): Promise<void> {
  const lastLine = editor.locator('p, h1, h2, h3, h4, h5, h6').last();
  await caretAtNoteEndBy(lastLine, async () => {
    await lastLine.click({ position: { x: 1, y: 5 }, ...ONE_TRY });
    await lastLine.page().keyboard.press(TEXT_END);
  });
}

async function caretAt(line: Locator, where: 'start' | 'end'): Promise<void> {
  // Always pressed, never skipped when the editor already says the caret is
  // there: until ProseMirror reads the click, its selection is the one from
  // before, and the typing goes where the click put the page's caret. ⌘← is
  // pressed from the line's end: at a line's start under a bookmark card, it
  // takes the caret up to the line above.
  const keys = where === 'end' ? [LINE_END] : [LINE_END, LINE_START];
  await caretHeldAt(line, { at: where }, async () => {
    await line.click({ position: { x: 1, y: 5 }, ...ONE_TRY });
    for (const key of keys) await line.page().keyboard.press(key);
  });
}

/**
 * How many taps a line gets when ProseMirror's reset after focus undoes one.
 * The reset runs once per focus, so the second tap is not undone.
 */
const TAPS_PAST_THE_RESET = 2;

/**
 * Taps the far right of the line `line` is in, which leaves the caret at its
 * end, and waits until the editor holds it there (#797, #821). A tap that
 * focuses the editor can be undone by the reset after focus, which puts the
 * caret back at the note's start: then, and only then, the line is tapped
 * again, with no key, so where a tap leaves the caret is what is checked every
 * time. A tap that leaves the caret anywhere else fails at once, saying where.
 */
export async function caretAtLineEndByTap(line: Locator): Promise<void> {
  const box = await line.boundingBox();
  if (box === null) throw new Error('The line is not on the page.');
  for (let tap = 1; ; tap += 1) {
    const before = JSON.stringify((await caretOf(line)).page);
    await line.tap({ position: { x: box.width - 1, y: box.height / 2 }, ...ONE_TRY });
    const landed = await caretSettledAfter(line, before);
    if (landed.inLine && landed.at === 'end') return;
    if (!landed.atNoteStart || tap === TAPS_PAST_THE_RESET) {
      throw new Error(
        `The tap did not leave the caret at its line's end. ${whereCaretsAre(landed)}`,
      );
    }
  }
}

/**
 * The caret once the editor has read where a tap left the page's: the two
 * agree, and the page's has moved from `before` unless it is already at the
 * line's end. Until then the editor may still hold its caret from before.
 */
async function caretSettledAfter(line: Locator, before: string) {
  let caret = await caretOf(line);
  await expect(async () => {
    caret = await caretOf(line);
    const held = caret.inLine && caret.at === 'end';
    const moved = JSON.stringify(caret.page) !== before;
    expect(caret.agrees && (held || moved), whereCaretsAre(caret)).toBe(true);
  }).toPass({ timeout: 5_000 });
  return caret;
}

function whereCaretsAre(caret: { editor: unknown; page: unknown }): string {
  return `the editor's caret: ${JSON.stringify(caret.editor)}; the page's: ${JSON.stringify(caret.page)}`;
}

/**
 * Puts the caret at the end of the note's last block, `lastLine`, by `move`
 * (a key to the note's end), done again until the editor holds it there: the
 * same reset after focus undoes a key as it undoes a click (#797). `move` is
 * told which try it is, from 1. Its actions should take `ONE_TRY`'s time or less.
 */
export async function caretAtNoteEndBy(
  lastLine: Locator,
  move: (attempt: number) => Promise<void>,
): Promise<void> {
  await caretHeldAt(lastLine, { at: 'end', lastBlock: true }, move);
}

async function caretHeldAt(
  line: Locator,
  wanted: { at: 'start' | 'end'; lastBlock?: true },
  move: (attempt: number) => Promise<void>,
): Promise<void> {
  let attempt = 0;
  await expect(async () => {
    attempt += 1;
    await move(attempt);
    // The editor's caret and the page's must agree: an editor still holding
    // an old caret at this line's end, before it reads where the page's caret
    // went, would pass here and then take the typing elsewhere.
    const caret = await caretOf(line);
    // The diff shows only the fields checked; where each caret is goes in the message.
    expect(caret, whereCaretsAre(caret)).toMatchObject({ inLine: true, agrees: true, ...wanted });
  }).toPass({ timeout: 5_000 });
}

/**
 * Where the editor that holds `line` has its caret: whether it is in the
 * block `line` is in, at that block's start, end, or neither, and whether
 * that block is the note's last; whether it is at the note's start, where
 * ProseMirror's reset after focus puts it; whether the page's caret is at the
 * same place; and, for a failure to show, each caret's block text and offset.
 */
function caretOf(line: Locator) {
  return line.evaluate(
    (element) => {
      // Tiptap hangs the editor on ProseMirror's element; its selection is not in the DOM.
      interface Resolved {
        depth: number;
        parentOffset: number;
        parent: { textContent: string; content: { size: number } };
        before(): number;
        index(depth: number): number;
      }
      const root = element.closest('.ProseMirror') as
        | (Element & {
            editor: {
              state: {
                doc: { childCount: number; resolve(pos: number): Resolved };
                selection: { empty: boolean; head: number; $head: Resolved };
              };
              view: {
                nodeDOM(pos: number): Node | null;
                posAtDOM(node: Node, offset: number): number;
              };
            };
          })
        | null;
      if (root === null) throw new Error('the line is not in an editor');
      const { state, view } = root.editor;
      const { selection } = state;
      const { $head } = selection;
      const where = ($pos: Resolved) => ({
        block: $pos.parent.textContent,
        offset: $pos.parentOffset,
      });
      const editor = { ...where($head), empty: selection.empty };

      const domSelection = window.getSelection();
      const focusNode = domSelection?.focusNode ?? null;
      const pageHead =
        focusNode !== null && root.contains(focusNode)
          ? view.posAtDOM(focusNode, domSelection!.focusOffset)
          : null;
      const pageCaret =
        pageHead === null
          ? 'outside the note'
          : { ...where(state.doc.resolve(pageHead)), empty: domSelection!.isCollapsed };
      const agrees = pageHead === selection.head && domSelection!.isCollapsed === selection.empty;

      // Depth 0 is between top-level blocks (a selected card, a gap cursor):
      // no block holds the caret, and before() would throw. A miss to retry.
      if ($head.depth === 0) {
        return {
          inLine: false,
          at: 'neither',
          lastBlock: false,
          atNoteStart: false,
          agrees,
          editor,
          page: pageCaret,
        };
      }
      const block = view.nodeDOM($head.before());
      const at = !selection.empty
        ? 'neither'
        : $head.parentOffset === $head.parent.content.size
          ? 'end'
          : $head.parentOffset === 0
            ? 'start'
            : 'neither';
      const lastBlock = $head.index(0) === state.doc.childCount - 1;
      // The first place a caret can be: the start of the first block at every depth.
      let atNoteStart = selection.empty && $head.parentOffset === 0;
      for (let depth = 0; depth < $head.depth; depth += 1) {
        atNoteStart &&= $head.index(depth) === 0;
      }
      return {
        inLine: block !== null && block.contains(element),
        at,
        lastBlock,
        atNoteStart,
        agrees,
        editor,
        page: pageCaret,
      };
    },
    undefined,
    ONE_TRY,
  );
}
