import { expect, test } from './fixtures.ts';
import { createVault, expectSaved, installHost, saveNow } from './host.ts';
import { caretAtLineEnd } from './caret.ts';

// U-04: make the sidebar collapsible.
test('the sidebar hides and comes back', async ({ page }) => {
  const vault = await createVault();
  await vault.write('note.md', '# Note\n\nBody.\n');
  await installHost(page, vault);

  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByRole('navigation', { name: 'Vault' })).toBeVisible();

  await page.getByRole('button', { name: 'Hide sidebar' }).click();
  await expect(page.getByRole('navigation', { name: 'Vault' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Show sidebar' }).click();
  await expect(page.getByRole('navigation', { name: 'Vault' })).toBeVisible();
});

test('cmd+backslash toggles it too', async ({ page }) => {
  const vault = await createVault();
  await vault.write('note.md', '# Note\n');
  await installHost(page, vault);

  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByRole('navigation', { name: 'Vault' })).toBeVisible();

  await page.keyboard.down('Meta');
  await page.keyboard.press('\\');
  await page.keyboard.up('Meta');
  await expect(page.getByRole('navigation', { name: 'Vault' })).toHaveCount(0);

  await page.keyboard.down('Meta');
  await page.keyboard.press('\\');
  await page.keyboard.up('Meta');
  await expect(page.getByRole('navigation', { name: 'Vault' })).toBeVisible();
});

test('the note stays open and editable with the sidebar hidden', async ({ page }) => {
  const vault = await createVault();
  await vault.write('note.md', '# Note\n\nBody.\n');
  await installHost(page, vault);

  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await page.getByRole('treeitem', { name: 'note', exact: true }).click();
  await page.getByRole('button', { name: 'Hide sidebar' }).click();

  await caretAtLineEnd(page.getByText('Body.'));
  await page.keyboard.type(' Edited.');
  await saveNow(page);
  await expectSaved(page);

  expect(await vault.read('note.md')).toBe('# Note\n\nBody. Edited.\n');
});
