import { expect, test } from './fixtures.ts';
import { caretAtLineEnd } from './caret.ts';
import { createVault, expectFile, installHost, sidebarSection } from './host.ts';

/**
 * The caret in a note outlives a modal over it (#827, #848). The app goes
 * inert behind an open dialog, and WebKit drops the selection inside an inert
 * element: without the shell putting it back, the focus returned to the
 * editor with the caret at the top of the note.
 */
test('the caret mid-paragraph is where typing lands after Settings opens and closes', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const vault = await createVault();
  await vault.mkdir('Notes');
  await vault.write('Notes/today.md', '# Today\n\nFirst paragraph here.\n');
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await sidebarSection(page, 'userSpace').getByRole('treeitem', { name: 'Notes' }).click();
  await sidebarSection(page, 'userSpace')
    .getByRole('treeitem', { name: 'today', exact: true })
    .click();
  const note = page.getByRole('article', { name: 'today' });
  await expect(note).toBeVisible();

  await caretAtLineEnd(note.getByText('First paragraph here.'));
  for (let step = 0; step < ' here.'.length; step += 1) await page.keyboard.press('ArrowLeft');

  await page.keyboard.press('Meta+Comma');
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);

  await page.keyboard.type(' still');
  await expectFile(vault, 'Notes/today.md').toContain('First paragraph still here.');
});
