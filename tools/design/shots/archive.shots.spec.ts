// `pnpm shots`: the Archive. What the shots specs share, and why they assert
// nothing, is in kit.ts.
import { test } from '../../../e2e/fixtures.ts';
import type { Page } from '@playwright/test';
import { installHost, sidebarSection } from '../../../e2e/host.ts';
import {
  THEME_KEY,
  prepareVault,
  openVault,
  useTheme,
  shoot,
  open,
  search,
  openBySearch,
} from './kit.ts';

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

/**
 * The Archive (U-22): a page's menu offering Archive, the Archive page after
 * two notes are put away, and search reaching them with Include archived. It
 * archives notes, so it runs on a vault of its own, after the other shots.
 */
async function shootArchive(page: Page, theme: string): Promise<void> {
  const archiveRow = sidebarSection(page, 'userSpace').getByRole('treeitem', { name: 'Archive' });
  if (!(await openBySearch(page, { words: 'Callouts carry a tint', name: /Specimen/ }))) return;
  await page.getByRole('button', { name: 'More' }).first().click();
  const archive = page.getByRole('menuitem', { name: /^Archive$/ });
  await archive.waitFor({ timeout: 5_000 });
  await shoot(page, `archive-action-${theme}`);
  await archive.click();
  await archiveRow.waitFor({ timeout: 10_000 });
  // A second note, archived from the palette, so the Archive lists more than one.
  if (await openBySearch(page, { words: 'board meeting September', name: /Q3 sales deck/ })) {
    const palette = await search(page, 'archive this');
    await open('archive command', [palette.getByRole('option', { name: /Archive this note/ })]);
  }

  await archiveRow.click();
  await page.getByRole('article', { name: 'Archive' }).getByRole('row').nth(1).waitFor();
  await shoot(page, `archive-view-${theme}`);

  const palette = await search(page, 'callout');
  await palette.getByRole('switch', { name: 'Include archived' }).click();
  await palette.getByRole('option', { name: /Specimen/ }).waitFor({ timeout: 10_000 });
  await shoot(page, `archive-search-${theme}`);
  await page.keyboard.press('Escape');
}

for (const theme of ['light', 'dark'] as const) {
  test(`archive shots, ${theme}`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
      key: THEME_KEY,
      value: theme,
    });
    const vault = await prepareVault();
    await installHost(page, vault);
    await page.goto('/');
    await openVault(page);
    await useTheme(page, theme);
    await shootArchive(page, theme);
  });
}
