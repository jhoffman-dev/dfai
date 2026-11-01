import { expect, test } from './fixtures.ts';
import { createVault, expectFile, expectSaved, installHost, saveNow } from './host.ts';
import { caretAtLineEnd } from './caret.ts';

// #727: a pane that leaves a note with unsaved typing and comes straight back
// before the write on the way out has landed. The read on the way back must not
// show the text from before that write, or the next save is refused for the
// pane's own bytes and "Keep mine" writes the stale screen over the typing.
test('typing, switching away and back before the save lands, and typing on loses nothing', async ({
  page,
}) => {
  const vault = await createVault();
  await vault.write('one.md', '# One\n\nFirst note.\n');
  await vault.write('two.md', '# Two\n\nSecond note.\n');
  const host = await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();

  await page.getByRole('treeitem', { name: 'one', exact: true }).click();
  await caretAtLineEnd(page.getByText('First note.'));
  await page.keyboard.type(' Edited.');
  await expect(page.getByText('Unsaved')).toBeVisible();

  // The save on the way out is held, so the way back is begun before it lands.
  const release = host.holdWrites('one.md');
  await page.getByRole('treeitem', { name: 'two', exact: true }).click();
  await expect(page.getByRole('article', { name: 'two' })).toBeVisible();
  await page.getByRole('treeitem', { name: 'one', exact: true }).click();
  release();
  await expectFile(vault, 'one.md').toBe('# One\n\nFirst note. Edited.\n');

  await expect(page.getByText('First note. Edited.')).toBeVisible();
  await caretAtLineEnd(page.getByText(/^First note\./));
  await page.keyboard.type(' More.');
  await saveNow(page);
  await expectSaved(page);
  await expect(page.getByText(/changed on disk/)).toHaveCount(0);
  await expectFile(vault, 'one.md').toBe('# One\n\nFirst note. Edited. More.\n');
});
