import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost } from './host.ts';
import { caretAtLineEnd } from './caret.ts';

/**
 * Attack on UI v2 slice 13h (#317): the note table's card is now the
 * `.tableWrapper` with `overflow-x: auto`, inline code is a fixed 12.5px, and
 * the suggestion popup is a 320px-tall popover. Each test holds one thing the
 * restyle could break in the built app.
 */

const WIDE = Array.from({ length: 12 }, (_, at) => `column-heading-number-${at}`);

const NOTE = [
  '# Today',
  '',
  'Some text.',
  '',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
  '| 3 | 4 |',
  '',
].join('\n');

async function open(page: Page, name: string, text: string) {
  const vault = await createVault();
  await vault.write(`${name}.md`, text);
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  // Indexed first, so the note is not drawn again from the index mid-test.
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await page.getByRole('treeitem', { name, exact: true }).click();
}

test('a wide table scrolls inside its card and leaves the measure alone', async ({ page }) => {
  const table = [
    `| ${WIDE.join(' | ')} |`,
    `| ${WIDE.map(() => '-').join(' | ')} |`,
    `| ${WIDE.map((cell) => `${cell}-value`).join(' | ')} |`,
  ].join('\n');
  await open(page, 'wide', `# Wide\n\nBefore.\n\n${table}\n\nAfter.\n`);

  const wrapper = page.locator('.editor .tableWrapper');
  await expect(wrapper).toBeVisible();
  const paragraph = await page.getByText('Before.').boundingBox();
  const card = await wrapper.boundingBox();
  // The card is no wider than the text column it sits in…
  expect(card?.width ?? Infinity).toBeLessThanOrEqual((paragraph?.width ?? 0) + 1);
  // …and the table's extra width is scrolled inside it.
  const overflow = await wrapper.evaluate((at) => at.scrollWidth - at.clientWidth);
  expect(overflow).toBeGreaterThan(0);
});

test('a cell selection draws its overlay over each selected cell', async ({ page }) => {
  await open(page, 'today', NOTE);
  await expect(page.locator('.editor .tableWrapper')).toBeVisible();

  await page.locator('.editor td', { hasText: '1' }).click();
  // The shift-click extends the selection the click made: once the caret is in
  // that cell. Pressed before then, it had nothing to extend (Linux CI, run
  // 41225702304, no cell selected).
  await expect
    .poll(() =>
      page.evaluate(
        () => window.getSelection()?.anchorNode?.parentElement?.closest('td')?.textContent,
      ),
    )
    .toBe('1');
  await page.locator('.editor td', { hasText: '4' }).click({ modifiers: ['Shift'] });

  const selected = page.locator('.editor .selectedCell');
  await expect(selected).toHaveCount(4);
  const overlay = await selected.last().evaluate((cell) => {
    const after = getComputedStyle(cell, '::after');
    return { background: after.backgroundColor, position: after.position, content: after.content };
  });
  expect(overlay.position).toBe('absolute');
  expect(overlay.content).not.toBe('none');
  expect(overlay.background).not.toBe('rgba(0, 0, 0, 0)');
});

test('inline code in a heading is not set smaller than most of the heading', async ({ page }) => {
  await open(page, 'heading', '# A title with `code` in it\n\nBody.\n');

  const heading = page.locator('.editor h1');
  await expect(heading).toBeVisible();
  const [headingSize, codeSize] = await Promise.all([
    heading.evaluate((at) => Number.parseFloat(getComputedStyle(at).fontSize)),
    heading.locator('code').evaluate((at) => Number.parseFloat(getComputedStyle(at).fontSize)),
  ]);
  expect(headingSize).toBeGreaterThan(20);
  // 0.86em before the slice; a fixed 12.5px is half a 24px title.
  expect(codeSize).toBeGreaterThanOrEqual(headingSize * 0.8);
});

test('inline code inside bold text stays bold', async ({ page }) => {
  await open(page, 'bold', 'Plain and **bold with `code` inside** here.\n');

  const strong = page.locator('.editor strong');
  await expect(strong).toBeVisible();
  const [strongWeight, codeWeight] = await Promise.all([
    strong.evaluate((at) => Number.parseInt(getComputedStyle(at).fontWeight, 10)),
    strong.locator('code').evaluate((at) => Number.parseInt(getComputedStyle(at).fontWeight, 10)),
  ]);
  expect(strongWeight).toBeGreaterThanOrEqual(600);
  // `font:` on `.editor code` resets the weight to 400 inside a bold run.
  expect(codeWeight).toBeGreaterThanOrEqual(600);
});

test('the selected slash command is scrolled into the popup', async ({ page }) => {
  await open(page, 'today', NOTE);
  await caretAtLineEnd(page.getByText('Some text.'));
  await page.keyboard.press('Enter');
  await page.keyboard.type('/');

  const popup = page.getByRole('listbox', { name: 'Insert block' });
  await expect(popup).toBeVisible();
  // More rows than 320px holds, or there is nothing to scroll.
  expect(await popup.evaluate((at) => at.scrollHeight - at.clientHeight)).toBeGreaterThan(0);

  // Up from the top wraps to the last command, below the fold.
  await page.keyboard.press('ArrowUp');
  const chosen = popup.locator('[aria-selected="true"]');
  await expect(chosen).toHaveCount(1);
  const [list, row] = await Promise.all([popup.boundingBox(), chosen.boundingBox()]);
  expect(row?.y ?? Infinity).toBeGreaterThanOrEqual(list?.y ?? 0);
  expect((row?.y ?? Infinity) + (row?.height ?? 0)).toBeLessThanOrEqual(
    (list?.y ?? 0) + (list?.height ?? 0) + 1,
  );
});
