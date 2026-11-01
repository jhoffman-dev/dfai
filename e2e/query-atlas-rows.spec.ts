import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost } from './host.ts';

/*
 * #427: the Query page's DFAI-language result is virtualised as the other
 * tables are, grouped or not. A 2,000-row result draws only a window of its
 * rows, the result's own sheet scrolls rather than the panel around it, and
 * the last row can be reached.
 *
 * At 800px the page is narrow; at 560px and 480px tall the window is too
 * short for the page, which scrolls in its panel while the result keeps a
 * sheet of its own.
 */

const ROWS = 2000;
/** Far fewer than the result, and more than a tall screen's rows plus overscan. */
const MOST_DRAWN = 120;
const KINDS = ['alpha', 'beta', 'gamma', 'delta'] as const;

const front = (lines: string[], body: string) => ['---', ...lines, '---', '', body, ''].join('\n');
const ITEM_TYPE = front(
  [
    'name: item',
    'label: Item',
    'properties:',
    '  kind:',
    '    kind: select',
    `    options: [${KINDS.join(', ')}]`,
  ],
  '# Item',
);
/** "Row 0001" to "Row 2000": sorted by title, the last row is the last note. */
const title = (index: number) => `Row ${String(index).padStart(4, '0')}`;

async function openQueryPage(page: Page, size: { width: number; height: number }) {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('items');
  await vault.write('.atlas/types/item.md', ITEM_TYPE);
  for (let index = 1; index <= ROWS; index += 1) {
    const kind = KINDS[index % KINDS.length] ?? 'alpha';
    await vault.write(`items/${title(index)}.md`, front(['type: item', `kind: ${kind}`], ''));
  }
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  // 2,000 notes: a busy CI runner can take longer than the default 5 s to index them.
  await expect(page.getByText(/notes indexed/)).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'New in Views' }).click();
  await page.getByRole('menuitem', { name: 'New query' }).click();
  await expect(page.getByRole('heading', { name: 'Query', exact: true })).toBeVisible();
  // Opened wide, then squeezed: under 944px the sidebar is a drawer (#658).
  await page.setViewportSize(size);
  await page
    .getByRole('radiogroup', { name: 'Edit the query as' })
    .getByRole('radio', { name: 'Text' })
    .click();
}

const article = (page: Page) => page.getByRole('article', { name: 'Query' });
const sheet = (page: Page) => article(page).locator('.qresult__sheet');
const drawn = (page: Page) => sheet(page).locator('.qresult__title');

/** The app's smallest window (tauri.conf.json) and a few above it; the short ones scroll the panel. */
const WINDOWS = [
  { width: 1440, height: 900, panelScrolls: false },
  { width: 800, height: 900, panelScrolls: false },
  { width: 800, height: 560, panelScrolls: true },
  { width: 720, height: 480, panelScrolls: true },
] as const;
/** The least the result's sheet may show, header and a handful of rows, however short the window. */
const SHEET_FLOOR_PX = 160;

const QUERIES = [
  { name: 'ungrouped', text: `FROM item SORT BY title LIMIT ${ROWS}` },
  { name: 'grouped', text: `FROM item GROUP BY kind SORT BY title LIMIT ${ROWS}` },
] as const;

for (const { width, height, panelScrolls } of WINDOWS) {
  for (const query of QUERIES) {
    test(`at ${width}×${height}, a 2,000-row ${query.name} DFAI result draws a window of rows in its own scrolling sheet, down to the last`, async ({
      page,
    }) => {
      test.setTimeout(90_000);
      await openQueryPage(page, { width, height });
      await page.getByRole('textbox', { name: 'Query' }).fill(query.text);
      await expect(article(page).locator('.query__count')).toHaveText(`${ROWS} notes`);

      // However short the window, the sheet has room to show rows, and the panel brings it into view.
      const shown = await sheet(page).evaluate((el) => el.clientHeight);
      expect(shown, `the sheet shows ${shown}px`).toBeGreaterThanOrEqual(SHEET_FLOOR_PX);
      await sheet(page).scrollIntoViewIfNeeded();
      await expect(drawn(page).first()).toBeInViewport();

      const count = await drawn(page).count();
      expect(count, `${count} of ${ROWS} rows drawn`).toBeGreaterThan(0);
      expect(count, `${count} of ${ROWS} rows drawn`).toBeLessThanOrEqual(MOST_DRAWN);

      // The sheet is the rows' scroller, as on every other table. The panel
      // around it scrolls only when the window is too short for the page.
      const panel = await page
        .locator('.panel__body', { has: article(page) })
        .evaluate((body) => body.scrollHeight > body.clientHeight + 1);
      expect(panel, 'the panel around the result scrolls').toBe(panelScrolls);
      const sheetScrolls = await sheet(page).evaluate((el) => el.scrollHeight > el.clientHeight);
      expect(sheetScrolls, 'the result sheet scrolls').toBe(true);

      await sheet(page).evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      const last = query.name === 'grouped' ? /^Row \d{4}$/ : title(ROWS);
      await expect(drawn(page).filter({ hasText: last }).last()).toBeInViewport();
      if (query.name === 'ungrouped') await expect(drawn(page).last()).toHaveText(title(ROWS));
      expect(await drawn(page).count()).toBeLessThanOrEqual(MOST_DRAWN);
    });
  }
}
