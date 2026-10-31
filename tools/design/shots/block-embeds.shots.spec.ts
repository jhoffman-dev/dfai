// `pnpm shots`: block embeds. What the shots specs share, and why they assert
// nothing, is in kit.ts.
import { test } from '../../../e2e/fixtures.ts';
import type { Page } from '@playwright/test';
import { createVault, installHost, type FakeVault } from '../../../e2e/host.ts';
import { THEME_KEY, SETTLE_MS, openVault, useTheme, shoot } from './kit.ts';

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

/** A note showing blocks of another (P26): live ones, an archived one, and one whose block is gone. */
async function blockEmbedVault(): Promise<FakeVault> {
  const vault = await createVault();
  await vault.mkdir('Archive');
  await vault.write(
    'Trip plan.md',
    [
      '# Trip plan',
      '',
      'Ten days, three cities, and one very long lunch in Rome. ^lunch1',
      '',
      '## Packing',
      '',
      '- [ ] Pack the tent and the pegs ^tent01',
      '- [x] Book the night train to Vienna',
      '- [ ] Ask Julie about the museums she wants to see',
      '',
      '> [!note] Tickets',
      '> Print them — the station machines only take cards.',
      '',
    ].join('\n'),
  );
  await vault.write(
    'Archive/Last summer.md',
    '# Last summer\n\nCold, dark by four, and worth it. ^cold01\n',
  );
  await vault.write(
    'Journal.md',
    [
      '# Journal',
      '',
      'What we settled on today:',
      '',
      '![[Trip plan#^lunch1]]',
      '',
      '![[Trip plan#^tent01]]',
      '',
      '![[Last summer#^cold01]]',
      '',
      '![[Trip plan#^gone99]]',
      '',
      '',
    ].join('\n'),
  );
  return vault;
}

async function shootBlockEmbeds(page: Page, theme: string): Promise<void> {
  await page.getByRole('treeitem', { name: 'Journal', exact: true }).click();
  const shown = page.getByRole('group', { name: 'Embedded block from Trip plan' }).first();
  await shown.getByLabel('Embedded block', { exact: true }).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(SETTLE_MS);
  await shoot(page, `block-embed-${theme}`);
  // The picker: `![[`, a note, then its headings and blocks.
  await page.getByLabel('Note', { exact: true }).getByText('What we settled on today:').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('![[Trip');
  await page.getByRole('listbox', { name: 'Link to note' }).waitFor({ timeout: 5_000 });
  await page.keyboard.press('Enter');
  await page.getByRole('listbox', { name: 'Link to block' }).waitFor({ timeout: 5_000 });
  await shoot(page, `block-picker-${theme}`);
  await page.keyboard.press('Escape');
}

for (const theme of ['light', 'dark'] as const) {
  test(`block embed shots, ${theme}`, async ({ page }) => {
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
      key: THEME_KEY,
      value: theme,
    });
    const vault = await blockEmbedVault();
    await installHost(page, vault);
    await page.goto('/');
    await openVault(page);
    await useTheme(page, theme);
    await shootBlockEmbeds(page, theme);
  });
}
