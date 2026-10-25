import { expect, test, type Locator, type Page } from './fixtures.ts';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { caretAtLineEnd } from './caret.ts';
import { createVault, installHost, sidebarSection } from './host.ts';

/*
 * Attack on PR #572 (#569), in WebKit: reaching the handle the way a person
 * moves a mouse (in steps, not a jump), what one undo takes back after Add
 * block below and typing, the ⇧⌘↑ key on the first block, and where focus
 * goes when the menu is dismissed. Fictional data only.
 */

const PLAN = ['# Garden plan', '', 'First line.', '', 'Second line.', '', 'Third line.', ''].join(
  '\n',
);

async function openPlan(page: Page) {
  const vault = await createVault();
  await writeFile(join(vault.root, 'Garden plan.md'), PLAN);
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await sidebarSection(page, 'userSpace')
    .getByRole('treeitem', { name: 'Garden plan', exact: true })
    .click();
  const note = page.getByRole('article', { name: 'Garden plan' });
  await expect(note).toBeVisible();
  return note.getByLabel('Note', { exact: true });
}

const handleOf = (page: Page) => page.locator('[data-block-handle]');
const line = (editor: Locator, words: string) => editor.locator('p', { hasText: words });

test('the handle can be reached by moving the mouse left to it in steps, and clicked', async ({
  page,
}) => {
  const editor = await openPlan(page);
  const box = await line(editor, 'Second line.').boundingBox();
  if (box === null) throw new Error('The block is not drawn.');
  await page.mouse.move(box.x + 40, box.y + 8);
  await page.mouse.move(box.x + 44, box.y + 9);
  await expect(handleOf(page)).toBeVisible();
  const handle = await handleOf(page).boundingBox();
  if (handle === null) throw new Error('The handle is not drawn.');
  // As a hand moves a mouse: a run of small moves through the gutter, not one jump.
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2, { steps: 12 });
  await expect(handleOf(page)).toBeVisible();
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.getByRole('menu', { name: 'Block' })).toBeVisible();
});

test('after Add block below and typing, one undo takes back the typing, the new block kept', async ({
  page,
}) => {
  const editor = await openPlan(page);
  await caretAtLineEnd(line(editor, 'First line.'));
  await page.keyboard.press('Alt+Enter');
  await page.keyboard.type('Typed under it.');
  await expect(editor.locator('p')).toHaveText([
    'First line.',
    'Typed under it.',
    'Second line.',
    'Third line.',
  ]);
  await page.keyboard.press('Meta+z');
  await expect(editor.locator('p')).toHaveText(['First line.', '', 'Second line.', 'Third line.']);
});

test('⇧⌘↑ on the first block selects to the start of the note, as macOS does', async ({ page }) => {
  const editor = await openPlan(page);
  await caretAtLineEnd(line(editor, 'First line.'));
  await page.keyboard.press('Meta+Shift+ArrowUp');
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(selected).toContain('First line.');
});

test('Esc on the block menu opened by ⌘/ puts the caret back in the note', async ({ page }) => {
  const editor = await openPlan(page);
  await caretAtLineEnd(line(editor, 'Second line.'));
  await page.keyboard.press('Meta+/');
  await expect(page.getByRole('menu', { name: 'Block' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu', { name: 'Block' })).toBeHidden();
  await expect(editor).toBeFocused();
  await page.keyboard.type('!');
  await expect(line(editor, 'Second line.!')).toBeVisible();
});
