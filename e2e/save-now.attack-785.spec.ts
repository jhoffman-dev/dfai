import { expect, test } from './fixtures.ts';
import { caretAtLineEnd } from './caret.ts';
import {
  createVault,
  expectFile,
  expectSaved,
  installHost,
  saveNow,
  sidebarSection,
  splitWindow,
} from './host.ts';

/*
 * #785: `saveNow` found Save now enabled, then the autosave began before its
 * press landed. The press reached a disabled item, which rightly does nothing,
 * so the menu stayed open. The next "More" press then closed that menu instead
 * of opening one, and `splitWindow` waited 30s for an item that was gone.
 *
 * The race is made certain here: a save begins the moment the pointer goes
 * down on Save now, as the autosave did on the slow runner. Fictional data only.
 */

test('Save now pressed as the autosave begins leaves the menu closed and the note saved', async ({
  page,
}) => {
  const vault = await createVault();
  await vault.write('Journal.md', '# Journal\n\nToday.\n');
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await sidebarSection(page, 'userSpace')
    .getByRole('treeitem', { name: 'Journal', exact: true })
    .click();
  await caretAtLineEnd(page.getByLabel('Note', { exact: true }).getByText('Today.'));
  await page.keyboard.type(' Rain.');

  // A pointerdown is a discrete event, so React commits the save it starts
  // before the click follows: Save now is disabled by the time it is pressed.
  await page.evaluate(() => {
    const startSave = (event: Event) => {
      const item = (event.target as Element | null)?.closest('[role="menuitem"]');
      if (item?.textContent?.startsWith('Save now') !== true) return;
      window.removeEventListener('pointerdown', startSave, true);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true }));
    };
    window.addEventListener('pointerdown', startSave, true);
  });

  await saveNow(page);
  await expect(page.getByRole('menu', { name: 'Page' })).toBeHidden({ timeout: 2_000 });
  await expectSaved(page);
  await expectFile(vault, 'Journal.md').toBe('# Journal\n\nToday. Rain.\n');

  // What block-embeds.spec.ts did next, and timed out on.
  await splitWindow(page);
  await expect(page.getByRole('region', { name: 'Pane 2' })).toBeVisible();
});
