/**
 * A long table is virtualised (#238): only the rows near the window are in
 * the page, and the rest are still reached — by scrolling, and from the
 * keyboard, where Up, Down, Home and End move between rows' names and a row
 * not yet drawn is scrolled into the page first. A grouped table moves the
 * same way between rows' names and its group headers (#248).
 */
import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost, sidebarSection } from './host.ts';
import { focusThenPress } from './typing.ts';

const TASKS = 150;

const TASK_TYPE = ['---', 'name: task', 'label: Task', '---', ''].join('\n');

const title = (at: number) => `Errand ${String(at).padStart(3, '0')}`;

async function openTaskTable(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.mkdir('Errands');
  for (let at = 1; at <= TASKS; at += 1) {
    await vault.write(
      `Errands/${title(at)}.md`,
      ['---', 'type: task', '---', '', `# ${title(at)}`, ''].join('\n'),
    );
  }
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await sidebarSection(page, 'types')
    .getByRole('button', { name: /^Task, \d+ notes?$/ })
    .click();
  await expect(page.locator('.table__count', { hasText: `${TASKS} tasks` })).toBeVisible();
}

test('a long table draws a screenful, and the keyboard reaches its last row and back', async ({
  page,
}) => {
  await openTaskTable(page);
  const rows = page.locator('.table__row');
  await expect(rows.first()).toBeVisible();
  await expect.poll(() => rows.count()).toBeLessThan(TASKS);

  const names = page.locator('.table__row .table__link');
  const first = (await names.first().textContent()) ?? '';
  await focusThenPress(names.first(), 'End');
  const last = page.locator(`.table__row[data-index="${TASKS - 1}"] .table__link`);
  await expect(last).toBeFocused();
  await expect(last).toBeInViewport();

  await page.keyboard.press('ArrowUp');
  await expect(page.locator(`.table__row[data-index="${TASKS - 2}"] .table__link`)).toBeFocused();

  await page.keyboard.press('Home');
  const top = page.locator('.table__row[data-index="0"] .table__link');
  await expect(top).toBeFocused();
  await expect(top).toHaveText(first);
});

test('a long table scrolls to its last row, which is then drawn', async ({ page }) => {
  await openTaskTable(page);
  const sheet = page.locator('.table__sheet');
  await expect(page.locator(`.table__row[data-index="${TASKS - 1}"]`)).toHaveCount(0);
  await sheet.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(page.locator(`.table__row[data-index="${TASKS - 1}"]`)).toBeInViewport();
});

const GROUPED_TASK_TYPE = [
  '---',
  'name: task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [backlog, doing]',
  '---',
  '',
].join('\n');

/** Half the tasks in Backlog, half in Doing, in a view that groups them by status. */
async function openGroupedTable(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/views');
  await vault.write('.atlas/types/task.md', GROUPED_TASK_TYPE);
  await vault.write(
    '.atlas/views/Grouped.md',
    [
      '---',
      'atlas: view',
      'type: task',
      'layout: table',
      'groupBy: status',
      'columns: [status]',
      `limit: ${TASKS * 2}`,
      '---',
      '',
      '# Grouped',
      '',
    ].join('\n'),
  );
  await vault.mkdir('Errands');
  for (let at = 1; at <= TASKS; at += 1) {
    const status = at <= TASKS / 2 ? 'backlog' : 'doing';
    await vault.write(
      `Errands/${title(at)}.md`,
      ['---', 'type: task', `status: ${status}`, '---', '', `# ${title(at)}`, ''].join('\n'),
    );
  }
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await sidebarSection(page, 'views').getByRole('button', { name: 'Grouped', exact: true }).click();
  // Doing's header is far below the page, so only Backlog's is drawn yet.
  await expect(page.locator('.table__group-toggle').first()).toHaveText(/^Backlog/);
}

test('a long grouped table moves row to row and header to header, across its groups (#248)', async ({
  page,
}) => {
  await openGroupedTable(page);
  const header = (name: RegExp) => page.locator('.table__group-toggle').filter({ hasText: name });
  const nameAt = (line: number) => page.locator(`tr[data-index="${line}"] .table__link`);
  const half = TASKS / 2;
  // Lines: Backlog's header, its rows, its "+ New"; then Doing's header, its rows, its "+ New".
  const doingHeader = half + 2;
  const lastRow = TASKS + 2;

  await focusThenPress(header(/^Backlog/), 'ArrowDown');
  await expect(nameAt(1)).toBeFocused();

  // The last row is far below the page: End scrolls to it, then focuses it.
  await page.keyboard.press('End');
  await expect(nameAt(lastRow)).toBeFocused();
  await expect(nameAt(lastRow)).toBeInViewport();

  // Up through Doing's rows to its header, then over Backlog's "+ New" to its last row.
  for (let step = 0; step < half; step += 1) await page.keyboard.press('ArrowUp');
  await expect(header(/^Doing/)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(nameAt(half)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator(`tr[data-index="${doingHeader}"] .table__group-toggle`)).toBeFocused();

  await page.keyboard.press('Home');
  await expect(header(/^Backlog/)).toBeFocused();
  await expect(header(/^Backlog/)).toBeInViewport();
});
