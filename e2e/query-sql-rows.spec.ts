import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost } from './host.ts';

/*
 * #401: the SQL query page's result is virtualised as the other tables are.
 * A 2,000-row result draws only a window of its rows, the result's own sheet
 * scrolls rather than the panel around it, and the last row can be reached.
 *
 * At 800px the page is narrow enough to stack the tables under the result;
 * at 560px and 480px tall the window is too short for the page, which scrolls
 * in its panel while the result keeps a sheet of its own.
 */

const ROWS = 2000;
/** Far fewer than the result, and more than a tall screen's rows plus overscan. */
const MOST_DRAWN = 120;
const NUMBERS = `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${ROWS})
SELECT 'Row ' || i AS title, i AS number FROM n`;

async function openQueryPage(page: Page, size: { width: number; height: number }) {
  await page.setViewportSize(size);
  const vault = await createVault();
  await vault.write('first.md', '# First\n\nA note.\n');
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await page.getByRole('button', { name: 'New in Views' }).click();
  await page.getByRole('menuitem', { name: 'New query' }).click();
  await expect(page.getByRole('heading', { name: 'Query', exact: true })).toBeVisible();
  await page
    .getByRole('radiogroup', { name: 'Query language' })
    .getByRole('radio', { name: 'SQL' })
    .click();
}

const article = (page: Page) => page.getByRole('article', { name: 'Query' });
const sheet = (page: Page) => article(page).locator('.table__sheet');
const drawn = (page: Page) => sheet(page).locator('tr[data-index]');

/** The app's smallest window (tauri.conf.json) and a few above it; the short ones scroll the panel. */
const WINDOWS = [
  { width: 1440, height: 900, panelScrolls: false },
  { width: 800, height: 900, panelScrolls: false },
  { width: 800, height: 560, panelScrolls: true },
  { width: 720, height: 480, panelScrolls: true },
] as const;
/** The least the result's sheet may show, header and a handful of rows, however short the window. */
const SHEET_FLOOR_PX = 160;

for (const { width, height, panelScrolls } of WINDOWS) {
  test(`at ${width}×${height}, a 2,000-row SQL result draws a window of rows in its own scrolling sheet, down to the last`, async ({
    page,
  }) => {
    await openQueryPage(page, { width, height });
    const editor = page.getByRole('textbox', { name: 'SQL' });
    await editor.fill(NUMBERS);
    await editor.press('Meta+Enter');
    await expect(page.locator('.query__count')).toHaveText(`${ROWS} rows`);

    // However short the window, the sheet has room to show rows, and the panel brings it into view.
    const shown = await sheet(page).evaluate((el) => el.clientHeight);
    expect(shown, `the sheet shows ${shown}px`).toBeGreaterThanOrEqual(SHEET_FLOOR_PX);
    await sheet(page).scrollIntoViewIfNeeded();
    await expect(sheet(page).getByRole('cell', { name: 'Row 1', exact: true })).toBeInViewport();

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
    await expect(
      sheet(page).getByRole('cell', { name: `Row ${ROWS}`, exact: true }),
    ).toBeInViewport();
    expect(await drawn(page).count()).toBeLessThanOrEqual(MOST_DRAWN);
  });
}
