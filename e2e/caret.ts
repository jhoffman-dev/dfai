/**
 * Putting the editor's caret at a line's end or start, or the note's end, and
 * waiting until the editor holds it there (#445, #448).
 *
 * The click lands at the line's start on purpose: where a click lands is not
 * to be relied on, so the key that follows must move the caret from anywhere
 * on the line. End and Home do not: in WebKit on macOS they scroll and leave
 * the caret where it was. ⌘→ and ⌘← are the Mac's end and start of line. The
 * keys are the platform's own (platform.ts): End and Home on Linux.
 *
 * For 20 ms after it is focused, ProseMirror puts its own selection back on
 * the page unless it has read the page's by then; under load that is the
 * note's start (#489). So the editor's own selection is what is waited on,
 * and the page's caret must be at the same place: an editor that has not
 * read the page yet holds an old one.
 *
 * ⌘→ goes to the end of the line as drawn, so on a paragraph that wraps it
 * stops short of the block's end: the check then fails loudly, never passes.
 */
import { expect, type Locator } from '@playwright/test';
import { LINE_END, LINE_START, TEXT_END } from './platform.ts';

/** How long the editor is given to hold the caret where it is wanted. */
const CARET_WAIT = { timeout: 5_000 };

/** What is left of one `CARET_WAIT` for a helper's next step. */
type WaitLeft = () => { timeout: number };

/**
 * One `CARET_WAIT` shared by every step after this call: each step gets what
 * the steps before it left, never 0, which Playwright reads as no limit.
 */
function caretWaitFromNow(): WaitLeft {
  const ends = performance.now() + CARET_WAIT.timeout;
  return () => ({ timeout: Math.max(1, Math.round(ends - performance.now())) });
}

/**
 * How long one action may take: well under `CARET_WAIT`, so a line that
 * cannot be clicked or tapped fails with the action's own message, not only
 * with that wait running out.
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

/**
 * Clicks the line `line` is in and presses the keys to its start or end. The
 * click is never done again: the app keeps a click's caret through
 * ProseMirror's reset after focus (#835, the tap-caret plugin), so a caret
 * put back at the note's start is that fix regressing, and a second click
 * would hide it (#850). A caret anywhere but at the line's `where` fails at
 * once, saying where, but for one case, where ⌘→ is pressed again: see
 * endKeyUndone.
 */
async function caretAt(line: Locator, where: 'start' | 'end'): Promise<void> {
  // One CARET_WAIT for the click, the keys and the reads together, as when
  // the click was tried again: a page still busy opening the note can hold
  // the click past ONE_TRY, so it gets what is left, not ONE_TRY.
  const left = caretWaitFromNow();
  // ⌘→ is always pressed, never skipped when the editor already says the
  // caret is there: until ProseMirror reads the click, its selection is the
  // one from before, and the typing goes where the click put the page's
  // caret. ⌘← is pressed after ⌘→ whenever the caret is in the line, at its
  // end or, where it wraps, short of it: from a line's start under a bookmark
  // card, ⌘← takes the caret up to the line above.
  await line.click({ position: { x: 1, y: 5 }, ...left() });
  let caret = await pressAndRead(line, LINE_END, left);
  if (endKeyUndone(caret)) caret = await pressAndRead(line, LINE_END, left);
  if (where === 'start' && caret.inLine) caret = await pressAndRead(line, LINE_START, left);
  if (caret.inLine && caret.at === where) return;
  throw new Error(
    `The click did not leave the caret at its line's ${where}.${resetBy('click', caret)} ${whereCaretsAre(caret)}`,
  );
}

/** Presses `key`, and returns the caret once the editor has read the page's. */
async function pressAndRead(line: Locator, key: string, left: WaitLeft): Promise<Caret> {
  await line.page().keyboard.press(key);
  return caretReadByEditor(line, left);
}

/**
 * Whether the caret is still where the click put it, at its line's start, as
 * if the ⌘→ after it was never pressed. ProseMirror's check 20 ms after
 * focus puts its own selection back on the page unless it has read the
 * page's; the tap-caret plugin reads it just before, on its own timer, so
 * the click's caret is kept. A key that lands between that read and the
 * check, as a key pressed at once after the click can, is undone by the
 * check, back to the click's caret (#850, until #869 fixes the plugin). No
 * person presses that soon, so ⌘→ is pressed once more, never the click: a
 * click the check undid leaves the caret off its line, and fails at once.
 */
function endKeyUndone(caret: Caret): boolean {
  return caret.inLine && caret.at === 'start';
}

/**
 * The caret once the editor has read the page's, after a click or a key
 * moved the page's: until then the two disagree.
 */
async function caretReadByEditor(line: Locator, left: WaitLeft): Promise<Caret> {
  let caret = await caretOf(line);
  await expect(async () => {
    caret = await caretOf(line);
    expect(caret.agrees, whereCaretsAre(caret)).toBe(true);
  }).toPass(left());
  return caret;
}

/**
 * Taps the far right of the line `line` is in, which leaves the caret at its
 * end, and waits until the editor holds it there (#797, #821). Tapped once,
 * never again: the app keeps a tap's caret through ProseMirror's reset after
 * focus (#835, the tap-caret plugin), so a caret put back at the note's start
 * is that fix regressing, and a second tap would hide it. A tap that leaves
 * the caret anywhere but its line's end fails at once, saying where.
 */
export async function caretAtLineEndByTap(line: Locator): Promise<void> {
  const box = await line.boundingBox();
  if (box === null) throw new Error('The line is not on the page.');
  const before = JSON.stringify((await caretOf(line)).page);
  await line.tap({ position: { x: box.width - 1, y: box.height / 2 }, ...ONE_TRY });
  const landed = await caretSettledAfter(line, before);
  if (landed.inLine && landed.at === 'end') return;
  throw new Error(
    `The tap did not leave the caret at its line's end.${resetBy('tap', landed)} ${whereCaretsAre(landed)}`,
  );
}

/**
 * Says so when a caret the editor has read left its line for where the
 * reset after focus leaves it: the note's start, or, once the keys moved it
 * from there, elsewhere in the note's first block.
 */
function resetBy(press: 'click' | 'tap', caret: Caret): string {
  if (!caret.agrees || caret.inLine || !caret.inFirstBlock) return '';
  return ` It is where the reset after focus puts it: the tap-caret fix (#835) is not holding for a ${press}.`;
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
  }).toPass(CARET_WAIT);
  return caret;
}

function whereCaretsAre(caret: { editor: unknown; page: unknown }): string {
  return `the editor's caret: ${JSON.stringify(caret.editor)}; the page's: ${JSON.stringify(caret.page)}`;
}

/**
 * Puts the caret at the end of the note's last block, `lastLine`, by `move`
 * (a key to the note's end), done again until the editor holds it there: a
 * focus with no press, such as `focus()`, is left to ProseMirror's reset, and
 * that reset undoes a key as it would a click (#797). The reset runs once per
 * focus, so the second try is not undone. `move` is told which try it is,
 * from 1. Its actions should take `ONE_TRY`'s time or less.
 */
export async function caretAtNoteEndBy(
  lastLine: Locator,
  move: (attempt: number) => Promise<void>,
): Promise<void> {
  let attempt = 0;
  await expect(async () => {
    attempt += 1;
    await move(attempt);
    // The editor's caret and the page's must agree: an editor still holding
    // an old caret at this line's end, before it reads where the page's caret
    // went, would pass here and then take the typing elsewhere.
    const caret = await caretOf(lastLine);
    // The diff shows only the fields checked; where each caret is goes in the message.
    expect(caret, whereCaretsAre(caret)).toMatchObject({
      inLine: true,
      agrees: true,
      at: 'end',
      lastBlock: true,
    });
  }).toPass(CARET_WAIT);
}

/**
 * Where the editor that holds `line` has its caret: whether it is in the
 * block `line` is in, at that block's start, end, or neither, and whether
 * that block is the note's last or first, where ProseMirror's reset after
 * focus puts it; whether the page's caret is at the
 * same place; and, for a failure to show, each caret's block text and offset.
 */
type Caret = Awaited<ReturnType<typeof caretOf>>;

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
      // no block holds the caret, and before() would throw. Not in the line.
      if ($head.depth === 0) {
        return {
          inLine: false,
          at: 'neither',
          lastBlock: false,
          inFirstBlock: false,
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
      const inFirstBlock = $head.index(0) === 0;
      return {
        inLine: block !== null && block.contains(element),
        at,
        lastBlock,
        inFirstBlock,
        agrees,
        editor,
        page: pageCaret,
      };
    },
    undefined,
    ONE_TRY,
  );
}
