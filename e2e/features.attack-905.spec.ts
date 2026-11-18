import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from './fixtures.ts';
import { createVault, emitVaultChanged, installHost, sidebarSection } from './host.ts';
import { lanternFixturePdf } from '../tools/pdf/fixture-pdf.ts';

/*
 * Attack on #905 (Settings → Features, Reading): entry points into Reading
 * still drawn once it is switched off.
 */

const PDF = 'Library/the-lantern-keepers.pdf';
const SETTINGS = '.atlas/settings.md';
const marker = JSON.stringify({
  v: 1,
  mark: 'highlight',
  color: 'yellow',
  kind: 'pdf',
  page: 3,
  exact: 'The last lamp was lit',
  prefix: 'Chapter Three. ',
  suffix: ' in the year',
  rects: [[0.2, 0.1, 0.3, 0.02]],
});
const LANTERN =
  `---\ntype: literature\nkind: pdf\ntitle: "The Lantern Keepers"\nfile: "[[${PDF}]]"\n---\n` +
  `> The last lamp was lit\n> <!-- atlas:highlight ${marker} -->\n\n^lamp03\n`;

async function openVault(page: Page, { readingOff = false } = {}) {
  const vault = await createVault();
  const files: Record<string, string | Buffer> = {
    [PDF]: lanternFixturePdf(),
    'Library/The Lantern Keepers.md': LANTERN,
  };
  if (readingOff) files[SETTINGS] = '---\nfeaturesOff: [reading]\n---\n';
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(vault.root, path, '..'), { recursive: true });
    await writeFile(join(vault.root, path), contents);
  }
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return vault;
}

async function openNote(page: Page, name: string) {
  await sidebarSection(page, 'userSpace').getByRole('treeitem', { name, exact: true }).click();
  await expect(page.getByRole('article', { name })).toBeVisible();
}

test('with Reading off, a literature note offers no Open in PDF on its highlights', async ({
  page,
}) => {
  await openVault(page, { readingOff: true });
  await page.getByRole('treeitem', { name: 'Library' }).click();
  await openNote(page, 'The Lantern Keepers');
  await expect(page.getByRole('article', { name: 'The Lantern Keepers' })).toContainText(
    'The last lamp was lit',
  );
  await expect(page.getByText(/Open in PDF|in the reader/)).toHaveCount(0);
});

test('Reading switched off on another device closes an open Add PDF dialog', async ({ page }) => {
  const vault = await openVault(page);
  await page.keyboard.press('Meta+k');
  await page.getByRole('searchbox', { name: 'Search the vault' }).fill('Add PDF…');
  await page.getByRole('option', { name: 'Add PDF…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add PDF to Library' });
  await expect(dialog).toBeVisible();

  await vault.mkdir('.atlas');
  await vault.write(SETTINGS, '---\nfeaturesOff: [reading]\n---\n');
  await emitVaultChanged(page, [SETTINGS]);
  await expect(
    page.getByRole('navigation', { name: 'Vault' }).getByRole('button', { name: 'Library' }),
  ).toHaveCount(0);
  await expect(dialog).toBeHidden();
});
