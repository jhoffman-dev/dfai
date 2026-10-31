// `pnpm shots`: bookmarks. What the shots specs share, and why they assert
// nothing, is in kit.ts.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from '../../../e2e/fixtures.ts';
import type { Page } from '@playwright/test';
import { createVault, installHost, solidPng, type FakeVault } from '../../../e2e/host.ts';
import { THEME_KEY, openVault, useTheme, shoot } from './kit.ts';

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

/** A note with bookmarks (U-21): one with a picture and a summary, one archived, one missing. */
async function bookmarkVault(): Promise<FakeVault> {
  const vault = await createVault();
  await vault.mkdir('Trips');
  await vault.mkdir('Archive');
  await vault.write(
    'Summer.md',
    [
      '# Summer',
      '',
      'Where we are going, and what we still have to book. See [[Oslo]] for last year.',
      '',
      '[[Rome in May]] <!-- atlas:bookmark -->',
      '',
      '[[Oslo]] <!-- atlas:bookmark -->',
      '',
      '[[Lisbon]] <!-- atlas:bookmark -->',
      '',
    ].join('\n'),
  );
  await vault.write(
    'Trips/Rome in May.md',
    '---\ncover: rome.png\ndescription: Ten days, three cities and one very long lunch — the plan, the tickets and the list of places Julie wants to see.\n---\n\nThe body.\n',
  );
  await writeFile(join(vault.root, 'Trips', 'rome.png'), solidPng(320, 200, [214, 120, 64]));
  await vault.write('Archive/Oslo.md', '# Oslo\n\nCold, dark by four, and worth every minute.\n');
  return vault;
}

async function shootBookmarks(page: Page, theme: string): Promise<void> {
  await page.getByRole('treeitem', { name: 'Summer', exact: true }).click();
  const card = page.getByRole('group', { name: /^Bookmark: Rome in May/ });
  await card.waitFor({ timeout: 10_000 });
  await shoot(page, `bookmark-${theme}`);
  await card.hover();
  await card.getByRole('button', { name: /^Options for / }).click();
  await page.getByRole('menuitem', { name: 'Show as link' }).waitFor({ timeout: 5_000 });
  await shoot(page, `bookmark-menu-${theme}`);
  await page.keyboard.press('Escape');
  await page.locator('.editor p [data-wikilink="Oslo"]').hover();
  await page.getByRole('button', { name: 'Link options' }).last().click();
  await page.getByRole('menuitem', { name: 'Show as bookmark' }).waitFor({ timeout: 5_000 });
  await shoot(page, `link-menu-${theme}`);
  await page.keyboard.press('Escape');
}

for (const theme of ['light', 'dark'] as const) {
  test(`bookmark shots, ${theme}`, async ({ page }) => {
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
      key: THEME_KEY,
      value: theme,
    });
    const vault = await bookmarkVault();
    await installHost(page, vault);
    await page.goto('/');
    await openVault(page);
    await useTheme(page, theme);
    await shootBookmarks(page, theme);
  });
}
