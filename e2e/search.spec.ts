import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost } from './host.ts';

async function openIndexedVault(page: Page) {
  const vault = await createVault();
  await vault.write('today.md', '# Today\n\nPlanning the quarterly review with the team.\n');
  await vault.write('recipes.md', '# Recipes\n\nSourdough needs a long cold proof.\n');
  await vault.mkdir('Notes');
  await vault.write('Notes/quarterly.md', '# Quarterly\n\nLinked from [[Today]].\n');
  await installHost(page, vault);

  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return vault;
}

test('the vault is indexed when it is opened', async ({ page }) => {
  await openIndexedVault(page);
  await expect(page.getByText('3 notes indexed')).toBeVisible();
});

test('search finds a note by a word in its body and opens it', async ({ page }) => {
  await openIndexedVault(page);

  await page.keyboard.down('Meta');
  await page.keyboard.press('k');
  await page.keyboard.up('Meta');

  const palette = page.getByRole('dialog', { name: 'Search notes' });
  await expect(palette).toBeVisible();

  await page.getByRole('searchbox', { name: 'Search the vault' }).fill('sourdough');
  const hit = palette.getByRole('option', { name: /Recipes/ });
  await expect(hit).toBeVisible();
  await expect(palette.locator('mark')).toContainText('Sourdough');

  await hit.click();
  await expect(page.getByRole('article', { name: 'recipes' })).toBeVisible();
});

test('a note is found under the name its page shows, never a heading in its body', async ({
  page,
}) => {
  // One title rule (U-09): the `title` property, else the filename — what the
  // page head shows. An ADR with no `title` is listed by its filename.
  const vault = await createVault();
  await vault.mkdir('adr');
  await vault.write(
    'adr/0002-e2e-runs-in-webkit.md',
    '# End-to-end tests drive WebKit\n\nWhy we do not use tauri-driver.\n',
  );
  await vault.write(
    'adr/0003-the-index.md',
    '---\ntitle: The index decides nothing\n---\n\n# Index\n\nRust stays thin, like tauri.\n',
  );
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();

  await page.keyboard.down('Meta');
  await page.keyboard.press('k');
  await page.keyboard.up('Meta');
  const palette = page.getByRole('dialog', { name: 'Search notes' });
  await page.getByRole('searchbox', { name: 'Search the vault' }).fill('tauri');

  const byFile = palette.getByRole('option').filter({ hasText: '0002-e2e-runs-in-webkit' });
  await expect(byFile).toHaveCount(1);
  await expect(byFile).not.toContainText('End-to-end tests drive WebKit');
  await expect(
    palette.getByRole('option').filter({ hasText: 'The index decides nothing' }),
  ).toHaveCount(1);

  // The page it opens is headed by the same name.
  await byFile.click();
  await expect(page.getByRole('article', { name: '0002-e2e-runs-in-webkit' })).toBeVisible();
});

test('search says so when nothing matches', async ({ page }) => {
  await openIndexedVault(page);

  await page.keyboard.down('Meta');
  await page.keyboard.press('k');
  await page.keyboard.up('Meta');
  await page.getByRole('searchbox', { name: 'Search the vault' }).fill('zzzznothing');

  await expect(page.getByText('Nothing matches.')).toBeVisible();
});

test('escape closes the search palette', async ({ page }) => {
  await openIndexedVault(page);

  await page.keyboard.down('Meta');
  await page.keyboard.press('k');
  await page.keyboard.up('Meta');
  await expect(page.getByRole('dialog', { name: 'Search notes' })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Search notes' })).toHaveCount(0);
});

test('backlinks come from the index', async ({ page }) => {
  await openIndexedVault(page);
  await page.getByRole('treeitem', { name: 'today', exact: true }).click();

  const panel = page.getByRole('region', { name: 'Links', exact: true });
  const toggle = panel.getByRole('button', { name: /^Links/ });
  await expect(toggle).toContainText('1 linked here');
  await toggle.click();
  await expect(panel.getByRole('button', { name: /quarterly/i })).toBeVisible();
});

test('rebuilding the index throws it away and puts it back', async ({ page }) => {
  const vault = await openIndexedVault(page);
  // Written behind the app's back: the stand-in host watches nothing, so only
  // a rebuild reading the files again can count or find this note.
  await vault.write('bread.md', '# Bread\n\nA crumb shot of the focaccia.\n');

  // Rebuild lives in Settings, beside the count, now that there is no status bar.
  await page
    .getByRole('navigation', { name: 'Vault' })
    .getByRole('button', { name: 'Settings' })
    .click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings.getByText('3 notes indexed')).toBeVisible();
  await settings.getByRole('button', { name: 'Rebuild' }).click();
  await expect(settings.getByText('4 notes indexed')).toBeVisible();
  await expect(settings.getByRole('button', { name: 'Rebuild' })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);

  // Search finds the note only the rebuild read, and still finds the old ones,
  // so nothing depended on the old database.
  await page.keyboard.down('Meta');
  await page.keyboard.press('k');
  await page.keyboard.up('Meta');
  const search = page.getByRole('searchbox', { name: 'Search the vault' });
  await search.fill('focaccia');
  await expect(page.getByRole('option', { name: /^bread / })).toBeVisible();
  await search.fill('sourdough');
  await expect(page.getByRole('option', { name: /Recipes/ })).toBeVisible();
});
