// Attack on PR #425 (#300): a cell's picker against the rest of the window —
// tabs, split panes, and a virtualised table scrolled under it.
import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost, sidebarSection } from './host.ts';

async function openSearch(page: Page) {
  await page.keyboard.down('Meta');
  await page.keyboard.press('k');
  await page.keyboard.up('Meta');
}

const TASK_TYPE =
  '---\nname: task\nproperties:\n  status:\n    kind: select\n    options: [backlog, doing, done]\n  phase: number\n---\n';
const VIEW =
  '---\natlas: view\ntype: task\ncolumns: [status, phase]\nsorts:\n  - key: phase\n    direction: asc\n---\n\n# Tasks\n';

async function openTable(page: Page, count = 1) {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/views');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write('.atlas/views/Tasks.md', VIEW);
  for (let at = 0; at < count; at += 1) {
    const name = `t${String(at).padStart(3, '0')}`;
    await vault.write(
      `${name}.md`,
      `---\ntype: task\nstatus: doing\nphase: ${at}\n---\n\n# Task ${name}\n`,
    );
  }
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await sidebarSection(page, 'views').getByRole('button', { name: 'Tasks', exact: true }).click();
  const cell = page.locator('.table [data-cell-stop="status"]').first();
  await expect(cell).toBeVisible();
  return { vault, cell };
}

test('a new tab opened over a cell’s picker leaves no picker over it', async ({ page }) => {
  const { vault, cell } = await openTable(page);
  await cell.click();
  await expect(page.locator('.cell-picker')).toBeVisible();
  await page.keyboard.press('Meta+t');
  await expect(page.locator('.cell-picker')).toHaveCount(0);
  expect(await vault.read('t000.md')).toContain('status: doing');
});

test('back on the table’s tab after a picker was left open, ⌘K still opens', async ({ page }) => {
  const { cell } = await openTable(page);
  await cell.click();
  await expect(page.locator('.cell-picker')).toBeVisible();
  await page.keyboard.press('Meta+t');
  await page.keyboard.press('Meta+1');
  await expect(page.locator('.table [data-cell-stop="status"]').first()).toBeVisible();
  await openSearch(page);
  await expect(page.getByRole('dialog', { name: 'Search notes' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('.table [data-cell-stop="status"]').first().click();
  await expect(page.locator('.cell-picker')).toHaveCount(1);
});

test('a picker opened in a second pane leaves only one picker in the window', async ({ page }) => {
  const { cell } = await openTable(page);
  await page.getByRole('button', { name: 'Split right' }).first().click();
  const cells = page.locator('.table [data-cell-stop="status"]');
  await expect(cells).toHaveCount(2);
  await cell.click();
  await expect(page.locator('.cell-picker')).toHaveCount(1);
  await cells.nth(1).click();
  await expect(page.locator('.cell-picker')).toHaveCount(1);
});

test('a picker whose row scrolls out of a long table is not left floating', async ({ page }) => {
  const { cell } = await openTable(page, 420);
  await cell.click();
  const picker = page.locator('.cell-picker');
  await expect(picker).toBeVisible();
  // Wheel over the rows, not the picker: the table scrolls under the open picker.
  await page.mouse.move(600, 500);
  for (let turn = 0; turn < 20; turn += 1) await page.mouse.wheel(0, 2000);
  await expect(page.locator('.table').getByText('t000', { exact: true })).toHaveCount(0);
  // The first row is gone from the page; the picker hanging from it must not stay
  // drawn — WebKit draws it at the window's top-left corner, over the sidebar.
  await expect(picker).toBeHidden();
});
