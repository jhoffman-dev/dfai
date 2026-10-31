import { expect, test } from './fixtures.ts';
import { createVault, expectFile, expectSaved, installHost, saveNow, saveStatus } from './host.ts';
import { caretAtLineEnd } from './caret.ts';

const NOTE = [
  '---',
  'title: Today',
  'tags: [daily]',
  '---',
  '',
  '# Today',
  '',
  'First paragraph.',
  '',
  '* star bullet',
  '* second bullet',
  '',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
  '',
].join('\n');

test('editing one paragraph rewrites that paragraph and nothing else', async ({ page }) => {
  const vault = await createVault();
  await vault.write('today.md', NOTE);
  await installHost(page, vault);

  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await page.getByRole('treeitem', { name: 'today', exact: true }).click();

  // The body is editable; the frontmatter is not shown at all.
  await expect(
    page.getByLabel('Note', { exact: true }).getByRole('heading', { name: 'Today', level: 1 }),
  ).toBeVisible();
  await expect(page.getByText('title: Today')).toHaveCount(0);
  await expectSaved(page);

  await caretAtLineEnd(page.getByText('First paragraph.'));
  await page.keyboard.type(' Edited.');

  await expect(page.getByText('Unsaved')).toBeVisible();
  await saveNow(page);
  await expectSaved(page);

  const saved = await vault.read('today.md');
  expect(saved).toBe(NOTE.replace('First paragraph.', 'First paragraph. Edited.'));
});

test('Cmd+S saves, with no Save button on the page', async ({ page }) => {
  const vault = await createVault();
  await vault.write('today.md', NOTE);
  await installHost(page, vault);

  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await page.getByRole('treeitem', { name: 'today', exact: true }).click();
  await expectSaved(page);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);

  await caretAtLineEnd(page.getByText('First paragraph.'));
  await page.keyboard.type(' Keyed.');
  await expect(saveStatus(page)).toHaveText('Unsaved');
  await page.keyboard.press('ControlOrMeta+s');

  await expectSaved(page);
  await expectFile(vault, 'today.md').toContain('First paragraph. Keyed.');
});

test('a note saved without being edited keeps every byte', async ({ page }) => {
  const vault = await createVault();
  await vault.write('today.md', NOTE);
  await installHost(page, vault);

  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await page.getByRole('treeitem', { name: 'today', exact: true }).click();
  await expect(
    page.getByLabel('Note', { exact: true }).getByRole('heading', { name: 'Today', level: 1 }),
  ).toBeVisible();

  // Put the cursor in the document and take it straight out again.
  await page.getByText('First paragraph.').click();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.down('Meta');
  await page.keyboard.press('s');
  await page.keyboard.up('Meta');

  // Polled, not read once: the save writes a temporary file and renames it over
  // this one, and a single read that lands inside that window sees no file at
  // all — which the vault stand-in reports as empty rather than throwing.
  await expectFile(vault, 'today.md').toBe(NOTE);
});

test('markdown shortcuts work while typing', async ({ page }) => {
  const vault = await createVault();
  await vault.write('empty.md', 'start\n');
  await installHost(page, vault);

  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await page.getByRole('treeitem', { name: 'empty', exact: true }).click();

  await caretAtLineEnd(page.getByText('start'));
  await page.keyboard.press('Enter');
  await page.keyboard.type('## A heading');
  await expect(page.getByRole('heading', { name: 'A heading', level: 2 })).toBeVisible();

  await saveNow(page);
  await expectSaved(page);
  expect(await vault.read('empty.md')).toBe('start\n\n## A heading\n');
});

test('a table survives an edit elsewhere in the note', async ({ page }) => {
  const vault = await createVault();
  await vault.write('today.md', NOTE);
  await installHost(page, vault);

  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await page.getByRole('treeitem', { name: 'today', exact: true }).click();

  // Since Phase 3 the table is a real table rather than a block of source.
  await expect(page.locator('.editor table')).toBeVisible();

  await caretAtLineEnd(page.getByText('First paragraph.'));
  await page.keyboard.type('!');
  await saveNow(page);
  await expectSaved(page);

  // The whole note, so the edit is seen to land as well as the table to survive.
  expect(await vault.read('today.md')).toBe(NOTE.replace('First paragraph.', 'First paragraph.!'));
});
