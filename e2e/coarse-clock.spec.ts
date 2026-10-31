import { expect, test, type Page } from './fixtures.ts';
import { stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createVault,
  emitVaultChanged,
  expectFile,
  installHost,
  saveNow,
  type FakeVault,
} from './host.ts';
import { caretAtLineEnd } from './caret.ts';

/**
 * Another program's write on a disk whose clock is coarse (#245): HFS+ keeps
 * whole seconds, exFAT two, a network share whatever its server keeps. A write
 * within the tick of the version DFAI read leaves the time as it was, and a
 * write of the same length leaves the size too. Simulated by writing the same
 * number of bytes and setting the time back to the one the note had.
 */
/** The whole second every write lands in, as HFS+ keeps it. */
const TICK_SECONDS = 1_700_000_000;

async function writeInTheSameTick(vault: FakeVault, path: string, text: string): Promise<void> {
  const file = join(vault.root, path);
  const before = await stat(file);
  expect(text).toHaveLength(before.size);
  await vault.write(path, text);
  await utimes(file, TICK_SECONDS, TICK_SECONDS);
  expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
}

const NOTE = '# Note\n\nShip on Monday.\n';
const THEIRS = '# Note\n\nShip on Friday.\n';

async function openTheNote(page: Page): Promise<FakeVault> {
  const vault = await createVault();
  await vault.write('note.md', NOTE);
  await utimes(join(vault.root, 'note.md'), TICK_SECONDS, TICK_SECONDS);
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/^1 notes? indexed/)).toBeVisible();
  await page.getByRole('treeitem', { name: 'note', exact: true }).click();
  await expect(page.getByRole('article', { name: 'note' })).toBeVisible();
  return vault;
}

test('a save from a note another program rewrote in the same tick is refused, not written over it', async ({
  page,
}) => {
  const vault = await openTheNote(page);
  await writeInTheSameTick(vault, 'note.md', THEIRS);

  await caretAtLineEnd(page.getByText('Ship on Monday.'));
  await page.keyboard.type(' Typed here.');
  await saveNow(page);

  await expect(page.getByRole('alert')).toContainText('changed on disk');
  expect(await vault.read('note.md')).toBe(THEIRS);
});

test('a note another program rewrote in the same tick is found by its new words', async ({
  page,
}) => {
  const vault = await openTheNote(page);
  await writeInTheSameTick(vault, 'note.md', '# Note\n\nShip a kumquat.\n');
  await emitVaultChanged(page, ['note.md']);

  await page.keyboard.press('Meta+k');
  const palette = page.getByRole('dialog', { name: 'Search notes' });
  const search = palette.getByRole('searchbox', { name: 'Search the vault' });
  await expect(async () => {
    await search.fill('');
    await search.fill('kumquat');
    await expect(palette.getByRole('option', { name: /note/ })).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await expectFile(vault, 'note.md').toBe('# Note\n\nShip a kumquat.\n');
});
