import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectSaved, installHost, saveNow } from './host.ts';
import { caretAtLineEnd } from './caret.ts';

const NOTE = [
  '# Today',
  '',
  'A link to [[Another Note]] and some text.',
  '',
  '> [!warning] Be careful',
  '> This is a callout.',
  '',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
  '',
  '```ts',
  'const answer = 42;',
  '```',
  '',
].join('\n');

async function openVaultWith(page: Page) {
  const vault = await createVault();
  await vault.write('today.md', NOTE);
  await vault.write('Another Note.md', '# Another Note\n\nLinked from today.\n');
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  return vault;
}

test('a wiki link opens the note it names', async ({ page }) => {
  await openVaultWith(page);
  await page.getByRole('treeitem', { name: 'today', exact: true }).click();

  await page.getByRole('link', { name: 'Another Note' }).click();
  await expect(page.getByRole('article', { name: 'Another Note' })).toBeVisible();
  await expect(page.getByText('Linked from today.')).toBeVisible();
});

test('links, collapsed at the foot of a note, list the notes pointing here and from here', async ({
  page,
}) => {
  await openVaultWith(page);
  await page.getByRole('treeitem', { name: 'Another Note', exact: true }).click();

  const panel = page.getByRole('region', { name: 'Links', exact: true });
  const toggle = panel.getByRole('button', { name: /^Links/ });
  await expect(toggle).toContainText('1 linked here · 0 linked from here');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const here = panel.getByRole('region', { name: 'Links here' });
  await expect(here).toHaveCount(0);
  await toggle.click();
  await expect(here.getByRole('button', { name: /today/i })).toBeVisible();

  // And it goes the other way: the linking note lists the note it links to.
  await page.getByRole('treeitem', { name: 'today', exact: true }).click();
  await expect(page.getByRole('article', { name: 'today' })).toBeVisible();
  await expect(toggle).toContainText('0 linked here · 1 linked from here');
});

test('a callout renders with its kind and title', async ({ page }) => {
  await openVaultWith(page);
  await page.getByRole('treeitem', { name: 'today', exact: true }).click();

  const callout = page.locator('.callout[data-callout="warning"]');
  await expect(callout).toBeVisible();
  await expect(callout.locator('.callout__title')).toHaveText('Be careful');
  await expect(callout).toContainText('This is a callout.');
  // A hairline card with a 4px radius, not a filled block (UI v2 slice 13h).
  await expect(callout).toHaveCSS('border-top-width', '1px');
  await expect(callout).toHaveCSS('border-radius', '4px');
});

test('a table is a hairline card and inline code sits on its own ground', async ({ page }) => {
  const vault = await openVaultWith(page);
  await vault.write('code.md', 'Inline `code` here.\n');
  await page.getByRole('treeitem', { name: 'today', exact: true }).click();

  const table = page.locator('.editor .tableWrapper');
  await expect(table).toBeVisible();
  await expect(table).toHaveCSS('border-top-width', '1px');
  await expect(table).toHaveCSS('border-radius', '4px');

  await page.getByRole('treeitem', { name: 'code', exact: true }).click();
  const code = page.locator('.editor code');
  await expect(code).toHaveText('code');
  // 12.5 mono on the code ground, radius 4 (the brief, §6).
  await expect(code).toHaveCSS('font-size', '12.5px');
  await expect(code).toHaveCSS('border-radius', '4px');
  await expect(code).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
});

test('a table is a real table, not a block of source', async ({ page }) => {
  await openVaultWith(page);
  await page.getByRole('treeitem', { name: 'today', exact: true }).click();

  await expect(page.locator('.editor table')).toBeVisible();
  await expect(page.locator('.editor th').first()).toHaveText('a');
  await expect(page.locator('.raw-block')).toHaveCount(0);
});

test('code is highlighted', async ({ page }) => {
  await openVaultWith(page);
  await page.getByRole('treeitem', { name: 'today', exact: true }).click();

  await expect(page.locator('.editor pre code .hljs-keyword').first()).toBeVisible();
  // A code block's text is the block's 12px, not the inline atom's 12.5px.
  await expect(page.locator('.editor pre code').first()).toHaveCSS('font-size', '12px');
});

test('typing [[ offers notes and inserts a link', async ({ page }) => {
  const vault = await openVaultWith(page);
  await page.getByRole('treeitem', { name: 'today', exact: true }).click();

  await caretAtLineEnd(page.getByText('A link to'));
  await page.keyboard.type(' [[Anot');

  const popup = page.getByRole('listbox', { name: 'Link to note' });
  await expect(popup).toBeVisible();
  const option = popup.getByRole('option', { name: /Another Note/ });
  await expect(option).toBeVisible();
  // The hint says where the note lives, as the search palette does, not its filename.
  await expect(option).toContainText('Pages');
  await expect(option).not.toContainText('.md');

  await page.keyboard.press('Enter');
  await saveNow(page);
  await expectSaved(page);

  // The fixture already links Another Note, so the check is on the one typed.
  expect(await vault.read('today.md')).toContain('and some text. [[Another Note]]');
});

test('typing / offers blocks to insert', async ({ page }) => {
  await openVaultWith(page);
  await page.getByRole('treeitem', { name: 'today', exact: true }).click();

  await caretAtLineEnd(page.getByText('A link to'));
  await page.keyboard.press('Enter');
  await page.keyboard.type('/quote');

  const popup = page.getByRole('listbox', { name: 'Insert block' });
  await expect(popup).toBeVisible();
  await expect(popup.getByRole('option', { name: /Quote/ })).toBeVisible();
  // A popover with 36px rows (UI v2 slice 13h).
  await expect(popup).toHaveCSS('border-radius', '8px');
  await expect(popup).not.toHaveCSS('box-shadow', 'none');
  await expect(async () => {
    const row = await popup.getByRole('option', { name: /Quote/ }).boundingBox();
    expect(row?.height).toBe(36);
  }).toPass();

  await page.keyboard.press('Enter');
  await expect(page.locator('.editor blockquote')).toBeVisible();
});

test('editing leaves the table and callout byte-identical', async ({ page }) => {
  const vault = await openVaultWith(page);
  await page.getByRole('treeitem', { name: 'today', exact: true }).click();

  await caretAtLineEnd(page.getByText('A link to'));
  await page.keyboard.type(' Edited.');
  await saveNow(page);
  await expectSaved(page);

  const saved = await vault.read('today.md');
  expect(saved).toContain('| a | b |\n| - | - |\n| 1 | 2 |');
  expect(saved).toContain('> [!warning] Be careful\n> This is a callout.');
  expect(saved).toContain('```ts\nconst answer = 42;\n```');
  expect(saved).toContain('A link to [[Another Note]] and some text. Edited.');
});
