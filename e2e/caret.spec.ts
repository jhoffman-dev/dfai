import { expect, test } from './fixtures.ts';
import { createVault, installHost } from './host.ts';
import { caretAtLineEnd, caretAtLineStart } from './caret.ts';
import type { Page } from '@playwright/test';

/** The helpers in caret.ts, on the lines around and inside a table (#489). */
const NOTE = [
  '# Tables',
  '',
  'Above the table.',
  '',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
  '',
  'Below the table.',
  '',
].join('\n');

async function openNote(page: Page): Promise<void> {
  const vault = await createVault();
  await vault.write('tables.md', NOTE);
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await page.getByRole('treeitem', { name: 'tables', exact: true }).click();
  await expect(page.locator('.editor table')).toBeVisible();
}

test('the caret reaches the end and start of the lines next to and inside a table', async ({
  page,
}) => {
  await openNote(page);
  const above = page.getByText('Above the table.');
  const below = page.getByText('Below the table.');
  const cell = page.locator('.editor td p').filter({ hasText: /^1$/ });

  await caretAtLineEnd(above);
  await page.keyboard.type('!');
  await expect(above).toHaveText('Above the table.!');

  await caretAtLineStart(below);
  await page.keyboard.type('>');
  await expect(page.getByText('Below the table.')).toHaveText('>Below the table.');

  await caretAtLineEnd(cell);
  await page.keyboard.type('0');
  await expect(page.locator('.editor td p').filter({ hasText: /^10$/ })).toHaveCount(1);
});

test("a click whose caret is put back at the note's start fails at once, naming the tap-caret fix", async ({
  page,
}) => {
  await openNote(page);
  // What ProseMirror's check after focus did before the tap-caret fix (#835)
  // when it lost the race with the click (#489): it put the selection it
  // had — the note's start — back on the page. Done on the click's mouseup,
  // so it always loses. The helper clicks once, so it must fail rather than
  // click again and hide the fix regressing (#850).
  await page.getByLabel('Note', { exact: true }).evaluate((editor) => {
    editor.addEventListener(
      'mouseup',
      () => {
        const heading = editor.querySelector('h1')?.firstChild;
        if (!heading) throw new Error('the note has no heading');
        document.getSelection()?.collapse(heading, 0);
        (window as { caretPutBack?: boolean }).caretPutBack = true;
      },
      { once: true },
    );
  });

  const missed = await caretAtLineEnd(page.getByText('Above the table.')).then(
    () => null,
    (error: unknown) => String(error),
  );

  expect(await page.evaluate(() => (window as { caretPutBack?: boolean }).caretPutBack)).toBe(true);
  expect(missed).toContain('the tap-caret fix (#835) is not holding for a click');
});

/**
 * Puts the caret back at the start of `line` the first `times` times the
 * editor reads it at that line's end, as ProseMirror's check after focus
 * does to a key that lands between the tap-caret plugin's read and that
 * check (#850, #869). Done when the editor reads the key's caret, not on
 * keyup: WebKit on Linux can move the caret for End after its keyup. Put
 * back through the editor, so the editor and the page agree at once and
 * that check, if still to come, finds them in step.
 */
async function undoLineEndKey(page: Page, line: string, times: number): Promise<void> {
  await page.getByText(line).evaluate((block, count) => {
    const root = block.closest('.ProseMirror') as
      | (Element & {
          editor: {
            on(event: 'selectionUpdate', listener: () => void): void;
            commands: { setTextSelection(pos: number): boolean };
            state: { selection: { empty: boolean; head: number } };
            view: { posAtDOM(node: Node, offset: number): number };
          };
        })
      | null;
    if (root === null) throw new Error('the line is not in an editor');
    const { editor } = root;
    const start = editor.view.posAtDOM(block, 0);
    const end = start + (block.textContent ?? '').length;
    let left = count;
    editor.on('selectionUpdate', () => {
      const { selection } = editor.state;
      if (left === 0 || !selection.empty || selection.head !== end) return;
      left -= 1;
      editor.commands.setTextSelection(start);
    });
  }, times);
}

/**
 * Opens the note with its editor focused by a click on another line, and
 * waits until ProseMirror's check after that focus has run. The helper's
 * click then makes no focus and so no check, and the only undo of ⌘→ is the
 * one undoLineEndKey forces: the check could otherwise undo the press after
 * it too (#869), which is not what these tests are about. The check runs on
 * a 20 ms timer set at the focus, so a 20 ms timer set after it, at the
 * focusin, runs once the check has.
 */
async function openNoteFocusedPastItsCheck(page: Page): Promise<void> {
  await openNote(page);
  await page.evaluate(() => {
    window.addEventListener(
      'focusin',
      () => setTimeout(() => ((window as { focusChecked?: boolean }).focusChecked = true), 20),
      { capture: true, once: true },
    );
  });
  await page.getByText('Below the table.').click();
  await expect
    .poll(() => page.evaluate(() => (window as { focusChecked?: boolean }).focusChecked))
    .toBe(true);
}

test('a line-end key undone back to where the click put the caret is pressed once more', async ({
  page,
}) => {
  await openNoteFocusedPastItsCheck(page);
  await undoLineEndKey(page, 'Above the table.', 1);
  const above = page.getByText('Above the table.');

  await caretAtLineEnd(above);
  await page.keyboard.type('!');

  await expect(above).toHaveText('Above the table.!');
});

test("a line-end key undone twice fails with the helper's own message", async ({ page }) => {
  await openNoteFocusedPastItsCheck(page);
  await undoLineEndKey(page, 'Above the table.', 2);

  const missed = await caretAtLineEnd(page.getByText('Above the table.')).then(
    () => null,
    (error: unknown) => String(error),
  );

  expect(missed).toContain("The click did not leave the caret at its line's end.");
  expect(missed).not.toContain('#835');
});

test('a caret beside a card, not in any line, is a miss, never an error', async ({ page }) => {
  const vault = await createVault();
  await vault.write('cards.md', '# Cards\n\n[[Rome]] <!-- atlas:bookmark -->\n\nPacking list.\n');
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await page.getByRole('treeitem', { name: 'cards', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Bookmark: Rome' })).toBeVisible();
  // Whenever the selection moves, the card is selected again: the editor's
  // caret then sits between top-level blocks, where there is no block to be in
  // (depth 0). Held on every selection change, not set once on keyup: the
  // editor can read the page's selection after the key's keyup has run, and
  // that read put the caret back in the line, so the helper found it there
  // and the test read no miss at all (#751).
  await page.getByLabel('Note', { exact: true }).evaluate((element) => {
    const { editor } = element as unknown as {
      editor: {
        on(event: 'selectionUpdate', listener: () => void): void;
        commands: { setNodeSelection(pos: number): boolean };
        state: {
          doc: { forEach(visit: (node: { isTextblock: boolean }, at: number) => void): void };
        };
      };
    };
    let card = -1;
    editor.state.doc.forEach((node, at) => {
      if (card === -1 && !node.isTextblock) card = at;
    });
    if (card === -1) throw new Error('the note has no card');
    // `commands` is read at each call: it carries a transaction made from the
    // state it was read in.
    editor.on('selectionUpdate', () => editor.commands.setNodeSelection(card));
  });

  const missed = await caretAtLineStart(page.getByText('Packing list.')).then(
    () => null,
    (error: unknown) => String(error),
  );
  expect(missed).toContain("The click did not leave the caret at its line's start.");
  expect(missed).not.toContain('RangeError');
});
