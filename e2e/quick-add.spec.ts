import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost } from './host.ts';

/**
 * The floating add button is retired (UI v2, Q5): a new task comes from the
 * view's "New task" and a capture from ⇧⌘N. Alt+⌘N, the button's shortcut,
 * is kept for the hands that know it, and opens capture.
 */

const TASK_TYPE = [
  '---',
  'name: task',
  'label: Task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [backlog, doing, done]',
  '---',
  '',
].join('\n');

/** Capture makes its task from the vault's Task template (P30-01). */
const TASK_TEMPLATE = ['---', 'type: task', 'status: backlog', '---', '', ''].join('\n');

async function openVault(page: Page) {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/templates');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write('.atlas/templates/Task.md', TASK_TEMPLATE);
  await vault.write('Garden.md', ['---', 'type: project', '---', '', 'Beds.', ''].join('\n'));

  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return vault;
}

test('Alt+Cmd+N opens capture, and what it captures is a task in the Inbox', async ({ page }) => {
  const vault = await openVault(page);
  await expect(page.locator('.fab, .fab__button')).toHaveCount(0);

  await page.keyboard.press('Alt+Meta+n');
  const capture = page.getByRole('dialog', { name: 'Capture a task' });
  await expect(capture).toBeVisible();
  await page.getByRole('textbox', { name: 'What needs doing' }).fill('Call the bank');
  await page.getByRole('textbox', { name: 'What needs doing' }).press('Enter');

  await expectFile(vault, 'Inbox/Call the bank.md').toContain('type: task');
  // Alt+Cmd+N is not also Cmd+N: no blank note was made beside it.
  await expect(page.getByRole('treeitem', { name: 'Untitled', exact: true })).toHaveCount(0);
});

// Capture lands in a vault's Inbox: with none open, both its keys say so, as
// the global shortcut does, and open nothing (attack-468).
for (const keys of ['Shift+Meta+n', 'Alt+Meta+n']) {
  test(`${keys} with no vault open opens no capture and says a vault is needed`, async ({
    page,
  }) => {
    await installHost(page, await createVault());
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Open a vault' })).toBeVisible();

    await page.keyboard.press(keys);

    await expect(page.getByText(/^Quick capture needs a vault/)).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Capture a task' })).toHaveCount(0);
  });
}
