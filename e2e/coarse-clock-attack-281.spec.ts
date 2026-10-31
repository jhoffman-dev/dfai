import { expect, test, type Page } from './fixtures.ts';
import { stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createVault,
  expectFile,
  installHost,
  saveNow,
  saveStatus,
  splitWindow,
  type FakeVault,
} from './host.ts';
import { caretAtLineEnd } from './caret.ts';
import { LINE_END } from './platform-keys.ts';

/**
 * Attack on #281 (#245): the app's own saves on a disk whose clock is coarse.
 * The fake host leaves every save at one whole second (`coarseTickSeconds`),
 * as HFS+ does for a save within the tick of the version it replaced.
 */
const TICK_SECONDS = 1_700_000_000;
const NOTE = '# Note\n\nShip on zap\n';

async function openOnACoarseDisk(page: Page): Promise<FakeVault> {
  const vault = await createVault();
  await vault.write('note.md', NOTE);
  await utimes(join(vault.root, 'note.md'), TICK_SECONDS, TICK_SECONDS);
  await installHost(page, vault, {
    echoWrites: true,
    coarseTickSeconds: TICK_SECONDS,
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/^1 notes? indexed/)).toBeVisible();
  await page.getByRole('treeitem', { name: 'note', exact: true }).click();
  await expect(page.getByRole('article', { name: 'note' })).toBeVisible();
  return vault;
}

/**
 * Replaces the last character of the line holding `text` with `typed`, in one
 * edit: typed key by key, an autosave part-way would leave the index holding
 * a version of another length, and the refresh would re-read it for that.
 */
async function replaceLastCharacter(page: Page, text: string, typed: string) {
  // Selected until it holds: ProseMirror puts its own selection back 20 ms
  // after the editor takes the focus, if it has not read the page's yet, so
  // on a slow runner a selection made in that window is undone (zapg).
  // Read a frame later, the selection is one ProseMirror has seen. The click
  // is redone too: the caret put back is not on this line (#489).
  await expect(async () => {
    await page.getByText(text).click();
    // The line's end as the platform moves to it: ⌘→ on macOS, where End does not move the caret (#448).
    await page.keyboard.press(LINE_END);
    await page.keyboard.press('Shift+ArrowLeft');
    const selected = await page.evaluate(
      () =>
        new Promise<string>((resolve) =>
          requestAnimationFrame(() => resolve(String(window.getSelection()))),
        ),
    );
    expect(selected).toBe(text.slice(-1));
  }).toPass({ timeout: 5_000 });
  await page.keyboard.insertText(typed);
}

async function findsInSearch(page: Page, word: string) {
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Search notes' });
  const search = palette.getByRole('searchbox', { name: 'Search the vault' });
  await expect(async () => {
    await search.fill('');
    await search.fill(word);
    await expect(palette.getByRole('option', { name: /note/ })).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

test('attack #281: the app’s own same-length save within the tick is found by its new words', async ({
  page,
}) => {
  const vault = await openOnACoarseDisk(page);
  await replaceLastCharacter(page, 'Ship on zap', 'g');
  await saveNow(page);
  await expectFile(vault, 'note.md').toBe('# Note\n\nShip on zag\n');
  expect((await stat(join(vault.root, 'note.md'))).mtimeMs).toBe(TICK_SECONDS * 1000);

  await findsInSearch(page, 'zag');
});

test('attack #281: after a refused save is discarded in the same tick, the next save lands', async ({
  page,
}) => {
  const vault = await openOnACoarseDisk(page);
  await replaceLastCharacter(page, 'Ship on zap', 'g');
  await saveNow(page);
  await expectFile(vault, 'note.md').toBe('# Note\n\nShip on zag\n');
  await expect(saveStatus(page)).toHaveText('Saved');

  // Another program, in the same second and at the same length: refused, rightly.
  await vault.write('note.md', '# Note\n\nShip on zig\n');
  await utimes(join(vault.root, 'note.md'), TICK_SECONDS, TICK_SECONDS);
  await caretAtLineEnd(page.getByText('Ship on zag'));
  await page.keyboard.type(' Typed here.');
  await saveNow(page);
  await expect(page.getByRole('alert')).toContainText('changed on disk');
  await page.getByRole('button', { name: 'Discard my changes' }).click();
  await expect(page.getByText('Ship on zig')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);

  // The pane now holds the file as it is: an edit to it is an ordinary save.
  // A click on the spot of the last ones is a double or triple click, and
  // selects; the caret helper collapses that to the line's end.
  await caretAtLineEnd(page.getByText('Ship on zig'));
  await page.keyboard.type(' After.');
  await saveNow(page);

  await expectFile(vault, 'note.md').toBe('# Note\n\nShip on zig After.\n');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

const pane = (page: Page, which: 1 | 2) => page.getByRole('region', { name: `Pane ${which}` });

test('attack #281: two panes on one note, saving in turn within one tick, are never refused', async ({
  page,
}) => {
  const vault = await openOnACoarseDisk(page);
  await splitWindow(page);
  await expect(pane(page, 2).getByRole('article', { name: 'note' })).toBeVisible();

  await caretAtLineEnd(pane(page, 1).getByText('Ship on zap'));
  await page.keyboard.type(' One.');
  await saveNow(page, pane(page, 1));
  await expectFile(vault, 'note.md').toBe('# Note\n\nShip on zap One.\n');
  await expect(pane(page, 2).getByText('Ship on zap One.')).toBeVisible();

  await caretAtLineEnd(pane(page, 2).getByText('Ship on zap One.'));
  await page.keyboard.type(' Two.');
  await saveNow(page, pane(page, 2));
  await expectFile(vault, 'note.md').toBe('# Note\n\nShip on zap One. Two.\n');
  await expect(pane(page, 1).getByText('Ship on zap One. Two.')).toBeVisible();

  await caretAtLineEnd(pane(page, 1).getByText('Ship on zap One. Two.'));
  await page.keyboard.type(' Three.');
  await saveNow(page, pane(page, 1));

  await expectFile(vault, 'note.md').toBe('# Note\n\nShip on zap One. Two. Three.\n');
  await expect(page.getByRole('alert')).toHaveCount(0);
});
