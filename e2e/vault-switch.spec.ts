import { utimes } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { expect, test, type Page } from './fixtures.ts';
import {
  createVault,
  expectFile,
  expectSaved,
  installHost,
  sidebarSection,
  type FakeHost,
  type FakeVault,
  saveNow,
  splitWindow,
} from './host.ts';
import { caretAtLineEnd } from './caret.ts';

/**
 * R14-01: unsaved work in a pane goes to the vault it was typed in, never to a
 * note of the same name in the vault opened next.
 *
 * Paths are relative to a vault, and the host holds one current vault, so a
 * save that reaches it after the switch names `notes.md` in the wrong one.
 */

const A_NOTE = '# Notes\n\nWritten in vault A.\n';
const B_NOTE = '# Notes\n\nWritten in vault B.\n';
/** A's note, moved on underneath the pane holding it. */
const A_MOVED = '---\nfavorite: true\n---\n\n# Notes\n\nWritten in vault A.\n';

/**
 * One modification time for both files. The host refuses a save whose file has
 * moved since it was read; two vaults synced or copied from one another carry
 * the same times, and then that check is no protection at all.
 */
const SAME_TIME = new Date('2026-09-01T09:00:00Z');

const nameOf = (vault: FakeVault) => vault.root.split(sep).at(-1) ?? '';

const pane = (page: Page) => page.getByRole('region', { name: 'Pane 1' });

const keptNotice = (page: Page) =>
  page.getByRole('alert').filter({ hasText: 'Open the note again to get them back' });

async function twoVaults(page: Page): Promise<{ a: FakeVault; b: FakeVault; host: FakeHost }> {
  const a = await createVault();
  const b = await createVault();
  await a.write('notes.md', A_NOTE);
  await b.write('notes.md', B_NOTE);
  await utimes(join(a.root, 'notes.md'), SAME_TIME, SAME_TIME);
  await utimes(join(b.root, 'notes.md'), SAME_TIME, SAME_TIME);
  const host = await installHost(page, a);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return { a, b, host };
}

async function typeIntoNotes(page: Page, typed: string): Promise<void> {
  await sidebarSection(page, 'userSpace')
    .getByRole('treeitem', { name: 'notes', exact: true })
    .click();
  await caretAtLineEnd(pane(page).getByText('Written in vault A.'));
  await page.keyboard.type(typed);
}

/** Opens another vault through the header, the way a person switches. */
async function switchTo(page: Page, host: FakeHost, from: FakeVault, to: FakeVault) {
  host.offer(to);
  await page.getByRole('button', { name: nameOf(from), exact: true }).click();
  // The name opens a menu since U-29: another folder, or a vault from GitHub.
  await page.getByRole('menuitem', { name: 'Open another folder…' }).click();
  await expect(page.getByRole('button', { name: nameOf(to), exact: true })).toBeVisible();
}

test('unsaved typing is saved into the vault it was typed in, not the one opened next', async ({
  page,
}) => {
  const { a, b, host } = await twoVaults(page);
  await typeIntoNotes(page, ' Typed in A.');
  await expect(pane(page).getByText('Unsaved')).toBeVisible();

  await switchTo(page, host, a, b);

  await expectFile(a, 'notes.md').toBe('# Notes\n\nWritten in vault A. Typed in A.\n');
  expect(await b.read('notes.md')).toBe(B_NOTE);
  // Written, so there is nothing kept for either vault.
  await expect(keptNotice(page)).toHaveCount(0);
});

test('work that cannot be saved on a switch is kept for its own vault, not the next one', async ({
  page,
}) => {
  const { a, b, host } = await twoVaults(page);
  await typeIntoNotes(page, ' Typed in A.');
  // The file moves on, so this pane's save is refused and the work stays unsaved.
  await a.write('notes.md', A_MOVED);
  await page.keyboard.type(' More.');
  await expect(pane(page).getByRole('alert')).toContainText('changed on disk');

  await switchTo(page, host, a, b);
  await expect(page.getByText(/notes indexed/)).toBeVisible();

  // Nothing is written into B's note of the same name, and B is not told about
  // work that is not B's.
  await sidebarSection(page, 'userSpace')
    .getByRole('treeitem', { name: 'notes', exact: true })
    .click();
  await expect(pane(page).getByText('Written in vault B.')).toBeVisible();
  expect(await b.read('notes.md')).toBe(B_NOTE);
  await expect(keptNotice(page)).toHaveCount(0);

  // Back in A, the work is waiting, and A's file was not written over either.
  // The pane carries `notes` across the switch and takes the work back as soon
  // as its read of A's note lands, which ends the notice: held, the notice is a
  // state to wait for rather than a moment to catch (#360).
  const releaseRead = host.holdReads('notes.md');
  await switchTo(page, host, b, a);
  await expect(keptNotice(page)).toContainText('notes');
  expect(await a.read('notes.md')).toBe(A_MOVED);
  releaseRead();
  await sidebarSection(page, 'userSpace')
    .getByRole('treeitem', { name: 'notes', exact: true })
    .click();
  await expect(pane(page).getByText('Written in vault A. Typed in A. More.')).toBeVisible();
  // Handed to the pane, it is not offered again.
  await expect(keptNotice(page)).toHaveCount(0);
  expect(await a.read('notes.md')).toBe(A_MOVED);
  expect(await b.read('notes.md')).toBe(B_NOTE);
});

/**
 * R14-02: the same path in another vault is another note, and the editor has to
 * show it.
 *
 * Tiptap reads its content only when it is created, so an editor that outlives
 * a switch keeps the old vault's text on screen unless it adopts the new
 * document. With the path and the time both the same, a save from that editor
 * would be accepted — and write A's body into B's file.
 */

const editor = (scope: Page | ReturnType<typeof pane>) => scope.getByLabel('Note', { exact: true });

const openNotes = (page: Page) =>
  sidebarSection(page, 'userSpace').getByRole('treeitem', { name: 'notes', exact: true }).click();

/** Types at the end of B's note in `scope` and saves it with the pane's button. */
async function typeAndSaveInB(scope: ReturnType<typeof pane>, typed: string): Promise<void> {
  await caretAtLineEnd(scope.getByText('Written in vault B.'));
  await scope.page().keyboard.type(typed);
  await expect(scope.getByText('Unsaved')).toBeVisible();
  await saveNow(scope.page(), scope);
  await expectSaved(scope);
}

async function expectBEditedAndAUntouched(a: FakeVault, b: FakeVault): Promise<void> {
  await expectFile(b, 'notes.md').toBe('# Notes\n\nWritten in vault B. Typed in B.\n');
  expect(await b.read('notes.md')).not.toContain('vault A');
  expect(await a.read('notes.md')).toBe(A_NOTE);
}

test("the editor shows the next vault's note of the same name, and saves only that", async ({
  page,
}) => {
  const { a, b, host } = await twoVaults(page);
  await openNotes(page);
  await expect(editor(pane(page))).toContainText('Written in vault A.');

  await switchTo(page, host, a, b);
  await openNotes(page);

  await expect(editor(pane(page))).toContainText('Written in vault B.');
  await expect(editor(pane(page))).not.toContainText('vault A');
  await typeAndSaveInB(pane(page), ' Typed in B.');
  await expectBEditedAndAUntouched(a, b);
});

test("with a split, both panes' editors show the next vault's note of the same name", async ({
  page,
}) => {
  const { a, b, host } = await twoVaults(page);
  const panes = [pane(page), page.getByRole('region', { name: 'Pane 2' })];
  await openNotes(page);
  await splitWindow(page);
  for (const each of panes) await expect(editor(each)).toContainText('Written in vault A.');

  await switchTo(page, host, a, b);
  await openNotes(page);
  await splitWindow(page);

  for (const each of panes) {
    await expect(editor(each)).toContainText('Written in vault B.');
    await expect(editor(each)).not.toContainText('vault A');
  }
  await typeAndSaveInB(pane(page), ' Typed in B.');
  await expectBEditedAndAUntouched(a, b);
});

for (const split of [false, true]) {
  const where = split ? 'both panes' : 'the pane';
  test(`a layout that carries the path across the switch in ${where} shows the next vault's note`, async ({
    page,
  }) => {
    const { a, b, host } = await twoVaults(page);
    const panes = split ? [pane(page), page.getByRole('region', { name: 'Pane 2' })] : [pane(page)];
    await openNotes(page);
    if (split) await splitWindow(page);
    for (const each of panes) await expect(editor(each)).toContainText('Written in vault A.');

    // B's layout names the same path in the same panes, so the switch hands
    // `notes.md` to the editors showing A's: nothing is opened and no pane is
    // keyed afresh. Planted, because the store remembers one vault at a time;
    // a store per vault (R14-03) would bring this about on its own.
    await page.evaluate(
      ([vault, paths]) =>
        window.localStorage.setItem('atlas.panes', JSON.stringify({ vault, paths, focused: 0 })),
      [b.root, panes.map(() => 'notes.md')] as const,
    );
    await switchTo(page, host, a, b);

    for (const each of panes) {
      await expect(editor(each)).toContainText('Written in vault B.');
      await expect(editor(each)).not.toContainText('vault A');
    }
    await typeAndSaveInB(pane(page), ' Typed in B.');
    await expectBEditedAndAUntouched(a, b);
  });
}

/**
 * With tabs (#346): nothing of vault A's tabs shows or writes in vault B, and
 * A's tabs are back, as they were, when A is opened again.
 */
test('tabs open in A show nothing and write nothing in B, and come back when A is reopened', async ({
  page,
}) => {
  const { a, b, host } = await twoVaults(page);
  await b.write('only-in-b.md', '# Only in B\n\nB alone has this.\n');
  await typeIntoNotes(page, ' Typed in A.');
  await expectSaved(pane(page));
  await sidebarSection(page, 'userSpace')
    .getByRole('treeitem', { name: 'notes', exact: true })
    .click({ modifiers: ['Meta'] });
  const tabs = page.getByRole('tablist', { name: 'Pane 1 tabs' }).getByRole('tab');
  await expect(tabs).toHaveText(['notes', 'notes']);
  const writesBefore = host.callsTo('write_text_file');

  await switchTo(page, host, a, b);
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  // B starts on one empty tab: no page of A's, no editor of A's left behind.
  await expect(tabs).toHaveText(['New tab']);
  await expect(pane(page).getByText('vault A')).toHaveCount(0);
  await sidebarSection(page, 'userSpace')
    .getByRole('treeitem', { name: 'only-in-b', exact: true })
    .click();
  await expect(editor(pane(page))).toContainText('B alone has this.');
  expect(host.callsTo('write_text_file')).toBe(writesBefore);
  expect(await b.read('notes.md')).toBe(B_NOTE);

  await switchTo(page, host, b, a);
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await expect(tabs).toHaveText(['notes', 'notes']);
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(editor(pane(page))).toContainText('Written in vault A. Typed in A.');
  expect(await b.read('notes.md')).toBe(B_NOTE);
});
