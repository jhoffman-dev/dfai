import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from './fixtures.ts';
import {
  createVault,
  expectFile,
  installHost,
  sidebarSection,
  type FakeVault,
  splitWindow,
  closePane,
} from './host.ts';
import { caretAtLineEnd } from './caret.ts';

/**
 * R13-11: work a closing pane could not save survives quitting the app.
 *
 * A reload stands in for the quit — it is the closest a browser test gets. The
 * work is stranded the way it is in use: a pane's save is refused because the
 * file moved on, the pane is closed, and its save on the way out is refused too.
 *
 * Each test starts the app two or three times and waits out an autosave in
 * between, so it spends most of the default 30 s when a runner stalls: one did
 * for ~20 s across both tests that opened shard 7, and the autosave the last
 * check was correctly waiting on had not yet run when the test's time ran out
 * (#754). The checks already wait on the state; the test needs the time.
 */

test.slow();

const NOTE = '# Note\n\nOriginal paragraph.\n';
const OTHER = '# Other\n\nSomething else.\n';
/** The file, moved on underneath the pane holding it. */
const STARRED = '---\nfavorite: true\n---\n\n# Note\n\nOriginal paragraph.\n';

const pane = (page: Page, which: 1 | 2) => page.getByRole('region', { name: `Pane ${which}` });

const openFromSidebar = (page: Page, name: string) =>
  sidebarSection(page, 'userSpace').getByRole('treeitem', { name, exact: true }).click();

/** The notice about kept work, which sits outside every pane. */
const keptNotice = (page: Page) =>
  page.getByRole('alert').filter({ hasText: 'Open the note again to get them back' });

async function openVault(page: Page): Promise<FakeVault> {
  const vault = await createVault();
  await vault.write('note.md', NOTE);
  await vault.write('other.md', OTHER);
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return vault;
}

/** Types into note.md in a second pane, has the save refused, and closes the pane. */
async function strandAnEdit(page: Page, vault: FakeVault): Promise<void> {
  await openFromSidebar(page, 'other');
  await splitWindow(page);
  await openFromSidebar(page, 'note');
  await expect(pane(page, 2).getByRole('article', { name: 'note' })).toBeVisible();

  await vault.write('note.md', STARRED);
  await caretAtLineEnd(pane(page, 2).getByText('Original paragraph.'));
  await page.keyboard.type(' Typed before quitting.');
  await expect(pane(page, 2).getByRole('alert')).toContainText('changed on disk');

  await closePane(page, 2);
  // Stranded, not saved: this is what the rest of each test depends on.
  await expect(keptNotice(page)).toContainText('note');
  expect(await vault.read('note.md')).toBe(STARRED);
}

/** Quits and starts again, and waits until the vault is back. */
async function restart(page: Page): Promise<void> {
  await page.reload();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
}

/** What is kept in storage, read directly: the state, rather than the notice about it. */
const keptInStorage = (page: Page) =>
  page.evaluate(() =>
    Object.keys(window.localStorage).filter((key) => key.startsWith('atlas.stranded:')),
  );

test('an edit stranded by a closed pane is there after a restart, and saves', async ({ page }) => {
  const vault = await openVault(page);
  await strandAnEdit(page, vault);

  await restart(page);
  await expect(keptNotice(page)).toContainText('note');
  await openFromSidebar(page, 'note');

  await expect(pane(page, 1).getByText('Original paragraph. Typed before quitting.')).toBeVisible();
  // The file has not moved since the work was kept, so nothing is asked.
  await expect(pane(page, 1).getByRole('button', { name: 'Overwrite the file' })).toHaveCount(0);
  await expect(keptNotice(page)).toHaveCount(0);

  // Saved the ordinary way — the autosave — which is what an unsaved note does.
  await expectFile(vault, 'note.md').toContain('Original paragraph. Typed before quitting.');
  // Saved over the file as it stood, so the other writer's star is kept.
  await expectFile(vault, 'note.md').toContain('favorite: true');

  // Handed back once: after another restart the note is just the file.
  await restart(page);
  await openFromSidebar(page, 'note');
  await expect(pane(page, 1).getByText('Saved', { exact: true })).toBeVisible();
  await expect(keptNotice(page)).toHaveCount(0);
});

test('a note changed while the app was closed asks before its kept edit is written', async ({
  page,
}) => {
  const vault = await openVault(page);
  await strandAnEdit(page, vault);
  const WRITTEN_WHILE_CLOSED = '# Note\n\nWritten while DFAI was closed.\n';
  await vault.write('note.md', WRITTEN_WHILE_CLOSED);

  await restart(page);
  await openFromSidebar(page, 'note');

  await expect(pane(page, 1).getByText('Typed before quitting.')).toBeVisible();
  await expect(pane(page, 1).getByRole('alert')).toContainText(
    'changed on disk after these unsaved changes were kept',
  );

  await pane(page, 1).getByRole('button', { name: 'Overwrite the file' }).click();
  await expectFile(vault, 'note.md').toContain('Typed before quitting.');
  await expect(pane(page, 1).getByText('Saved', { exact: true })).toBeVisible();
  await expect(pane(page, 1).getByRole('alert')).toHaveCount(0);
});

test('kept work is still offered after a restart at the overwrite question (R14-05)', async ({
  page,
}) => {
  const vault = await openVault(page);
  await strandAnEdit(page, vault);
  await vault.write('note.md', '# Note\n\nWritten while DFAI was closed.\n');
  await restart(page);
  await openFromSidebar(page, 'note');
  await expect(pane(page, 1).getByRole('button', { name: 'Overwrite the file' })).toBeVisible();
  // While the question is up, the store still holds the only durable copy.
  expect(await keptInStorage(page)).toHaveLength(1);

  // Quit while the question is up, without answering it. The pane comes back
  // on the same note, and is handed the work again.
  await restart(page);

  await expect(pane(page, 1).getByText('Typed before quitting.')).toBeVisible();
  await expect(pane(page, 1).getByRole('alert')).toContainText(
    'changed on disk after these unsaved changes were kept',
  );
  await pane(page, 1).getByRole('button', { name: 'Overwrite the file' }).click();
  await expectFile(vault, 'note.md').toContain('Original paragraph. Typed before quitting.');
  await expect(pane(page, 1).getByText('Saved', { exact: true })).toBeVisible();
  // Written, so let go of: nothing is offered on the start after that.
  expect(await keptInStorage(page)).toEqual([]);
});

test('kept changes to a note that was deleted can be discarded', async ({ page }) => {
  const vault = await openVault(page);
  await strandAnEdit(page, vault);
  await rm(join(vault.root, 'note.md'));

  await restart(page);
  await expect(keptNotice(page)).toContainText('note');
  expect(await keptInStorage(page)).toHaveLength(1);
  await page.getByRole('button', { name: 'Discard kept changes to note' }).click();
  await expect(keptNotice(page)).toHaveCount(0);
  expect(await keptInStorage(page)).toEqual([]);

  await restart(page);
  expect(await keptInStorage(page)).toEqual([]);
});
