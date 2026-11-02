import { expect, test, type Locator, type Page } from './fixtures.ts';
import { createVault, expectFile, openVaultByTouch } from './host.ts';

/**
 * #660: the editor on an iPad, by finger and by a hardware keyboard. This spec
 * runs only in the `ipad` project (playwright.config.ts): a touch screen, a
 * coarse pointer, and the platform string iPadOS 13+ reports, "MacIntel".
 *
 * What a real iPad has that this cannot: iOS's own selection handles and its
 * callout, which belong to UIKit, not the page; and a real on-screen keyboard.
 * So a selection here is made by the hardware keyboard (⇧←), and the keyboard
 * is stood in for by a `window.visualViewport` the test shrinks — the one
 * signal the app reads for it, so the wiring from that signal to the caret
 * and the pickers is what is proved.
 */

/** 2026-10-13, midday where the test runs. */
const NOW = new Date(2026, 9, 13, 12, 0, 0);

const LINES = 60;
/** Enough lines to scroll by a keyboard's height, each saying which it is. */
const LONG_NOTE = [
  '# Garden plan',
  '',
  ...Array.from({ length: LINES }, (_, index) => `Line ${index + 1} of the plan.`).flatMap(
    (line) => [line, ''],
  ),
].join('\n');

const FILES: Record<string, string> = {
  'Garden plan.md': LONG_NOTE,
  'Sow the beans.md': '# Sow the beans\n\nA task.\n',
};

async function openGardenVault(page: Page) {
  const vault = await createVault();
  for (const [path, text] of Object.entries(FILES)) await vault.write(path, text);
  await openVaultByTouch(page, vault, { now: NOW });
  await page.getByRole('treeitem', { name: 'Garden plan', exact: true }).tap();
  const editor = page.getByLabel('Note', { exact: true });
  await expect(editor.getByText('Line 1 of the plan.')).toBeVisible();
  return { vault, editor };
}

const lineOf = (editor: Locator, index: number) =>
  editor.locator('p', { hasText: `Line ${index} of the plan.` });

/** Taps the far right of a line, which leaves the caret at its end. */
async function tapLineEnd(line: Locator): Promise<void> {
  const box = await line.boundingBox();
  if (box === null) throw new Error('The line is not on the page.');
  await line.tap({ position: { x: box.width - 1, y: box.height / 2 } });
}

test('on an iPad, a finger types, links with [[, inserts with /, and moves a block from its handle', async ({
  page,
}) => {
  const { vault, editor } = await openGardenVault(page);

  await test.step('the page is an iPad as iPadOS 13+ reports one: a Mac with a touch screen', async () => {
    expect(await page.evaluate(() => navigator.platform)).toBe('MacIntel');
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
  });

  await test.step('a tap puts the caret where the finger was, and typing lands there', async () => {
    await tapLineEnd(lineOf(editor, 2));
    await page.keyboard.type(' Tapped.');
    await expectFile(vault, 'Garden plan.md').toContain('Line 2 of the plan. Tapped.');
  });

  await test.step('a hardware keyboard selects with ⇧← and ⌘B makes it bold', async () => {
    for (let held = 0; held < 'Tapped.'.length; held += 1) {
      await page.keyboard.press('Shift+ArrowLeft');
    }
    await page.keyboard.press('Meta+b');
    await expectFile(vault, 'Garden plan.md').toContain('Line 2 of the plan. **Tapped.**');
  });

  await test.step('[[ offers notes, and a tap on one links it', async () => {
    await tapLineEnd(lineOf(editor, 3));
    await page.keyboard.type(' [[Sow');
    await page
      .getByRole('listbox', { name: 'Link to note' })
      .getByRole('option', { name: /^Sow the beans/ })
      .tap();
    await expectFile(vault, 'Garden plan.md').toContain('Line 3 of the plan. [[Sow the beans]]');
  });

  await test.step('/ offers blocks, and a tap on one inserts it', async () => {
    await tapLineEnd(lineOf(editor, 4));
    await page.keyboard.press('Enter');
    await page.keyboard.type('/quo');
    await page
      .getByRole('listbox', { name: 'Insert block' })
      .getByRole('option', { name: /Quote/ })
      .tap();
    await page.keyboard.type('Quoted by a finger.');
    await expectFile(vault, 'Garden plan.md').toContain('> Quoted by a finger.');
  });

  await test.step('a tap on a block shows its handle; a tap on the handle opens its menu, and Move down moves it', async () => {
    const sixth = lineOf(editor, 6);
    await sixth.tap();
    const handle = page.locator('[data-block-handle]');
    await expect(handle).toBeVisible();
    await handle.tap();
    const menu = page.getByRole('menu', { name: 'Block' });
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitem', { name: /Move down/ }).tap();
    await expect(menu).toBeHidden();
    await expectFile(vault, 'Garden plan.md').toContain(
      'Line 7 of the plan.\n\nLine 6 of the plan.',
    );
  });
});

/**
 * Stands in for an iPad's on-screen keyboard: a `window.visualViewport` whose
 * height the test takes the keyboard's from, with the window's own size left
 * alone, which is exactly what iPadOS does. Playwright cannot shrink WebKit's
 * real visual viewport on its own.
 */
async function withFakeKeyboard(page: Page): Promise<(height: number) => Promise<void>> {
  await page.addInitScript(() => {
    const state = { keyboard: 0 };
    const viewport = Object.assign(new EventTarget(), {
      offsetTop: 0,
      offsetLeft: 0,
      pageTop: 0,
      pageLeft: 0,
      scale: 1,
    });
    // Defined, not assigned: `Object.assign` would copy a getter's value once.
    Object.defineProperties(viewport, {
      width: { get: () => window.innerWidth },
      height: { get: () => window.innerHeight - state.keyboard },
    });
    Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true });
    Object.defineProperty(window, '__keyboard', {
      value: (height: number) => {
        state.keyboard = height;
        viewport.dispatchEvent(new Event('resize'));
      },
    });
  });
  return (height) =>
    page.evaluate((raised) => {
      (window as unknown as { __keyboard: (height: number) => void }).__keyboard(raised);
    }, height);
}

/** An iPad's keyboard, on its side: about half of the 820px. */
const KEYBOARD_HEIGHT = 400;

/** A paragraph of the note whose top lies between `from` and `to` on the page. */
async function lineBetween(editor: Locator, from: number, to: number): Promise<Locator> {
  const text = await editor.evaluate(
    (element, range) => {
      for (const paragraph of element.querySelectorAll('p')) {
        const { top } = paragraph.getBoundingClientRect();
        if (top >= range.from && top <= range.to) return paragraph.textContent;
      }
      return null;
    },
    { from, to },
  );
  if (text === null) throw new Error(`No line between ${from} and ${to}.`);
  return editor.locator('p', { hasText: text });
}

test('the caret and the open picker stay above the on-screen keyboard', async ({ page }) => {
  const raiseKeyboard = await withFakeKeyboard(page);
  const { vault, editor } = await openGardenVault(page);
  const visibleBottom = 820 - KEYBOARD_HEIGHT;

  await test.step('a caret the keyboard rose over is scrolled back into view', async () => {
    // A line the keyboard will cover: in the lower part of the page, in view now.
    const covered = await lineBetween(editor, visibleBottom + 100, 780);
    await tapLineEnd(covered);
    await raiseKeyboard(KEYBOARD_HEIGHT);
    await expect
      .poll(async () => (await covered.boundingBox())?.y ?? Number.NaN)
      .toBeLessThan(visibleBottom);
    const box = await covered.boundingBox();
    if (box === null) throw new Error('The line is not on the page.');
    expect(box.y + box.height).toBeLessThanOrEqual(visibleBottom);
    await page.keyboard.type(' Seen.');
    await expectFile(vault, 'Garden plan.md').toContain('of the plan. Seen.');
  });

  await test.step('the / picker opens upward when there is no room for it under the caret', async () => {
    // A line in the lower half of what is visible: the list is taller than the room under it.
    const low = await lineBetween(editor, visibleBottom - 120, visibleBottom - 40);
    await tapLineEnd(low);
    await page.keyboard.press('Enter');
    await page.keyboard.type('/');
    const popup = page.getByRole('listbox', { name: 'Insert block' });
    await expect(popup).toBeVisible();
    await expect(popup).toHaveAttribute('data-flipped', 'true');
    const popupBox = await popup.boundingBox();
    if (popupBox === null) throw new Error('The list is not drawn.');
    expect(popupBox.y + popupBox.height).toBeLessThanOrEqual(visibleBottom);
    expect(popupBox.y).toBeGreaterThanOrEqual(0);
    await page.keyboard.press('Escape');
  });

  await test.step('with the keyboard gone, the picker hangs under the caret again', async () => {
    await raiseKeyboard(0);
    // The `/` Escape left behind is removed, so the new one is at the line's start again.
    await page.keyboard.press('Backspace');
    await page.keyboard.type('/');
    const popup = page.getByRole('listbox', { name: 'Insert block' });
    await expect(popup).toBeVisible();
    await expect(popup).toHaveAttribute('data-flipped', 'false');
  });
});
