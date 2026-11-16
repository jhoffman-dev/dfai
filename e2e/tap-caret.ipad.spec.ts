import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, openVaultByTouch } from './host.ts';

/**
 * #835: the first tap into a just-opened note keeps its caret, even when the
 * main thread is too busy to tell the editor where the tap went before
 * ProseMirror's check 20 ms after focus. Busy is forced here: the tap's
 * `selectionchange` is kept from the editor for 60 ms after it arrives,
 * which before the fix put the caret back at the note's start, so the typing
 * landed in the title.
 */

/** How long the tap's `selectionchange` is held: well past ProseMirror's 20 ms. */
const HELD_MS = 60;

const NOTE = ['# Garden plan', '', 'Line 1 of the plan.', '', 'Line 2 of the plan.', ''].join('\n');

/** What the hold below did, read back by the test from `window.tapHold`. */
interface TapHold {
  /** An editor has taken the focus, so the next `selectionchange` is held. */
  focused: boolean;
  /** A `selectionchange` was kept from the editor. */
  held: boolean;
  /** The hold is over and the editor has been told once. */
  released: boolean;
}

/**
 * Holds the first `selectionchange` after an editor first takes the focus,
 * and any after it, for `HELD_MS`, then lets one through: what a busy main
 * thread does to the tap's. The hold starts when that `selectionchange`
 * arrives, not at the focus, so a runner stalled for longer than `HELD_MS`
 * between the two still has it held, and its release still comes after
 * ProseMirror's check, whose 20 ms timer was set at the focus.
 */
async function holdTheTapsSelectionChange(page: Page): Promise<void> {
  await page.addInitScript((heldMs: number) => {
    const hold: TapHold = { focused: false, held: false, released: false };
    (window as unknown as { tapHold: TapHold }).tapHold = hold;
    let releasing = false;
    window.addEventListener(
      'focusin',
      (event) => {
        if (!(event.target instanceof HTMLElement) || !event.target.isContentEditable) return;
        hold.focused = true;
      },
      { capture: true },
    );
    window.addEventListener(
      'selectionchange',
      (event) => {
        if (!hold.focused || hold.released || releasing) return;
        event.stopImmediatePropagation();
        if (hold.held) return;
        hold.held = true;
        setTimeout(() => {
          releasing = true;
          document.dispatchEvent(new Event('selectionchange'));
          releasing = false;
          hold.released = true;
        }, heldMs);
      },
      { capture: true },
    );
  }, HELD_MS);
}

/** The hold's state, as the page has it. */
function readHold(page: Page): Promise<TapHold> {
  return page.evaluate(() => (window as unknown as { tapHold: TapHold }).tapHold);
}

test('on an iPad, the tap that focuses a just-opened note keeps its caret when the page is busy', async ({
  page,
}) => {
  await holdTheTapsSelectionChange(page);
  const vault = await createVault();
  await vault.write('Garden plan.md', NOTE);
  await openVaultByTouch(page, vault);
  await page.getByRole('treeitem', { name: 'Garden plan', exact: true }).tap();
  const editor = page.getByLabel('Note', { exact: true });
  const line = editor.locator('p', { hasText: 'Line 2 of the plan.' });
  await expect(line).toBeVisible();

  // The tap must be what focuses the editor, or there is no focus to race.
  await expect(editor).not.toBeFocused();
  expect(await readHold(page)).toEqual({ focused: false, held: false, released: false });

  const box = await line.boundingBox();
  if (box === null) throw new Error('The line is not on the page.');
  await line.tap({ position: { x: box.width - 1, y: box.height / 2 } });
  // Typed only once the hold is over, as a person would: keys sent within
  // 20 ms of the tap would beat ProseMirror's reset and hide it.
  await expect.poll(() => readHold(page)).toEqual({ focused: true, held: true, released: true });
  await page.keyboard.type(' Tapped.');

  await expectFile(vault, 'Garden plan.md').toContain('Line 2 of the plan. Tapped.');
  await expectFile(vault, 'Garden plan.md').toMatch(/^# Garden plan\n/);
});
