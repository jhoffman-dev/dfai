import { expect, test, type Page } from './fixtures.ts';
import { createVault, emitVaultChanged, expectSaved, installHost, saveNow } from './host.ts';
import { caretAtLineEnd } from './caret.ts';

async function openNote(page: Page) {
  const vault = await createVault();
  await vault.write('note.md', '# Note\n\nOriginal paragraph.\n');
  await vault.write('other.md', '# Other\n');
  await installHost(page, vault);

  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await page.getByRole('treeitem', { name: 'note', exact: true }).click();
  await expect(page.getByRole('article', { name: 'note' })).toBeVisible();
  return vault;
}

test('an edit still saves after the vault changes underneath', async ({ page }) => {
  const vault = await openNote(page);

  await caretAtLineEnd(page.getByText('Original paragraph.'));
  await page.keyboard.type(' Edited.');
  await expect(page.getByText('Unsaved')).toBeVisible();

  // Something else touches the vault — another app, a sync client, or the board
  // writing a task file while DFAI is open.
  await emitVaultChanged(page, ['other.md']);
  await page.waitForTimeout(300);

  await saveNow(page);
  await expectSaved(page);

  expect(await vault.read('note.md')).toBe('# Note\n\nOriginal paragraph. Edited.\n');
});

test('typing after the vault changes underneath still marks the note unsaved', async ({ page }) => {
  const vault = await openNote(page);

  await emitVaultChanged(page, ['other.md']);
  await page.waitForTimeout(300);

  await caretAtLineEnd(page.getByText('Original paragraph.'));
  await page.keyboard.type(' Typed later.');

  await expect(page.getByText('Unsaved')).toBeVisible();
  await saveNow(page);
  await expectSaved(page);

  expect(await vault.read('note.md')).toContain('Typed later.');
});

test('the watcher’s echo of an autosave still puts the save in the index (#254)', async ({
  page,
}) => {
  const vault = await createVault();
  await vault.write('note.md', '# Note\n\nOriginal paragraph.\n');
  const host = await installHost(page, vault, { echoWrites: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await page.getByRole('treeitem', { name: 'note', exact: true }).click();
  await expect(page.getByText(/^1 notes? indexed/)).toBeVisible();

  // A save refreshes nothing itself: the watcher's report of it is what the index hears.
  await caretAtLineEnd(page.getByText('Original paragraph.'));
  await page.keyboard.type(' Marmalade.');
  await saveNow(page);
  await expectSaved(page);
  await expect.poll(() => host.echoesSent()).toBeGreaterThan(0);

  await page.keyboard.press('Meta+k');
  const palette = page.getByRole('dialog', { name: 'Search notes' });
  const search = palette.getByRole('searchbox', { name: 'Search the vault' });
  await expect(async () => {
    await search.fill('');
    await search.fill('marmalade');
    await expect(palette.getByRole('option', { name: /note/ })).toBeVisible({ timeout: 1_000 });
  }).toPass();
});
