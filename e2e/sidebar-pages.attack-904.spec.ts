import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost, sidebarSection } from './host.ts';

// Attack on #902 (PR #904), as a first run has it: Pages hidden. ⌘K's
// "Show Pages" remembers the choice but only flips the section; where the
// sidebar itself is off screen — hidden with ⌘\, or the closed drawer of a
// narrow window — the command does nothing a person can see.

const KEY = 'atlas.sidebar.hidden';

async function openVault(page: Page): Promise<void> {
  const vault = await createVault();
  await vault.write('Garden.md', '# Garden\n\nBeds and paths.\n');
  await installHost(page, vault, { sidebarAsFirstRun: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
}

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Vault' });
const pages = (page: Page) => sidebarSection(page, 'userSpace');

async function showPagesFromPalette(page: Page): Promise<void> {
  await page.keyboard.down('Meta');
  await page.keyboard.press('k');
  await page.keyboard.up('Meta');
  await page.getByRole('searchbox', { name: 'Search the vault' }).fill('Show Pages');
  const dialog = page.getByRole('dialog', { name: 'Search notes' });
  await dialog.getByRole('option', { name: 'Show Pages' }).click();
  await expect(dialog).toHaveCount(0);
  // The choice was taken: what follows is only whether anyone can see it.
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), KEY)).toBe('[]');
}

test('⌘K Show Pages with the sidebar hidden puts Pages on screen', async ({ page }) => {
  await openVault(page);
  await page.getByRole('button', { name: 'Hide sidebar' }).click();
  await expect(sidebar(page)).toBeHidden();

  await showPagesFromPalette(page);

  await expect(pages(page)).toBeVisible();
});

test('⌘K Show Pages in a 720px window, its drawer closed, puts Pages on screen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 720, height: 900 });
  await openVault(page);
  await expect(sidebar(page)).toBeHidden();

  await showPagesFromPalette(page);

  await expect(pages(page)).toBeVisible();
});
