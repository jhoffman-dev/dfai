import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from './fixtures.ts';
import {
  createVault,
  emitVaultChanged,
  expectFile,
  expectSaved,
  installHost,
  saveNow,
  solidPng,
  type FakeVault,
} from './host.ts';
import { caretAtLineEnd, caretAtLineStart } from './caret.ts';

/**
 * Bookmarks (U-21, P22): a link can be shown as a card with the page's
 * picture, title and summary, and back again. In the file a bookmark is the
 * link alone on its line with a comment Obsidian hides (ADR-0020).
 */

const MARKER = '<!-- atlas:bookmark -->';
const COVER = solidPng(32, 20, [40, 110, 200]);

async function openVault(
  page: Page,
  plans = '# Plans\n\nThe summer, roughly.\n\nPacking list.\n',
): Promise<FakeVault> {
  const vault = await createVault();
  await vault.write('Plans.md', plans);
  await vault.mkdir('Trips');
  await vault.mkdir('Archive');
  await vault.write(
    'Trips/Rome.md',
    '---\ncover: rome.png\ndescription: Ten days, three cities, one very long lunch.\n---\n# Rome\n\nThe body.\n',
  );
  await writeFile(join(vault.root, 'Trips', 'rome.png'), COVER);
  await vault.write('Archive/Oslo.md', '# Oslo\n\nCold, and worth it.\n');
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  return vault;
}

async function openPlans(page: Page) {
  await page.getByRole('treeitem', { name: 'Plans', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Plans' })).toBeVisible();
}

test('a link switched to a bookmark shows the page, is saved with its marker, and switches back', async ({
  page,
}) => {
  const vault = await openVault(page);
  await openPlans(page);

  // A link, typed as ever.
  await caretAtLineEnd(page.getByText('The summer, roughly.'));
  await page.keyboard.type(' [[Rom');
  await page
    .getByRole('listbox', { name: 'Link to note' })
    .getByRole('option', { name: /Rome/ })
    .waitFor();
  await page.keyboard.press('Enter');
  await saveNow(page);
  await expectSaved(page);
  await expectFile(vault, 'Plans.md').toContain('The summer, roughly. [[Rome]]\n');

  // Its "…", under the pointer, switches it to a card.
  await page.locator('.editor [data-wikilink="Rome"]').hover();
  await page.getByRole('button', { name: 'Link options' }).click();
  // The menu hangs from the link, not from a corner of the window.
  const linkBox = await page.locator('.editor [data-wikilink="Rome"]').boundingBox();
  const menuBox = await page.getByRole('menu', { name: 'Link' }).boundingBox();
  expect(Math.abs((menuBox?.x ?? 0) - (linkBox?.x ?? -999))).toBeLessThan(40);
  expect(Math.abs((menuBox?.y ?? 0) - ((linkBox?.y ?? 0) + (linkBox?.height ?? 0)))).toBeLessThan(
    40,
  );
  await page.getByRole('menuitem', { name: 'Show as bookmark' }).click();

  const card = page.getByRole('group', { name: 'Bookmark: Rome' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('Ten days, three cities, one very long lunch.');
  await expect(card).toContainText('Trips');
  await expect(card.locator('img.bookmark__img')).toHaveJSProperty('complete', true);
  expect(
    await card.locator('img.bookmark__img').evaluate((img: HTMLImageElement) => img.naturalWidth),
  ).toBe(32);

  await saveNow(page);
  await expectSaved(page);
  // The sentence is split round the card; the heading and the paragraph after keep their bytes.
  await expectFile(vault, 'Plans.md').toBe(
    `# Plans\n\nThe summer, roughly.\n\n[[Rome]] ${MARKER}\n\nPacking list.\n`,
  );

  // Read again from the file, it is still a card.
  await page.reload();
  await openPlans(page);
  await expect(card).toBeVisible();
  await expect(card).toContainText('Ten days, three cities');

  // And from its own "…", back to a link.
  await card.hover();
  await card.getByRole('button', { name: 'Options for Rome' }).click();
  await page.getByRole('menuitem', { name: 'Show as link' }).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator('.editor [data-wikilink="Rome"]')).toBeVisible();
  await saveNow(page);
  await expectSaved(page);
  await expectFile(vault, 'Plans.md').toBe(
    '# Plans\n\nThe summer, roughly.\n\n[[Rome]]\n\nPacking list.\n',
  );
});

test('a card opens its note by a click or Mod+Enter; Enter starts a line after it', async ({
  page,
}) => {
  const vault = await openVault(page, `# Plans\n\n[[Rome]] ${MARKER}\n\nPacking list.\n`);
  await openPlans(page);

  // A click peeks the card's note (slice 6b), as a click on a link does.
  await page.getByRole('group', { name: 'Bookmark: Rome' }).click();
  await expect(page.getByRole('dialog', { name: 'Rome' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.peek')).toHaveCount(0);

  await openPlans(page);
  // From the keyboard: up from the paragraph below selects the card.
  await caretAtLineStart(page.getByText('Packing list.'));
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.bookmark--selected')).toBeVisible();
  // Enter does what it does after any block: a new line, ready to type.
  await page.keyboard.press('Enter');
  await page.keyboard.type('Also Naples.');
  await saveNow(page);
  await expectSaved(page);
  await expectFile(vault, 'Plans.md').toBe(
    `# Plans\n\n[[Rome]] ${MARKER}\n\nAlso Naples.\n\nPacking list.\n`,
  );
  await expect(page.getByRole('article', { name: 'Plans' })).toBeVisible();

  // Mod+Enter opens it.
  await caretAtLineStart(page.getByText('Also Naples.'));
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.bookmark--selected')).toBeVisible();
  await page.keyboard.press('Meta+Enter');
  await expect(page.getByRole('article', { name: 'Rome' })).toBeVisible();
});

test('a card is a hairline card at rest and wears the focus ring once selected', async ({
  page,
}) => {
  await openVault(page, `# Plans\n\n[[Rome]] ${MARKER}\n\nPacking list.\n`);
  await openPlans(page);

  const card = page.getByRole('group', { name: 'Bookmark: Rome' });
  await expect(card).toBeVisible();
  // No shadow on content (the brief, §3): a 1px line and a 4px radius.
  await expect(card).toHaveCSS('box-shadow', 'none');
  await expect(card).toHaveCSS('border-top-width', '1px');
  await expect(card).toHaveCSS('border-radius', '4px');

  await caretAtLineStart(page.getByText('Packing list.'));
  await page.keyboard.press('ArrowUp');
  await expect(card).toHaveClass(/bookmark--selected/);
  await expect(card).not.toHaveCSS('box-shadow', 'none');
});

test('a card shows what its note says after that note changes', async ({ page }) => {
  const vault = await openVault(page, `# Plans\n\n[[Rome]] ${MARKER}\n\nPacking list.\n`);
  await openPlans(page);
  const card = page.getByRole('group', { name: 'Bookmark: Rome' });
  await expect(card).toContainText('Ten days, three cities');

  await vault.write('Trips/Rome.md', '---\ndescription: Two weeks, one city.\n---\n# Rome\n');
  await emitVaultChanged(page, ['Trips/Rome.md']);
  await expect(card).toContainText('Two weeks, one city.');
  // Each card is named for its own "…".
  await card.hover();
  await expect(card.getByRole('button', { name: 'Options for Rome' })).toBeVisible();
});

test('a card says when its note is missing, or archived', async ({ page }) => {
  await openVault(page, `# Plans\n\n[[Paris]] ${MARKER}\n\n[[Oslo]] ${MARKER}\n`);
  await openPlans(page);

  const missing = page.getByRole('group', { name: 'Bookmark: Paris' });
  await expect(missing).toContainText('No note is called “Paris”');
  await expect(missing).toHaveClass(/bookmark--missing/);

  const archived = page.getByRole('group', { name: 'Bookmark: Oslo' });
  await expect(archived).toContainText('Archived');
  await expect(archived).toContainText('Cold, and worth it.');
});

test('Shift+Enter in the [[ list puts the link in as a bookmark', async ({ page }) => {
  const vault = await openVault(page);
  await openPlans(page);

  await caretAtLineEnd(page.getByText('Packing list.'));
  await page.keyboard.press('Enter');
  await page.keyboard.type('[[Rom');
  const list = page.getByRole('listbox', { name: 'Link to note' });
  await expect(list).toContainText('Bookmark');
  await list.getByRole('option', { name: /Rome/ }).waitFor();
  await page.keyboard.press('Shift+Enter');

  await expect(page.getByRole('group', { name: 'Bookmark: Rome' })).toBeVisible();
  await saveNow(page);
  await expectSaved(page);
  await expectFile(vault, 'Plans.md').toBe(
    `# Plans\n\nThe summer, roughly.\n\nPacking list.\n\n[[Rome]] ${MARKER}\n`,
  );
});
