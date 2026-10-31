import { mkdir, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { expect, test, type Page } from './fixtures.ts';
import { caretAtLineStart } from './caret.ts';
import {
  createVault,
  emitVaultChanged,
  expectFile,
  installHost,
  saveNow,
  sidebarSection,
  type FakeVault,
} from './host.ts';

/*
 * Regressions found in PR #534 (#523), end to end in WebKit: what a person types in a
 * highlight's comment is theirs until it is written or put back with Escape;
 * a removed highlight's tombstone, hidden now, is not deleted by a key
 * pressed next to it; and the comment field is no way to change the note.
 */

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
  `> ${marker({ kind: 'kindle', location: 41, locationEnd: 44 })}`,
  '>',
  '> Lit by Mara.',
  '',
  '^kd0041',
  '',
  TOMBSTONE,
  '',
  'Prose after the removed one.',
  '',
].join('\n');

async function openBrightwater(page: Page): Promise<FakeVault> {
  const vault = await createVault();
  await mkdir(join(vault.root, 'Library'), { recursive: true });
  await writeFile(join(vault.root, 'Library/Brightwater.md'), BRIGHTWATER);
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await sidebarSection(page, 'userSpace').getByRole('treeitem', { name: 'Library' }).click();
  await sidebarSection(page, 'userSpace')
    .getByRole('treeitem', { name: 'Brightwater', exact: true })
    .click();
  await expect(page.getByRole('article', { name: 'Brightwater' })).toBeVisible();
  return vault;
}

const comment = (page: Page) =>
  page.getByRole('textbox', { name: 'Comment on this highlight' }).first();

test('a comment typed and then the tab closed with ⌘W is written, not lost', async ({ page }) => {
  const vault = await openBrightwater(page);
  await comment(page).click();
  await comment(page).fill('Typed, then the tab closed.');
  await page.keyboard.press('Meta+w');
  // The premise: the tab, and the field with it, is gone.
  await expect(page.getByRole('article', { name: 'Brightwater' })).toHaveCount(0);
  await expectFile(vault, 'Library/Brightwater.md').toContain('> Typed, then the tab closed.');
});

const SYNCED = BRIGHTWATER.replace('My own paragraph.', 'My own paragraph, synced.').replace(
  '> Lit by Mara.\n',
  // As Kindle sync adds the note typed on the Kindle to this highlight's comment.
  '> Lit by Mara.\n>\n> From the Kindle.\n',
);

test('a comment being typed survives the note being read again under it', async ({ page }) => {
  const vault = await openBrightwater(page);
  await comment(page).click();
  await comment(page).fill('Typed while the sync ran.');
  await vault.write('Library/Brightwater.md', SYNCED);
  await emitVaultChanged(page, ['Library/Brightwater.md']);
  // The premise: the pane has read the note again.
  await expect(
    page.getByRole('article', { name: 'Brightwater' }).getByText('My own paragraph, synced.'),
  ).toBeVisible();
  await expect(comment(page)).toHaveValue(/Typed while the sync ran\./);
});

test("a comment left before the pane hears of a sync keeps the sync's words", async ({ page }) => {
  const vault = await openBrightwater(page);
  await comment(page).click();
  await comment(page).fill('Typed while the sync ran.');
  // The sync has written; the watcher has not told the pane yet.
  await vault.write('Library/Brightwater.md', SYNCED);
  await page.keyboard.press('Tab');
  // Refused rather than written over (#534): the sync's words stay on disk exactly as they are,
  // and the field says what is there now.
  await expect(page.getByRole('alert').filter({ hasText: 'From the Kindle.' })).toBeVisible();
  expect(await vault.read('Library/Brightwater.md')).toBe(SYNCED);
});

test('a comment left over one that changed shows the new one and lets the person choose', async ({
  page,
}) => {
  const vault = await openBrightwater(page);
  await comment(page).click();
  await comment(page).fill('Typed while the sync ran.');
  await vault.write('Library/Brightwater.md', SYNCED);
  await page.keyboard.press('Tab');
  const notice = page.getByRole('alert').filter({ hasText: 'From the Kindle.' });
  await expect(notice).toBeVisible();
  await expect(comment(page)).toHaveValue('Typed while the sync ran.');
  // The sync's words are still on disk: nothing was written over them.
  expect(await vault.read('Library/Brightwater.md')).toContain('From the Kindle.');
  await notice.getByRole('button', { name: 'Use mine' }).click();
  await expectFile(vault, 'Library/Brightwater.md').toContain('> Typed while the sync ran.');
  expect(await vault.read('Library/Brightwater.md')).not.toContain('From the Kindle.');
});

test('a comment being typed keeps the focus when the note is read again under it', async ({
  page,
}) => {
  const vault = await openBrightwater(page);
  await comment(page).click();
  await comment(page).fill('Typed while the sync ran.');
  await vault.write('Library/Brightwater.md', SYNCED);
  await emitVaultChanged(page, ['Library/Brightwater.md']);
  await expect(
    page.getByRole('article', { name: 'Brightwater' }).getByText('My own paragraph, synced.'),
  ).toBeVisible();
  await expect(comment(page)).toBeFocused();
});

test('Backspace at the start of the prose after a hidden tombstone keeps the tombstone', async ({
  page,
}) => {
  const vault = await openBrightwater(page);
  const editor = page.getByRole('article', { name: 'Brightwater' }).getByLabel('Note', {
    exact: true,
  });
  await caretAtLineStart(editor.getByText('Prose after the removed one.'));
  await page.keyboard.press('Backspace');
  await page.keyboard.type('X');
  await saveNow(page);
  await expectFile(vault, 'Library/Brightwater.md').toContain('Prose after');
  expect(await vault.read('Library/Brightwater.md')).toContain(TOMBSTONE);
});

test('text dropped on a comment field does not land in the note', async ({ page }) => {
  const vault = await openBrightwater(page);
  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.setData('text/plain', 'Dropped words.');
    return data;
  });
  await comment(page).dispatchEvent('dragenter', { dataTransfer: transfer });
  await comment(page).dispatchEvent('dragover', { dataTransfer: transfer });
  await comment(page).dispatchEvent('drop', { dataTransfer: transfer });
  await saveNow(page);
  const editor = page.getByRole('article', { name: 'Brightwater' }).getByLabel('Note', {
    exact: true,
  });
  await expect(editor.locator('p', { hasText: 'Dropped words.' })).toHaveCount(0);
  expect(await vault.read('Library/Brightwater.md')).toBe(BRIGHTWATER);
});

test('a comment typed and not left is written to its vault before another opens, and not to that one', async ({
  page,
}) => {
  const first = await createVault();
  const second = await createVault();
  for (const vault of [first, second]) {
    await mkdir(join(vault.root, 'Library'), { recursive: true });
    await writeFile(join(vault.root, 'Library/Brightwater.md'), BRIGHTWATER);
  }
  const host = await installHost(page, first);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await sidebarSection(page, 'userSpace').getByRole('treeitem', { name: 'Library' }).click();
  await sidebarSection(page, 'userSpace')
    .getByRole('treeitem', { name: 'Brightwater', exact: true })
    .click();
  await comment(page).click();
  await comment(page).fill('Typed, then another vault.');
  await expect(comment(page)).toBeFocused();
  // Clicked without moving focus, so the field's own blur does not write it first.
  host.offer(second);
  const nameOf = (vault: FakeVault) => vault.root.split(sep).at(-1) ?? '';
  await page.getByRole('button', { name: nameOf(first), exact: true }).dispatchEvent('click');
  await page.getByRole('menuitem', { name: 'Open another folder…' }).dispatchEvent('click');
  await expect(page.getByRole('button', { name: nameOf(second), exact: true })).toBeVisible();
  await expectFile(first, 'Library/Brightwater.md').toContain('> Typed, then another vault.');
  expect(await first.read('Library/Brightwater.md')).not.toContain('Lit by Mara.');
  expect(await second.read('Library/Brightwater.md')).toBe(BRIGHTWATER);
});
