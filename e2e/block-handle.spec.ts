import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from './fixtures.ts';
import { caretAtLineEnd } from './caret.ts';
import { createVault, expectFile, installHost, saveNow, sidebarSection } from './host.ts';

/*
 * A block's handle (#569), end to end in WebKit: hovering a block shows ⋮⋮
 * in its gutter without moving the text, typing hides it; dragging it moves
 * the block; its menu adds a block, duplicates one (a highlight as a plain
 * quote), and deletes a highlight by the note's own write, which leaves its
 * tombstone; the keys move a block, and one undo puts it back.
 */

const PLAN = ['# Garden plan', '', 'First line.', '', 'Second line.', '', 'Third line.', ''].join(
  '\n',
);

const marker = (anchor: Record<string, unknown>) =>
  `<!-- atlas:highlight ${JSON.stringify({ v: 1, mark: 'underline', color: 'pink', ...anchor })} -->`;

const TOMBSTONE =
  '<!-- atlas:highlight-removed {"v":1,"kind":"kindle","location":9,"annotationId":"A9","words":"3f2a"} -->';

const BRIGHTWATER = [
  '---',
  'type: literature',
  'kind: kindle',
  'title: "Brightwater"',
  'author: "Tobias Fenn"',
  '---',
  'My own paragraph.',
  '',
  '> The tide keeps its own hours.',
  `> ${marker({ kind: 'kindle', location: 41, locationEnd: 44, annotationId: 'A41' })}`,
  '>',
  '> Lit by Mara.',
  '',
  '^kd0041',
  '',
  TOMBSTONE,
  '',
  '> Gulls argue over nothing.',
  `> ${marker({ kind: 'kindle', location: 60, annotationId: 'A60' })}`,
  '',
  '^kd0060',
  '',
].join('\n');

async function openNote(page: Page, folder: string | null, name: string) {
  const vault = await createVault();
  await mkdir(join(vault.root, 'Library'), { recursive: true });
  await writeFile(join(vault.root, 'Garden plan.md'), PLAN);
  await writeFile(join(vault.root, 'Library/Brightwater.md'), BRIGHTWATER);
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  const tree = sidebarSection(page, 'userSpace');
  if (folder !== null) await tree.getByRole('treeitem', { name: folder }).click();
  await tree.getByRole('treeitem', { name, exact: true }).click();
  const note = page.getByRole('article', { name });
  await expect(note).toBeVisible();
  return { vault, editor: note.getByLabel('Note', { exact: true }) };
}

const handleOf = (page: Page) => page.locator('[data-block-handle]');

/** Points at the middle of `block`'s first line, as a person resting the mouse on it. */
async function hover(page: Page, block: Locator) {
  const box = await block.boundingBox();
  if (box === null) throw new Error('The block is not drawn.');
  await page.mouse.move(box.x + 20, box.y + 8);
  await page.mouse.move(box.x + 24, box.y + 9);
  await expect(handleOf(page)).toBeVisible();
}

/** Opens the menu of `block` from its handle. */
async function menuOf(page: Page, block: Locator) {
  await hover(page, block);
  await handleOf(page).click();
  return page.getByRole('menu', { name: 'Block' });
}

const line = (editor: Locator, words: string) => editor.locator('p', { hasText: words });

test('hovering a block shows its handle in the gutter, without moving the text; typing hides it', async ({
  page,
}) => {
  const { editor } = await openNote(page, null, 'Garden plan');
  const second = line(editor, 'Second line.');
  await expect(handleOf(page)).toBeHidden();
  const before = await second.boundingBox();
  await hover(page, second);
  const after = await second.boundingBox();
  expect(after).toEqual(before);
  const handle = await handleOf(page).boundingBox();
  if (handle === null || after === null) throw new Error('Not drawn.');
  // Left of the text, on its line.
  expect(handle.x + handle.width).toBeLessThanOrEqual(after.x);
  expect(handle.y).toBeGreaterThanOrEqual(after.y - 2);
  expect(handle.y + handle.height).toBeLessThanOrEqual(after.y + after.height + 2);
  // The caret is still the note's: the handle took no focus.
  await caretAtLineEnd(second);
  await hover(page, line(editor, 'Third line.'));
  // Any key, even one that changes nothing in the note, puts the handle away.
  await page.keyboard.press('ArrowLeft');
  await expect(handleOf(page)).toBeHidden();
  await hover(page, line(editor, 'Third line.'));
  await page.keyboard.type('!');
  await expect(handleOf(page)).toBeHidden();
  await expect(editor.locator('p').nth(1)).toHaveText('Second line!.');
});

test('dragging a block by its handle moves it, and the saved note has the new order', async ({
  page,
}) => {
  const { vault, editor } = await openNote(page, null, 'Garden plan');
  await hover(page, line(editor, 'Third line.'));
  await page.evaluate(() => {
    const handle = document.querySelector('[data-block-handle]');
    const first = [...document.querySelectorAll('.ProseMirror p')].find(
      (each) => each.textContent === 'First line.',
    );
    if (handle === null || first === undefined) throw new Error('Not drawn.');
    const box = first.getBoundingClientRect();
    const data = new DataTransfer();
    const init = { dataTransfer: data, bubbles: true, cancelable: true };
    handle.dispatchEvent(new DragEvent('dragstart', init));
    const at = { ...init, clientX: box.left + 4, clientY: box.top + 2 };
    first.dispatchEvent(new DragEvent('dragover', at));
    first.dispatchEvent(new DragEvent('drop', at));
    handle.dispatchEvent(new DragEvent('dragend', init));
  });
  await expect(editor.locator('p')).toHaveText(['Third line.', 'First line.', 'Second line.']);
  await saveNow(page);
  await expectFile(vault, 'Garden plan.md').toBe(
    ['# Garden plan', '', 'Third line.', '', 'First line.', '', 'Second line.', ''].join('\n'),
  );
});

test('Add block below puts an empty block under it, with the caret there to type', async ({
  page,
}) => {
  const { vault, editor } = await openNote(page, null, 'Garden plan');
  const menu = await menuOf(page, line(editor, 'First line.'));
  await menu.getByRole('menuitem', { name: /Add block below/ }).click();
  await page.keyboard.type('Typed under it.');
  await expect(editor.locator('p')).toHaveText([
    'First line.',
    'Typed under it.',
    'Second line.',
    'Third line.',
  ]);
  await saveNow(page);
  await expectFile(vault, 'Garden plan.md').toContain('First line.\n\nTyped under it.\n\nSecond');
});

test('the keys move a block up and down, and one undo puts it back', async ({ page }) => {
  const { vault, editor } = await openNote(page, null, 'Garden plan');
  await caretAtLineEnd(line(editor, 'Third line.'));
  await page.keyboard.press('ControlOrMeta+Shift+ArrowUp');
  await expect(editor.locator('p')).toHaveText(['First line.', 'Third line.', 'Second line.']);
  await page.keyboard.press('ControlOrMeta+Shift+ArrowUp');
  await expect(editor.locator('p')).toHaveText(['Third line.', 'First line.', 'Second line.']);
  await page.keyboard.press('ControlOrMeta+Shift+ArrowDown');
  await expect(editor.locator('p')).toHaveText(['First line.', 'Third line.', 'Second line.']);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(editor.locator('p')).toHaveText(['Third line.', 'First line.', 'Second line.']);
  await saveNow(page);
  await expectFile(vault, 'Garden plan.md').toBe(
    ['# Garden plan', '', 'Third line.', '', 'First line.', '', 'Second line.', ''].join('\n'),
  );
});

test('Duplicate on a highlight makes a plain quote: no marker, no id, the highlight kept', async ({
  page,
}) => {
  const { vault, editor } = await openNote(page, 'Library', 'Brightwater');
  const menu = await menuOf(page, editor.locator('[data-highlight-block="kd0041"]'));
  await menu.getByRole('menuitem', { name: /Duplicate/ }).click();
  await expect(
    editor.locator('pre.raw-block', { hasText: 'The tide keeps its own hours.' }),
  ).toHaveCount(1);
  await expect(editor.locator('[data-highlight-block="kd0041"]')).toHaveCount(1);
  await saveNow(page);
  await expectFile(vault, 'Library/Brightwater.md').toContain(
    '^kd0041\n\n> The tide keeps its own hours.\n>\n> Lit by Mara.\n',
  );
  const saved = await vault.read('Library/Brightwater.md');
  expect(saved.split('atlas:highlight {').length - 1).toBe(2);
  expect(saved.split('^kd0041').length - 1).toBe(1);
  expect(saved.split('atlas:highlight-removed').length - 1).toBe(1);
});

test("Delete on a highlight removes it by the note's write, which leaves its tombstone", async ({
  page,
}) => {
  const { vault, editor } = await openNote(page, 'Library', 'Brightwater');
  const menu = await menuOf(page, editor.locator('[data-highlight-block="kd0060"]'));
  await menu.getByRole('menuitem', { name: /Delete/ }).click();
  await expectFile(vault, 'Library/Brightwater.md').not.toContain('Gulls argue over nothing.');
  const saved = await vault.read('Library/Brightwater.md');
  expect(saved.split('atlas:highlight-removed').length - 1).toBe(2);
  expect(saved).toContain('"annotationId":"A60"');
  await expect(editor.locator('[data-highlight-block="kd0060"]')).toHaveCount(0);
  await expect(editor.locator('[data-highlight-block="kd0041"]')).toHaveCount(1);
});

test('⇧⌘↑ on the first block, where nothing can move, selects to the start as macOS does', async ({
  page,
}) => {
  const { editor } = await openNote(page, null, 'Garden plan');
  // The note's first block is its heading; "First line." is the second.
  await caretAtLineEnd(editor.locator('h1', { hasText: 'Garden plan' }));
  await page.keyboard.press('ControlOrMeta+Shift+ArrowUp');
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
    .toContain('Garden plan');
  await expect(editor.locator('h1, p')).toHaveText([
    'Garden plan',
    'First line.',
    'Second line.',
    'Third line.',
  ]);
});
