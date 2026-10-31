import { expect, test } from './fixtures.ts';
import { createVault, expectFile, expectSaved, installHost, saveNow } from './host.ts';

test('a new note is created, opened and saved to disk', async ({ page }) => {
  const vault = await createVault();
  await vault.write('existing.md', '# Existing\n');
  await installHost(page, vault);

  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await page.getByRole('button', { name: 'New note' }).click();
  await page.getByRole('menuitem', { name: 'Blank note' }).click();

  // It opens, ready to type into, named once at the top of its page and not
  // again by a heading in its body (U-09).
  await expect(page.getByRole('article', { name: 'Untitled', exact: true })).toBeVisible();
  await expect(page.getByLabel('Note', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Note', { exact: true }).getByRole('heading')).toHaveCount(0);
  // An empty file reads as '' too, so that it exists is checked first.
  await expect.poll(() => vault.exists('Untitled.md')).toBe(true);
  await expectFile(vault, 'Untitled.md').toBe('');

  // And it is in the tree beside the note that was already there.
  await expect(page.getByRole('treeitem', { name: 'Untitled', exact: true })).toBeVisible();
  await expect(page.getByRole('treeitem', { name: 'existing', exact: true })).toBeVisible();

  // Typing into it and saving writes the words through.
  await page.getByLabel('Note', { exact: true }).click();
  await page.keyboard.type('Something worth keeping.');
  await saveNow(page);
  await expectSaved(page);

  await expectFile(vault, 'Untitled.md').toBe('Something worth keeping.\n');
});

test('a second new note is numbered rather than refused', async ({ page }) => {
  const vault = await createVault();
  await installHost(page, vault);

  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();

  const button = page.getByRole('button', { name: 'New note' });
  await button.click();
  await page.getByRole('menuitem', { name: 'Blank note' }).click();
  await expect(page.getByRole('article', { name: 'Untitled', exact: true })).toBeVisible();

  await button.click();
  await page.getByRole('menuitem', { name: 'Blank note' }).click();
  await expect(page.getByRole('article', { name: 'Untitled 2' })).toBeVisible();

  // An empty file reads as '' too, so that it exists is checked first. Polled,
  // not read once: the host creates the file and then fills it, as the Rust one
  // does, so a single read can land between the two.
  await expect.poll(() => vault.exists('Untitled 2.md')).toBe(true);
  await expectFile(vault, 'Untitled 2.md').toBe('');
});

test('a new note is created beside the note in view', async ({ page }) => {
  const vault = await createVault();
  await vault.mkdir('Notes');
  await vault.write('Notes/today.md', '# Today\n');
  await installHost(page, vault);

  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await page.getByRole('treeitem').filter({ hasText: 'Notes' }).click();
  await page.getByRole('treeitem', { name: 'today', exact: true }).click();
  await expect(page.getByRole('article', { name: 'today' })).toBeVisible();

  await page.getByRole('button', { name: 'New note' }).click();
  await page.getByRole('menuitem', { name: 'Blank note' }).click();
  await expect(page.getByRole('article', { name: 'Untitled', exact: true })).toBeVisible();

  // An empty file reads as '' too, so that it exists is checked first.
  await expect.poll(() => vault.exists('Notes/Untitled.md')).toBe(true);
  await expectFile(vault, 'Notes/Untitled.md').toBe('');
});

test('the new note can be found by search straight away', async ({ page }) => {
  const vault = await createVault();
  await installHost(page, vault);

  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await page.getByRole('button', { name: 'New note' }).click();
  await page.getByRole('menuitem', { name: 'Blank note' }).click();
  await expect(page.getByRole('article', { name: 'Untitled', exact: true })).toBeVisible();

  await page.keyboard.down('Meta');
  await page.keyboard.press('k');
  await page.keyboard.up('Meta');
  await page.getByRole('searchbox', { name: 'Search the vault' }).fill('Untitled');

  await expect(page.getByRole('option', { name: /Untitled/ }).first()).toBeVisible();
});
