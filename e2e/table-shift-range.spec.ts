/**
 * Shift-click on a table row's box chooses the run from the row last chosen
 * to it (#249) — in a long, virtualised table, where most of the rows in the
 * run are not drawn when it is chosen — and Shift+Space on a focused box does
 * the same from the keyboard.
 */
import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost, sidebarSection } from './host.ts';
import { focusThenPress } from './typing.ts';

const TASKS = 420;

const TASK_TYPE = ['---', 'name: task', 'label: Task', '---', ''].join('\n');

const title = (at: number) => `Errand ${String(at).padStart(3, '0')}`;

async function openTaskView(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/views');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write(
    '.atlas/views/Errands.md',
    ['---', 'atlas: view', 'type: task', 'layout: table', `limit: ${TASKS * 2}`, '---', ''].join(
      '\n',
    ),
  );
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
  await sidebarSection(page, 'views').getByRole('button', { name: 'Errands', exact: true }).click();
  await expect(page.locator('.table__count', { hasText: `${TASKS} tasks` })).toBeVisible();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
}

const box = (page: Page, at: number) =>
  page.getByRole('checkbox', { name: `Select ${title(at)}`, exact: true });
const count = (page: Page) => page.locator('.selection-bar__count');

test('Shift-click chooses every row of a 420-row table between the two, drawn or not', async ({
  page,
}) => {
  await openTaskView(page);
  await expect(page.locator('.table__row')).not.toHaveCount(0);
  await expect.poll(() => page.locator('.table__row').count()).toBeLessThan(TASKS);

  await box(page, 1).click();
  await expect(count(page)).toHaveText('1 selected');

  await page.locator('.table__sheet').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await box(page, TASKS).click({ modifiers: ['Shift'] });
  await expect(count(page)).toHaveText(`${TASKS} selected`);

  // Back at the top, the rows the run went past are chosen too.
  await page.locator('.table__sheet').evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(box(page, 2)).toBeChecked();
  await expect(box(page, 20)).toBeChecked();
});

test('Shift+Space on a focused box chooses the run from the row last chosen', async ({ page }) => {
  await openTaskView(page);
  await box(page, 3).click();
  await focusThenPress(box(page, 7), 'Shift+Space');
  await expect(count(page)).toHaveText('5 selected');
  for (const at of [3, 4, 5, 6, 7]) await expect(box(page, at)).toBeChecked();
  await expect(box(page, 8)).not.toBeChecked();
});
