/**
 * Attack on #244: the arrow keys between a long table's rows. Wherever the
 * focus lands it can be seen — never behind the sticky column headings — and
 * the headings stay at the top of the sheet however far it scrolls.
 */
import { expect, test, type Locator, type Page } from './fixtures.ts';
import { createVault, installHost, sidebarSection } from './host.ts';
import { focusThenPress } from './typing.ts';

const TASKS = 120;

const TASK_TYPE = ['---', 'name: task', 'label: Task', '---', ''].join('\n');

const title = (at: number) => `Chore ${String(at).padStart(3, '0')}`;

async function openTaskTable(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.mkdir('Chores');
  for (let at = 1; at <= TASKS; at += 1) {
    await vault.write(
      `Chores/${title(at)}.md`,
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

/** Whether the element on top at the focused name's centre is that name: false when something covers it. */
async function focusedNameUncovered(page: Page): Promise<{ row: string | null; shown: boolean }> {
  return page.evaluate(() => {
    const focused = document.activeElement as HTMLElement | null;
    const row = focused?.closest('tr')?.getAttribute('data-index') ?? null;
    if (focused === null) return { row, shown: false };
    const box = focused.getBoundingClientRect();
    const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return { row, shown: top !== null && focused.contains(top) };
  });
}

async function headingOnTop(page: Page, heading: Locator): Promise<boolean> {
  const box = await heading.boundingBox();
  if (box === null) return false;
  return page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('th') !== null, {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  });
}

test('walking up a long table with ArrowUp never leaves the focused row behind the headings', async ({
  page,
}) => {
  await openTaskTable(page);
  const names = page.locator('.table__row .table__link');
  await focusThenPress(names.first(), 'End');
  await expect(page.locator(`.table__row[data-index="${TASKS - 1}"] .table__link`)).toBeFocused();

  const hidden: string[] = [];
  for (let step = 1; step <= 40; step += 1) {
    await page.keyboard.press('ArrowUp');
    const want = String(TASKS - 1 - step);
    await expect(page.locator(`.table__row[data-index="${want}"] .table__link`)).toBeFocused();
    const seen = await focusedNameUncovered(page);
    if (!seen.shown) hidden.push(want);
  }
  expect(hidden, 'rows whose focused name was covered').toEqual([]);
});

test('the column headings stay on top of the sheet after End scrolls it to the last row', async ({
  page,
}) => {
  await openTaskTable(page);
  const heading = page
    .locator('.table__grid thead th')
    .filter({ hasText: /title|name/i })
    .first();
  await expect(heading).toBeVisible();
  await focusThenPress(page.locator('.table__row .table__link').first(), 'End');
  await expect(page.locator(`.table__row[data-index="${TASKS - 1}"] .table__link`)).toBeFocused();
  await expect(heading).toBeInViewport();
  expect(await headingOnTop(page, heading)).toBe(true);
});
