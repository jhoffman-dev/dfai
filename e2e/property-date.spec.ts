import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost } from './host.ts';
import { focusThenPress } from './typing.ts';

const TASK_TYPE = [
  '---',
  'name: task',
  'properties:',
  '  due: date',
  '  owner: text',
  '---',
  '',
].join('\n');

const NOTE = '---\ntype: task\ndue: 2026-09-22T14:30\nowner: Ada\n---\n\n# Ship\n';

async function openTask(page: Page) {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write('Ship.md', NOTE);

  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await page.getByRole('treeitem', { name: 'Ship', exact: true }).click();
  return { vault, panel: page.getByRole('region', { name: 'Properties' }) };
}

test('Backspace in a date-time field leaves the file as it was', async ({ page }) => {
  const { vault, panel } = await openTask(page);
  const due = panel.getByLabel('Due', { exact: true });
  await focusThenPress(due, 'Backspace');
  await page.keyboard.press('Backspace');
  await panel.getByLabel('Owner').click();

  // A write that does land, so the file is read after the field had its chance.
  await panel.getByLabel('Owner').fill('Grace');
  await expectFile(vault, 'Ship.md').toContain('owner: Grace');
  expect(await vault.read('Ship.md')).toContain('due: 2026-09-22T14:30');
});

test('Clear takes a date off the note', async ({ page }) => {
  const { vault, panel } = await openTask(page);
  await panel.getByRole('button', { name: 'Clear Due' }).click();
  await expectFile(vault, 'Ship.md').not.toContain('2026-09-22');
  await expect(panel.getByRole('button', { name: 'Clear Due' })).toHaveCount(0);
});
