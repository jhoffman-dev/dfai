import { expect, test, type Page } from './fixtures.ts';
import {
  closePane,
  createVault,
  expectFile,
  installHost,
  sidebarSection,
  type FakeVault,
} from './host.ts';
import { caretAtLineEnd } from './caret.ts';

// Adversarial pass on issue #9: the pane bar's Split right and Close pane buttons.
// Several of these fail on purpose — each is a bug found, left red for the fix:
// a pane closed mid-typing leaves the other pane on the same note stale; the
// close tooltip names a shortcut that closes the other pane; focus drops to the
// body after a split or a close; and the close button is off the pane's edge at
// the minimum window width, or with Claude open.

const NOTE = '# Note\n\nOriginal paragraph.\n';
const OTHER = '# Other\n\nSomething else.\n';

async function openVault(page: Page): Promise<FakeVault> {
  return (await openVaultWithHost(page)).vault;
}

async function openVaultWithHost(page: Page) {
  const vault = await createVault();
  await vault.write('note.md', NOTE);
  await vault.write('other.md', OTHER);
  const host = await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return { vault, host };
}

const overlaps = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const pane = (page: Page, which: 1 | 2) => page.getByRole('region', { name: `Pane ${which}` });

const openNote = (page: Page, name: string) =>
  sidebarSection(page, 'userSpace').getByRole('treeitem', { name, exact: true }).click();

async function typeInto(page: Page, which: 1 | 2, existing: string, addition: string) {
  await caretAtLineEnd(pane(page, which).getByText(existing));
  await page.keyboard.type(addition);
}

/** note.md in both panes, split from the bar's button. */
async function splitOnNote(page: Page): Promise<void> {
  await openNote(page, 'note');
  await expect(pane(page, 1).getByRole('article', { name: 'note' })).toBeVisible();
  await pane(page, 1).getByRole('button', { name: 'Split right' }).click();
  await expect(pane(page, 2).getByRole('article', { name: 'note' })).toBeVisible();
}

test('closing the right pane mid-typing: the typing is on disk', async ({ page }) => {
  const vault = await openVault(page);
  await splitOnNote(page);
  await typeInto(page, 2, 'Original paragraph.', ' Typed in pane 2.');
  await pane(page, 2).getByRole('button', { name: 'Close pane' }).click();
  await expect(pane(page, 2)).toHaveCount(0);
  await expectFile(vault, 'note.md').toContain('Typed in pane 2.');
});

test('closing the right pane mid-typing: the pane left on the same note shows the typing', async ({
  page,
}) => {
  await openVault(page);
  await splitOnNote(page);
  await typeInto(page, 2, 'Original paragraph.', ' Typed in pane 2.');
  await pane(page, 2).getByRole('button', { name: 'Close pane' }).click();
  await expect(pane(page, 2)).toHaveCount(0);
  await expect(pane(page, 1).getByText('Typed in pane 2.')).toBeVisible();
});

test('closing the left pane while typing in the right: the typing is on disk', async ({ page }) => {
  const vault = await openVault(page);
  await splitOnNote(page);
  await typeInto(page, 2, 'Original paragraph.', ' Typed in pane 2.');
  await pane(page, 1).getByRole('button', { name: 'Close pane' }).click();
  await expect(pane(page, 2)).toHaveCount(0);
  await expectFile(vault, 'note.md').toContain('Typed in pane 2.');
});

test('closing the left pane while typing in the right: the remaining pane shows the typing', async ({
  page,
}) => {
  await openVault(page);
  await splitOnNote(page);
  await typeInto(page, 2, 'Original paragraph.', ' Typed in pane 2.');
  await pane(page, 1).getByRole('button', { name: 'Close pane' }).click();
  await expect(pane(page, 2)).toHaveCount(0);
  await expect(pane(page, 1).getByText('Typed in pane 2.')).toBeVisible();
});

test('after closing the right pane mid-typing, typing on in the left keeps both edits', async ({
  page,
}) => {
  const vault = await openVault(page);
  await splitOnNote(page);
  await typeInto(page, 2, 'Original paragraph.', ' Typed in pane 2.');
  await pane(page, 2).getByRole('button', { name: 'Close pane' }).click();
  await expect(pane(page, 2)).toHaveCount(0);
  await expectFile(vault, 'note.md').toContain('Typed in pane 2.');
  await typeInto(page, 1, 'Original paragraph', ' Then pane 1.');
  // Its own save is refused as "changed on disk": pane 1 never heard of pane 2's write.
  await expectFile(vault, 'note.md').toContain('Then pane 1.');
  await expectFile(vault, 'note.md').toContain('Typed in pane 2.');
  await expect(pane(page, 1).getByRole('alert')).toHaveCount(0);
});

test('closing the left pane holding unsaved typing, right holds another note: typing saved', async ({
  page,
}) => {
  const vault = await openVault(page);
  await splitOnNote(page);
  await openNote(page, 'other');
  await expect(pane(page, 2).getByRole('article', { name: 'other' })).toBeVisible();
  await typeInto(page, 1, 'Original paragraph.', ' Typed in pane 1.');
  await pane(page, 1).getByRole('button', { name: 'Close pane' }).click();
  await expect(pane(page, 2)).toHaveCount(0);
  await expect(pane(page, 1).getByRole('article', { name: 'other' })).toBeVisible();
  await expectFile(vault, 'note.md').toContain('Typed in pane 1.');
});

test('closing a pane while its save is in flight: the typing still lands', async ({ page }) => {
  const { vault, host } = await openVaultWithHost(page);
  await splitOnNote(page);
  await openNote(page, 'other');
  await expect(pane(page, 2).getByRole('article', { name: 'other' })).toBeVisible();
  const release = host.holdWrites('other.md');
  await typeInto(page, 2, 'Something else.', ' First.');
  await expect(pane(page, 2).getByText(/Saving/)).toBeVisible();
  await page.keyboard.type(' Second.');
  await pane(page, 2).getByRole('button', { name: 'Close pane' }).click();
  await expect(pane(page, 2)).toHaveCount(0);
  release();
  await expectFile(vault, 'other.md').toContain('First. Second.');
});

test('the close button tooltip names the shortcut only on the pane it closes', async ({ page }) => {
  await openVault(page);
  await splitOnNote(page);
  // Focus the left pane: the shortcut now closes it, not the right one.
  await pane(page, 1).getByText('Original paragraph.').click();
  const titleOf = (which: 1 | 2) =>
    pane(page, which).getByRole('button', { name: 'Close pane' }).getAttribute('title');
  expect(await titleOf(2)).toBe('Close pane');
  expect(await titleOf(1)).toBe('Close pane (⇧⌘\\)');
  await openNote(page, 'other'); // lands in the focused (left) pane, so the two can be told apart
  await expect(pane(page, 1).getByRole('article', { name: 'other' })).toBeVisible();
  await page.keyboard.press('Shift+Meta+Backslash');
  await expect(pane(page, 2)).toHaveCount(0);
  // The pane whose button advertised the shortcut is the one that went.
  await expect(pane(page, 1).getByRole('article', { name: 'note' })).toBeVisible();
});

test('after closing from the keyboard, focus lands in the remaining pane', async ({ page }) => {
  await openVault(page);
  await splitOnNote(page);
  const close = pane(page, 2).getByRole('button', { name: 'Close pane' });
  await close.focus();
  await page.keyboard.press('Enter');
  await expect(pane(page, 2)).toHaveCount(0);
  const inPane = await page.evaluate(
    () => document.activeElement?.closest('[aria-label="Pane 1"]') !== null,
  );
  expect(inPane).toBe(true);
});

test('after splitting from the keyboard, focus is not lost to the body', async ({ page }) => {
  await openVault(page);
  await openNote(page, 'note');
  await expect(pane(page, 1).getByRole('article', { name: 'note' })).toBeVisible();
  const split = pane(page, 1).getByRole('button', { name: 'Split right' });
  await split.focus();
  await page.keyboard.press('Enter');
  await expect(pane(page, 2)).toBeVisible();
  const tag = await page.evaluate(() => document.activeElement?.tagName);
  expect(tag).not.toBe('BODY');
});

test('a closed split stays closed after a restart', async ({ page }) => {
  await openVault(page);
  await splitOnNote(page);
  await openNote(page, 'other');
  await pane(page, 1).getByRole('button', { name: 'Close pane' }).click();
  await expect(pane(page, 2)).toHaveCount(0);
  await page.reload();
  await expect(pane(page, 1).getByRole('article', { name: 'other' })).toBeVisible();
  await expect(pane(page, 2)).toHaveCount(0);
});

test('Back after closing the left pane walks the right pane history', async ({ page }) => {
  await openVault(page);
  await openNote(page, 'note');
  await expect(pane(page, 1).getByRole('article', { name: 'note' })).toBeVisible();
  await pane(page, 1).getByRole('button', { name: 'Split right' }).click();
  await openNote(page, 'other');
  await expect(pane(page, 2).getByRole('article', { name: 'other' })).toBeVisible();
  await pane(page, 1).getByRole('button', { name: 'Close pane' }).click();
  await expect(pane(page, 2)).toHaveCount(0);
  await pane(page, 1).getByRole('button', { name: 'Back' }).click();
  await expect(pane(page, 1).getByRole('article', { name: 'note' })).toBeVisible();
});

/** Every control in a pane's bar lies inside the pane and clear of the one before it. */
async function expectBarControlsReachable(page: Page, which: 1 | 2) {
  const frame = await pane(page, which).boundingBox();
  if (frame === null) throw new Error(`pane ${which} has no box`);
  for (const name of ['Close pane', 'More']) {
    const control = await pane(page, which)
      .getByRole('button', { name, exact: true })
      .boundingBox();
    if (control === null) throw new Error(`pane ${which} ${name} has no box`);
    expect(control.x + control.width, `${name} in pane ${which}`).toBeLessThanOrEqual(
      frame.x + frame.width,
    );
  }
  const crumbs = await pane(page, which).locator('.page-bar__crumbs').boundingBox();
  const close = await pane(page, which).getByRole('button', { name: 'Close pane' }).boundingBox();
  if (crumbs === null || close === null) throw new Error('no box');
  expect(overlaps(close, crumbs)).toBe(false);
}

test('at the window minimum width (720px) both panes can still be closed and opened', async ({
  page,
}) => {
  await page.setViewportSize({ width: 720, height: 700 });
  await openVault(page);
  await splitOnNote(page);
  await expectBarControlsReachable(page, 1);
  await expectBarControlsReachable(page, 2);
});

test('at the default width (1180px) with Claude open, both panes can still be closed', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1180, height: 800 });
  await openVault(page);
  await splitOnNote(page);
  await pane(page, 1).getByRole('button', { name: 'Claude' }).click();
  await expectBarControlsReachable(page, 1);
  await expectBarControlsReachable(page, 2);
});

test('an empty pane offers Split right, and splitting it leaves two closable panes', async ({
  page,
}) => {
  await openVault(page);
  await pane(page, 1).getByRole('button', { name: 'Split right' }).click();
  await expect(pane(page, 2)).toBeVisible();
  await pane(page, 2).getByRole('button', { name: 'Close pane' }).click();
  await expect(pane(page, 2)).toHaveCount(0);
});

test('split from the button, then the shortcut closes the new pane and keeps the first', async ({
  page,
}) => {
  await openVault(page);
  await openNote(page, 'note');
  await pane(page, 1).getByRole('button', { name: 'Split right' }).click();
  await openNote(page, 'other');
  await expect(pane(page, 2).getByRole('article', { name: 'other' })).toBeVisible();
  await page.keyboard.press('Shift+Meta+Backslash');
  await expect(pane(page, 2)).toHaveCount(0);
  await expect(pane(page, 1).getByRole('article', { name: 'note' })).toBeVisible();
});

const BOARD = [
  '---',
  'atlas: view',
  'layout: table',
  'columns: [title]',
  'limit: 50',
  '---',
  '',
  '# Board',
  '',
].join('\n');

test('closing the left pane mid-typing beside a view: the typing is saved and the view is shown', async ({
  page,
}) => {
  const vault = await createVault();
  await vault.mkdir('.atlas/views');
  await vault.write('.atlas/views/Board.md', BOARD);
  await vault.write('note.md', NOTE);
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await openNote(page, 'note');
  await pane(page, 1).getByRole('button', { name: 'Split right' }).click();
  await sidebarSection(page, 'views').getByRole('button', { name: 'Board', exact: true }).click();
  await expect(pane(page, 2).getByRole('article', { name: 'Board' })).toBeVisible();
  await typeInto(page, 1, 'Original paragraph.', ' Typed beside a view.');
  await pane(page, 1).getByRole('button', { name: 'Close pane' }).click();
  await expect(pane(page, 2)).toHaveCount(0);
  await expect(pane(page, 1).getByRole('article', { name: 'Board' })).toBeVisible();
  await expect(pane(page, 1).getByText('Typed beside a view.')).toHaveCount(0);
  await expectFile(vault, 'note.md').toContain('Typed beside a view.');
});

test('the same loss through the existing Close pane menu item: the left pane shows the typing', async ({
  page,
}) => {
  await openVault(page);
  await splitOnNote(page);
  await typeInto(page, 2, 'Original paragraph.', ' Typed in pane 2.');
  await closePane(page, 2);
  await expect(pane(page, 2)).toHaveCount(0);
  await expect(pane(page, 1).getByText('Typed in pane 2.')).toBeVisible();
});

test('after closing from the menu with the keyboard, focus lands in the remaining pane', async ({
  page,
}) => {
  await openVault(page);
  await splitOnNote(page);
  await pane(page, 2).getByRole('button', { name: 'More' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: /^Close pane/ }).focus();
  await page.keyboard.press('Enter');
  await expect(pane(page, 2)).toHaveCount(0);
  const inPane = await page.evaluate(
    () => document.activeElement?.closest('[aria-label="Pane 1"]') !== null,
  );
  expect(inPane).toBe(true);
});
