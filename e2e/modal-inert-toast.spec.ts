import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, sidebarSection } from './host.ts';
import { modalFocus, tabWithin } from './modal-focus.ts';
import { toastSaying } from './toasts.ts';

/**
 * A toast stays live behind an open dialog (#827, #848): it is not inert, so
 * it can be read and dismissed, and so the focus can reach it. That is the one
 * thing behind the dialog Tab may land on: never the app itself.
 */
const TASK_TYPE = [
  '---',
  'name: task',
  'label: Task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [inbox, backlog, next-action, in-progress, waiting, someday, longterm, archive]',
  '    done: archive',
  '---',
  '',
].join('\n');
const VIEW = ['---', 'atlas: view', 'type: task', 'columns: [status]', '---', '', '# Tasks', ''];
const PATH = 'Tasks/Send the invoice.md';
const TASK = ['---', 'type: task', 'status: in-progress', '---', '', '# Send the invoice', ''];

/** Opens the vault and makes a change whose toast stays up while the pointer is on it. */
async function raiseToast(page: Page) {
  const vault = await createVault();
  for (const folder of ['.atlas/types', '.atlas/views', 'Tasks']) await vault.mkdir(folder);
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write('.atlas/views/Tasks.md', VIEW.join('\n'));
  await vault.write(PATH, TASK.join('\n'));
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();

  await sidebarSection(page, 'views').getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.locator('.table [data-cell-stop="status"]').first().click();
  await expect(page.getByRole('dialog', { name: 'Set Status' })).toBeVisible();
  await page.keyboard.press('5');
  await expectFile(vault, PATH).toMatch(/^status: +'?waiting/m);
  const toast = toastSaying(page, 'Changed “Send the invoice”.');
  await expect(toast).toBeVisible();
  await toast.hover();
}

test('with a toast up behind Settings, Tab from the body reaches the toast or the dialog, never the app', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await raiseToast(page);
  await page.keyboard.press('Meta+Comma');
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await expect.poll(() => modalFocus(page, 'Settings')).toBe('dialog');

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const seen = new Set<string>();
  for (let press = 0; press < 6; press += 1) {
    seen.add(await tabWithin(page, { dialog: 'Settings', toast: true }));
  }
  // The toast was reachable at all, or this asserts nothing about it.
  expect(seen.has('toast')).toBe(true);
});
