import { caretAtLineEndByTap } from './caret.ts';
import { expect, test, type Locator, type Page } from './fixtures.ts';
import { createVault, expectFile, openVaultByTouch } from './host.ts';
import { expectFocusIn } from './typing.ts';

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

test('on an iPad, a finger types, links with [[, inserts with /, and moves a block from its handle', async ({
  page,
}) => {
  const { vault, editor } = await openGardenVault(page);

  await test.step('the page is an iPad as iPadOS 13+ reports one: a Mac with a touch screen', async () => {
    expect(await page.evaluate(() => navigator.platform)).toBe('MacIntel');
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
  });

  await test.step('a tap puts the caret where the finger was, and typing lands there', async () => {
    await caretAtLineEndByTap(lineOf(editor, 2));
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
    await caretAtLineEndByTap(lineOf(editor, 3));
    await page.keyboard.type(' [[Sow');
    await page
      .getByRole('listbox', { name: 'Link to note' })
      .getByRole('option', { name: /^Sow the beans/ })
      .tap();
    await expectFile(vault, 'Garden plan.md').toContain('Line 3 of the plan. [[Sow the beans]]');
  });

  await test.step('/ offers blocks, and a tap on one inserts it', async () => {
    await caretAtLineEndByTap(lineOf(editor, 4));
    await page.keyboard.press('Enter');
    await page.keyboard.type('/quo');
    await page
      .getByRole('listbox', { name: 'Insert block' })
      .getByRole('option', { name: /Quote/ })
      .tap();
    await expectFocusIn(editor);
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

/** What the test does to the stand-in visual viewport, from outside the page. */
interface FakeViewport {
  /** Raises (or, at 0, lowers) the keyboard: the height shrinks, the width does not. */
  keyboard(height: number): Promise<void>;
  /** Pinch-zooms by `scale`: both sides shrink, and the browser says `resize`. */
  zoom(scale: number): Promise<void>;
  /** Pans the zoomed view down the page by `offsetTop`: a `scroll`, with the size unchanged. */
  pan(offsetTop: number): Promise<void>;
}

/**
 * Stands in for `window.visualViewport`, which Playwright cannot shrink or
 * move in WebKit on its own: an iPad's on-screen keyboard takes its height
 * and leaves the window's size alone, and a pinch-zoom shrinks both sides and
 * pans. `pageTop` is kept apart from `offsetTop` by the page's own scroll, so
 * reading the wrong one would place things 1000px off (review of PR #744).
 */
async function withFakeViewport(page: Page): Promise<FakeViewport> {
  await page.addInitScript(() => {
    const state = { keyboard: 0, offsetTop: 0, scale: 1 };
    const viewport = new EventTarget();
    // Defined, not assigned: `Object.assign` would copy a getter's value once.
    Object.defineProperties(viewport, {
      offsetTop: { get: () => state.offsetTop },
      offsetLeft: { get: () => 0 },
      pageTop: { get: () => state.offsetTop + 1000 },
      pageLeft: { get: () => 0 },
      scale: { get: () => state.scale },
      width: { get: () => window.innerWidth / state.scale },
      height: { get: () => (window.innerHeight - state.keyboard) / state.scale },
    });
    Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true });
    Object.defineProperty(window, '__viewport', {
      value: {
        keyboard: (height: number) => {
          state.keyboard = height;
          viewport.dispatchEvent(new Event('resize'));
        },
        zoom: (scale: number) => {
          state.scale = scale;
          viewport.dispatchEvent(new Event('resize'));
        },
        pan: (offsetTop: number) => {
          state.offsetTop = offsetTop;
          viewport.dispatchEvent(new Event('scroll'));
        },
      },
    });
  });
  type Controls = { __viewport: { [K in keyof FakeViewport]: (value: number) => void } };
  const drive = (control: keyof FakeViewport, value: number) =>
    page.evaluate(([name, given]) => (window as unknown as Controls).__viewport[name](given), [
      control,
      value,
    ] as const);
  return {
    keyboard: (height) => drive('keyboard', height),
    zoom: (scale) => drive('zoom', scale),
    pan: (offsetTop) => drive('pan', offsetTop),
  };
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
  const viewport = await withFakeViewport(page);
  const { vault, editor } = await openGardenVault(page);
  const visibleBottom = 820 - KEYBOARD_HEIGHT;

  await test.step('a caret the keyboard rose over is scrolled back into view', async () => {
    // A line the keyboard will cover: in the lower part of the page, in view now.
    const covered = await lineBetween(editor, visibleBottom + 100, 780);
    await caretAtLineEndByTap(covered);
    await viewport.keyboard(KEYBOARD_HEIGHT);
    // What the page itself sees, so a miss names its cause: the stand-in not
    // taking, or the tap not leaving the editor focused (CI of PR #744).
    const seen = await page.evaluate(() => ({
      visibleHeight: window.visualViewport?.height,
      standIn: '__viewport' in window,
      editorFocused: document.activeElement?.classList.contains('ProseMirror') ?? false,
    }));
    expect(seen, `the page's view of the keyboard: ${JSON.stringify(seen)}`).toEqual({
      visibleHeight: 820 - KEYBOARD_HEIGHT,
      standIn: true,
      editorFocused: true,
    });
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
    await caretAtLineEndByTap(low);
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
    await viewport.keyboard(0);
    // The `/` Escape left behind is removed, so the new one is at the line's start again.
    await page.keyboard.press('Backspace');
    await page.keyboard.type('/');
    const popup = page.getByRole('listbox', { name: 'Insert block' });
    await expect(popup).toBeVisible();
    await expect(popup).toHaveAttribute('data-flipped', 'false');
    await page.keyboard.press('Escape');
  });

  await test.step('the last line of a long note is typed into above the keyboard too (review of PR #744)', async () => {
    // Below the last line there is only the note's bottom padding, less than a
    // keyboard is tall: the note must be given more room to scroll into.
    const last = lineOf(editor, LINES);
    await caretAtLineEndByTap(last);
    await viewport.keyboard(KEYBOARD_HEIGHT);
    await expect
      .poll(async () => {
        const box = await last.boundingBox();
        return box === null ? Number.NaN : box.y + box.height;
      })
      .toBeLessThanOrEqual(visibleBottom);
    await page.keyboard.type(' Last.');
    await expectFile(vault, 'Garden plan.md').toContain(`Line ${LINES} of the plan. Last.`);
    await viewport.keyboard(0);
  });

  await test.step('a picker follows a pinch-zoomed view as it pans: within offsetTop and the height', async () => {
    const PAN = 300;
    const SCALE = 2;
    // A line near the top of the page, which the pan will leave above the visible area.
    const high = await lineBetween(editor, 0, 220);
    await caretAtLineEndByTap(high);
    await viewport.zoom(SCALE);
    await page.keyboard.press('Enter');
    await page.keyboard.type('/');
    const popup = page.getByRole('listbox', { name: 'Insert block' });
    await expect(popup).toBeVisible();
    await viewport.pan(PAN);
    const visibleHeight = 820 / SCALE;
    await expect
      .poll(async () => (await popup.boundingBox())?.y ?? Number.NaN)
      .toBeGreaterThanOrEqual(PAN);
    const popupBox = await popup.boundingBox();
    if (popupBox === null) throw new Error('The list is not drawn.');
    expect(popupBox.y + popupBox.height).toBeLessThanOrEqual(PAN + visibleHeight);
  });
});
