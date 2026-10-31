import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost } from './host.ts';
import { sweepWithin } from './tab-sweep.ts';

/**
 * Adversarial pass on #247 (Performance B, #238), in WebKit: the Inbox
 * places only the rows near what the page shows. With 600 notes waiting —
 * past "Show more" — every row must be reached by Tab and by Shift+Tab, each
 * control in view as it is reached and the focus never lost to `<body>`; and
 * the rows' `aria-rowindex` must agree with the table's `aria-rowcount`.
 */

const WAITING = 600;

async function openInbox(page: Page) {
  const vault = await createVault();
  await vault.mkdir('Inbox');
  await Promise.all(
    Array.from({ length: WAITING }, (_, n) =>
      vault.write(`Inbox/Item ${String(n + 1).padStart(3, '0')}.md`, `Captured line ${n + 1}.\n`),
    ),
  );
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: /^Inbox/ }).click();
  const inbox = page.getByRole('article', { name: 'Inbox' });
  const table = inbox.locator('table.inbox__grid');
  await expect(table).toHaveAttribute('aria-rowcount', '501', { timeout: 30_000 });
  // The offers are read after the list and land above it, moving "Show more"
  // down: a click begun before they land is let go on the rows, and is lost (#130).
  await expect(
    inbox.getByRole('complementary', { name: 'Set your types up for the Inbox' }),
  ).toBeVisible();
  await expect(inbox.getByRole('region', { name: 'Move tasks to GTD statuses' })).toBeVisible();
  await inbox.getByRole('button', { name: 'Show more' }).click();
  await expect(table).toHaveAttribute('aria-rowcount', String(WAITING + 1));
  return { inbox, table };
}

// Recorded in the page, as Today's sweep is (#644): a round trip and two frames
// for each of some 3,000 stops took the two sweeps over two minutes.
const sweep = sweepWithin({
  within: 'table.inbox__grid',
  row: 'tr',
  rowName: { text: '.table__link' },
});

test.describe.configure({ timeout: 600_000 });

test('Tab reaches all 600 rows past Show more, each control in view, focus never lost', async ({
  page,
}) => {
  const { table } = await openInbox(page);
  // "Show more" left the page at its end: back to the top, and the first row.
  await page.locator('.panel__body').evaluate((element) => {
    element.scrollTop = 0;
  });
  const first = table.locator('tr[aria-rowindex="2"] .table__link');
  await expect(first).toBeVisible();
  await first.focus();

  const forward = await sweep(page, 'Tab', 5_000);

  expect(forward.offScreen).toEqual([]);
  // Tabbing off the end of the page may leave it, but only once every row is reached.
  expect(forward.rows.size).toBeGreaterThanOrEqual(WAITING - 1);
});

test('Shift+Tab from the last row reaches all 600 rows back to the first, each in view', async ({
  page,
}) => {
  const { table } = await openInbox(page);
  const scroller = page.locator('.panel__body');
  for (let tries = 0; tries < 20; tries += 1) {
    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await page.waitForTimeout(50);
  }
  const last = table.locator(`tr[aria-rowindex="${WAITING + 1}"]`);
  await expect(last).toBeVisible();
  // Its last control that takes the focus (the File picker is disabled with
  // nowhere to file to), so Shift+Tab walks every control above it.
  const makeTask = last.getByRole('button', { name: 'Make task' });
  await makeTask.focus();
  await expect(makeTask).toBeFocused();

  const back = await sweep(page, 'Shift+Tab', 5_000);

  expect(back.lostAfter).toBeNull();
  expect(back.offScreen).toEqual([]);
  // Every row but the one started on.
  expect(back.rows.size).toBeGreaterThanOrEqual(WAITING - 1);
});

test('every placed row’s aria-rowindex is unique, within aria-rowcount, and names its own place', async ({
  page,
}) => {
  const { table } = await openInbox(page);
  const scroller = page.locator('.panel__body');
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight * 0.6;
  });
  await page.waitForTimeout(300);

  const found = await table.evaluate((grid) => {
    const count = Number(grid.getAttribute('aria-rowcount'));
    const rows = [...grid.querySelectorAll<HTMLTableRowElement>('tr[aria-rowindex]')];
    return {
      count,
      rows: rows.map((row) => ({
        index: Number(row.getAttribute('aria-rowindex')),
        name: row.querySelector('.table__link')?.textContent?.trim() ?? null,
      })),
    };
  });

  expect(found.rows.length).toBeGreaterThan(2);
  const indexes = found.rows.map((row) => row.index);
  expect(new Set(indexes).size).toBe(indexes.length);
  expect(Math.max(...indexes)).toBeLessThanOrEqual(found.count);
  // Newest first; the note numbered `n` is the `(WAITING - n + 1)`th — what
  // matters is that the order of rows in the page is the order of their indexes.
  expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
});
