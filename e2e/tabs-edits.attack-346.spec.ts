import { sep } from 'node:path';
import { expect, test, type Page } from './fixtures.ts';
import {
  createVault,
  emitVaultChanged,
  expectFile,
  expectSaved,
  installHost,
  sidebarSection,
  type FakeHost,
  type FakeVault,
  closePane,
} from './host.ts';
import { caretAtLineEnd } from './caret.ts';

/*
 * Attack on #346: typing is never lost across tab operations. Each test ends
 * with the file on disk holding every keystroke, byte for byte.
 */

const NAMES = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta'] as const;
const bodyOf = (name: string) => `# ${name}\n\nLine of ${name}.\n`;

async function openVault(page: Page): Promise<{ vault: FakeVault; host: FakeHost }> {
  const vault = await createVault();
  for (const name of NAMES) await vault.write(`${name}.md`, bodyOf(name));
  const host = await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return { vault, host };
}

const row = (page: Page, name: string) =>
  sidebarSection(page, 'userSpace').getByRole('treeitem', { name, exact: true });
const pane = (page: Page, which: 1 | 2) => page.getByRole('region', { name: `Pane ${which}` });
const strip = (page: Page, which: 1 | 2) =>
  page.getByRole('tablist', { name: `Pane ${which} tabs` });
const tab = (page: Page, which: 1 | 2, name: string) =>
  strip(page, which).getByRole('tab', { name, exact: true });
const tabsOf = (page: Page, which: 1 | 2) => strip(page, which).getByRole('tab');
const article = (page: Page, which: 1 | 2, name: string) =>
  pane(page, which).getByRole('article', { name, exact: true });

/** Opens a note in the active tab and puts the caret at the end of its line. */
async function openAndType(page: Page, name: string, typed: string) {
  await row(page, name).click();
  await expect(article(page, 1, name)).toBeVisible();
  await caretAtLineEnd(article(page, 1, name).getByText(`Line of ${name}.`));
  await page.keyboard.type(typed);
}

const edited = (name: string, typed: string) => `# ${name}\n\nLine of ${name}.${typed}\n`;

test('typing then ⌘W at once writes every keystroke', async ({ page }) => {
  const { vault } = await openVault(page);
  await row(page, 'beta').click();
  await expect(article(page, 1, 'beta')).toBeVisible();
  await row(page, 'alpha').click({ modifiers: ['Meta'] });
  await expect(tabsOf(page, 1)).toHaveText(['beta', 'alpha']);
  await caretAtLineEnd(article(page, 1, 'alpha').getByText('Line of alpha.'));
  await page.keyboard.type(' Closed at once.');
  await page.keyboard.press('Meta+w');
  await expect(tabsOf(page, 1)).toHaveText(['beta']);
  await expectFile(vault, 'alpha.md').toBe(edited('alpha', ' Closed at once.'));
});

test('typing then ⌃Tab at once writes every keystroke', async ({ page }) => {
  const { vault } = await openVault(page);
  await row(page, 'beta').click();
  await expect(article(page, 1, 'beta')).toBeVisible();
  await row(page, 'alpha').click({ modifiers: ['Meta'] });
  await caretAtLineEnd(article(page, 1, 'alpha').getByText('Line of alpha.'));
  await page.keyboard.type(' Switched at once.');
  await page.keyboard.press('Control+Tab');
  await expect(tab(page, 1, 'beta')).toHaveAttribute('aria-selected', 'true');
  await expectFile(vault, 'alpha.md').toBe(edited('alpha', ' Switched at once.'));
  // And the editor kept behind beta still holds it when it is shown again.
  await page.keyboard.press('Control+Tab');
  await expect(
    article(page, 1, 'alpha').getByText('Line of alpha. Switched at once.'),
  ).toBeVisible();
});

test('a dirty tab let go from the hidden-editor limit loses nothing and comes back with its typing', async ({
  page,
}) => {
  const { vault } = await openVault(page);
  await openAndType(page, 'alpha', ' Evicted.');
  // Five more tabs: alpha is the fifth hidden one, past the limit of four.
  for (const name of NAMES.slice(1, 6)) {
    await row(page, name).click({ modifiers: ['Meta'] });
    await expect(article(page, 1, name)).toBeVisible();
  }
  await expect(tabsOf(page, 1)).toHaveCount(6);
  // Let go: no editor holds alpha any more.
  await expect(pane(page, 1).getByRole('article', { name: 'alpha', exact: true })).toHaveCount(0);
  await expectFile(vault, 'alpha.md').toBe(edited('alpha', ' Evicted.'));
  await tab(page, 1, 'alpha').click();
  await expect(article(page, 1, 'alpha').getByText('Line of alpha. Evicted.')).toBeVisible();
  await expectSaved(pane(page, 1));
});

test('a pane never keeps more than the shown editor and four hidden ones', async ({ page }) => {
  await openVault(page);
  await row(page, 'alpha').click();
  for (const name of NAMES.slice(1)) {
    await row(page, name).click({ modifiers: ['Meta'] });
    await expect(article(page, 1, name)).toBeVisible();
  }
  await expect(tabsOf(page, 1)).toHaveCount(NAMES.length);
  await expect(pane(page, 1).locator('.pane__tab')).toHaveCount(5);
});

test('typing then closing the pane that holds the tab writes every keystroke', async ({ page }) => {
  const { vault } = await openVault(page);
  await row(page, 'beta').click();
  await expect(article(page, 1, 'beta')).toBeVisible();
  await row(page, 'alpha').click({ modifiers: ['Meta', 'Shift'] });
  await expect(article(page, 2, 'alpha')).toBeVisible();
  await caretAtLineEnd(article(page, 2, 'alpha').getByText('Line of alpha.'));
  await page.keyboard.type(' Pane closed.');
  await closePane(page, 2);
  await expect(pane(page, 2)).toHaveCount(0);
  await expectFile(vault, 'alpha.md').toBe(edited('alpha', ' Pane closed.'));
});

test('typing in a hidden tab, then closing its pane, writes every keystroke', async ({ page }) => {
  const { vault } = await openVault(page);
  await row(page, 'beta').click();
  await expect(article(page, 1, 'beta')).toBeVisible();
  await row(page, 'alpha').click({ modifiers: ['Meta', 'Shift'] });
  await expect(article(page, 2, 'alpha')).toBeVisible();
  await caretAtLineEnd(article(page, 2, 'alpha').getByText('Line of alpha.'));
  await page.keyboard.type(' Behind gamma.');
  // Pane 2 gets a second tab, so alpha is hidden in it when the pane closes.
  await page.keyboard.press('Meta+t');
  await expect(tabsOf(page, 2)).toHaveCount(2);
  await closePane(page, 2);
  await expect(pane(page, 2)).toHaveCount(0);
  await expectFile(vault, 'alpha.md').toBe(edited('alpha', ' Behind gamma.'));
});

test('typing then a reload (quit) writes every keystroke or keeps them', async ({ page }) => {
  const { vault } = await openVault(page);
  await openAndType(page, 'alpha', ' Quit soon.');
  await expect(pane(page, 1).getByRole('status').filter({ hasText: 'Unsaved' })).toBeVisible();
  // Typed in a tab that is then hidden: its autosave stood down, so the
  // flush as it hid is all that wrote it.
  await row(page, 'beta').click({ modifiers: ['Meta'] });
  await expect(article(page, 1, 'beta')).toBeVisible();
  await page.reload();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await expectFile(vault, 'alpha.md').toBe(edited('alpha', ' Quit soon.'));
});

test('switching tabs back and forth on a typed note writes nothing more', async ({ page }) => {
  const { vault, host } = await openVault(page);
  await row(page, 'alpha').click();
  await expect(article(page, 1, 'alpha')).toBeVisible();
  // A second tab on the same note: ⌘T then a plain click opens it there.
  await page.keyboard.press('Meta+t');
  await expect(tabsOf(page, 1)).toHaveText(['alpha', 'New tab']);
  await row(page, 'alpha').click();
  // Whether a plain click opens a second tab on alpha or activates the first,
  // there must be exactly one place typing goes, and the file must have it.
  const shown = pane(page, 1).locator('.pane__tab:not([hidden])');
  await expect(shown.getByRole('article', { name: 'alpha', exact: true })).toBeVisible();
  await caretAtLineEnd(shown.getByText('Line of alpha.'));
  await page.keyboard.type(' Once.');
  await expectSaved(pane(page, 1));
  await expectFile(vault, 'alpha.md').toBe(edited('alpha', ' Once.'));
  const writes = host.writesTo('alpha.md');
  await page.keyboard.press('Control+Tab');
  await page.keyboard.press('Control+Tab');
  // No write loop: switching tabs with nothing typed writes nothing, so the
  // next typing is exactly one write more.
  await expect(shown.getByRole('article', { name: 'alpha', exact: true })).toBeVisible();
  await caretAtLineEnd(shown.getByText('Line of alpha. Once.'));
  await page.keyboard.type(' Twice.');
  await expectFile(vault, 'alpha.md').toBe(edited('alpha', ' Once. Twice.'));
  await expectSaved(pane(page, 1));
  expect(host.writesTo('alpha.md')).toBe(writes + 1);
});

test('duplicate tabs on one note (⌘-click twice): the other tab shows the typing after a switch', async ({
  page,
}) => {
  const { vault } = await openVault(page);
  await row(page, 'beta').click();
  await expect(article(page, 1, 'beta')).toBeVisible();
  await row(page, 'alpha').click({ modifiers: ['Meta'] });
  await row(page, 'alpha').click({ modifiers: ['Meta'] });
  const alphaTabs = strip(page, 1).getByRole('tab', { name: 'alpha', exact: true });
  await expect(alphaTabs).toHaveCount(2);
  // Type in the last alpha tab, switch to the first, and the first shows it.
  await alphaTabs.last().click();
  const shown = pane(page, 1).locator('.pane__tab:not([hidden])');
  await caretAtLineEnd(shown.getByText('Line of alpha.'));
  await page.keyboard.type(' From the second.');
  await alphaTabs.first().click();
  await expect(
    pane(page, 1).locator('.pane__tab:not([hidden])').getByText('Line of alpha. From the second.'),
  ).toBeVisible();
  await expectFile(vault, 'alpha.md').toBe(edited('alpha', ' From the second.'));
  // Typing in the first after that is not refused as a conflict, and wins.
  await caretAtLineEnd(
    pane(page, 1).locator('.pane__tab:not([hidden])').getByText('Line of alpha.', { exact: false }),
  );
  await page.keyboard.type(' Then the first.');
  await expectSaved(pane(page, 1));
  await expectFile(vault, 'alpha.md').toBe(edited('alpha', ' From the second. Then the first.'));
  await expect(pane(page, 1).getByRole('alert')).toHaveCount(0);
});

test('an outside change to a note in a hidden tab shows when the tab is shown, without a conflict', async ({
  page,
}) => {
  const { vault } = await openVault(page);
  await openAndType(page, 'alpha', ' Mine.');
  await row(page, 'beta').click({ modifiers: ['Meta'] });
  await expect(article(page, 1, 'beta')).toBeVisible();
  await expectFile(vault, 'alpha.md').toBe(edited('alpha', ' Mine.'));
  // Someone else changes alpha while it waits behind beta.
  const outside = '# alpha\n\nLine of alpha. Mine. Theirs.\n';
  await vault.write('alpha.md', outside);
  await emitVaultChanged(page, ['alpha.md']);
  await tab(page, 1, 'alpha').click();
  await expect(article(page, 1, 'alpha').getByText('Line of alpha. Mine. Theirs.')).toBeVisible();
  await expect(pane(page, 1).getByRole('alert')).toHaveCount(0);
  // Typing on after it is written over theirs, not refused.
  await caretAtLineEnd(article(page, 1, 'alpha').getByText('Line of alpha. Mine. Theirs.'));
  await page.keyboard.type(' Again.');
  await expectFile(vault, 'alpha.md').toBe('# alpha\n\nLine of alpha. Mine. Theirs. Again.\n');
});

const nameOf = (vault: FakeVault) => vault.root.split(sep).at(-1) ?? '';

async function switchTo(page: Page, host: FakeHost, from: FakeVault, to: FakeVault) {
  host.offer(to);
  await page.getByRole('button', { name: nameOf(from), exact: true }).click();
  await page.getByRole('menuitem', { name: 'Open another folder…' }).click();
  await expect(page.getByRole('button', { name: nameOf(to), exact: true })).toBeVisible();
}

test('typing in a hidden tab then switching vault writes it into its own vault only', async ({
  page,
}) => {
  const { vault: a, host } = await openVault(page);
  const b = await createVault();
  for (const name of NAMES) await b.write(`${name}.md`, `# ${name}\n\nB's ${name}.\n`);
  await openAndType(page, 'alpha', ' Typed in A.');
  await row(page, 'beta').click({ modifiers: ['Meta'] });
  await row(page, 'gamma').click({ modifiers: ['Meta'] });
  await caretAtLineEnd(article(page, 1, 'gamma').getByText('Line of gamma.'));
  await page.keyboard.type(' Also A.');
  await switchTo(page, host, a, b);
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await expectFile(a, 'alpha.md').toBe(edited('alpha', ' Typed in A.'));
  await expectFile(a, 'gamma.md').toBe(edited('gamma', ' Also A.'));
  // No A tab shows in B.
  await expect(tabsOf(page, 1)).toHaveText(['New tab']);
  expect(await b.read('alpha.md')).toBe("# alpha\n\nB's alpha.\n");
  expect(await b.read('gamma.md')).toBe("# gamma\n\nB's gamma.\n");
  // Back in A, its three tabs are there again.
  await switchTo(page, host, b, a);
  await expect(tabsOf(page, 1)).toHaveText(['alpha', 'beta', 'gamma']);
  await expect(tab(page, 1, 'gamma')).toHaveAttribute('aria-selected', 'true');
  expect(await b.read('alpha.md')).toBe("# alpha\n\nB's alpha.\n");
});

test('typing in a tab that was hidden through an outside change never writes over that change', async ({
  page,
}) => {
  const { vault } = await openVault(page);
  await openAndType(page, 'alpha', ' Mine.');
  await row(page, 'beta').click({ modifiers: ['Meta'] });
  await expect(article(page, 1, 'beta')).toBeVisible();
  await expectFile(vault, 'alpha.md').toBe(edited('alpha', ' Mine.'));
  await vault.write('alpha.md', '# alpha\n\nLine of alpha. Mine.\n\nTheirs, added outside.\n');
  await emitVaultChanged(page, ['alpha.md']);
  await tab(page, 1, 'alpha').click();
  await caretAtLineEnd(article(page, 1, 'alpha').getByText('Line of alpha. Mine.'));
  await page.keyboard.type(' Later.');
  // Either the editor caught up and the file has both, or the save is refused
  // and the pane says so; never their paragraph silently gone.
  await expect
    .poll(
      async () => {
        const onDisk = await vault.read('alpha.md');
        const refused = await pane(page, 1).getByRole('alert').count();
        return onDisk.includes('Theirs, added outside.') || refused > 0;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  await expectFile(vault, 'alpha.md').toContain('Theirs, added outside.');
});

test('typing in one of two tabs on a note, then at once in the other, loses neither', async ({
  page,
}) => {
  const { vault } = await openVault(page);
  await row(page, 'alpha').click();
  await row(page, 'alpha').click({ modifiers: ['Meta'] });
  const alphaTabs = strip(page, 1).getByRole('tab', { name: 'alpha', exact: true });
  await expect(alphaTabs).toHaveCount(2);
  const shown = () => pane(page, 1).locator('.pane__tab:not([hidden])');
  await caretAtLineEnd(shown().getByText('Line of alpha.'));
  await page.keyboard.type(' Second tab.');
  // Straight to the other tab on the note, and typing there before the first
  // tab's write has had time to land and reload it.
  await page.keyboard.press('Control+Tab');
  await expect(alphaTabs.first()).toHaveAttribute('aria-selected', 'true');
  await caretAtLineEnd(shown().getByText(/^Line of alpha\./));
  await page.keyboard.type(' First tab.');
  // Both typings on disk, or the pane says the save was refused; never one of
  // them silently written over by the other.
  await expect
    .poll(
      async () => {
        const onDisk = await vault.read('alpha.md');
        const both = onDisk.includes('Second tab.') && onDisk.includes('First tab.');
        return both || (await pane(page, 1).getByRole('alert').count()) > 0;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  await expect(pane(page, 1).getByRole('alert')).toHaveCount(0);
  await expectFile(vault, 'alpha.md').toBe(edited('alpha', ' Second tab. First tab.'));
});

test('⌘Z after a dirty tab was let go from the hidden-editor limit undoes nothing it should not', async ({
  page,
}) => {
  const { vault } = await openVault(page);
  await openAndType(page, 'alpha', ' Kept.');
  for (const name of NAMES.slice(1, 6)) {
    await row(page, name).click({ modifiers: ['Meta'] });
    await expect(article(page, 1, name)).toBeVisible();
  }
  await expect(pane(page, 1).getByRole('article', { name: 'alpha', exact: true })).toHaveCount(0);
  await tab(page, 1, 'alpha').click();
  const line = article(page, 1, 'alpha').getByText('Line of alpha. Kept.');
  await line.click();
  await page.keyboard.press('Meta+z');
  await page.keyboard.press('Meta+z');
  // The undo history went with the editor: the text and the file stay as typed.
  await expect(line).toBeVisible();
  await expectSaved(pane(page, 1));
  await expectFile(vault, 'alpha.md').toBe(edited('alpha', ' Kept.'));
});

test('⌘Z in one of two tabs on the same note undoes only that tab’s typing', async ({ page }) => {
  const { vault } = await openVault(page);
  await row(page, 'alpha').click();
  await row(page, 'alpha').click({ modifiers: ['Meta'] });
  const alphaTabs = strip(page, 1).getByRole('tab', { name: 'alpha', exact: true });
  await expect(alphaTabs).toHaveCount(2);
  const shown = () => pane(page, 1).locator('.pane__tab:not([hidden])');
  await caretAtLineEnd(shown().getByText('Line of alpha.'));
  await page.keyboard.type(' Second.');
  await alphaTabs.first().click();
  await expect(shown().getByText('Line of alpha. Second.')).toBeVisible();
  await caretAtLineEnd(shown().getByText('Line of alpha. Second.'));
  await page.keyboard.type(' First.');
  await expectFile(vault, 'alpha.md').toBe(edited('alpha', ' Second. First.'));
  await page.keyboard.press('Meta+z');
  await expectFile(vault, 'alpha.md').toBe(edited('alpha', ' Second.'));
  // Undo again in the first tab: it never typed " Second.", so it must not take it out.
  await page.keyboard.press('Meta+z');
  await page.keyboard.press('Meta+z');
  await expectSaved(pane(page, 1));
  await expectFile(vault, 'alpha.md').toBe(edited('alpha', ' Second.'));
});

/** Opens five more tabs after alpha's, so alpha's editor is let go. */
async function evictAlpha(page: Page) {
  for (const name of NAMES.slice(1, 6)) {
    await row(page, name).click({ modifiers: ['Meta'] });
    await expect(article(page, 1, name)).toBeVisible();
  }
  await expect(pane(page, 1).getByRole('article', { name: 'alpha', exact: true })).toHaveCount(0);
}

test('a hidden tab whose write failed as it hid still gets its typing on disk once it is let go', async ({
  page,
}) => {
  const { vault, host } = await openVault(page);
  await openAndType(page, 'alpha', ' Disk was full.');
  host.failNext('write_text_file', 'the disk is full');
  await row(page, 'beta').click({ modifiers: ['Meta'] });
  await expect(article(page, 1, 'beta')).toBeVisible();
  await expect.poll(() => host.callsTo('write_text_file')).toBeGreaterThan(0);
  await evictAlpha(page);
  await expectFile(vault, 'alpha.md').toBe(edited('alpha', ' Disk was full.'));
});

test('a hidden tab whose write failed as it hid saves its typing when it is shown again', async ({
  page,
}) => {
  const { vault, host } = await openVault(page);
  await openAndType(page, 'alpha', ' Disk was full.');
  host.failNext('write_text_file', 'the disk is full');
  await row(page, 'beta').click({ modifiers: ['Meta'] });
  await expect(article(page, 1, 'beta')).toBeVisible();
  await expect.poll(() => host.callsTo('write_text_file')).toBeGreaterThan(0);
  await tab(page, 1, 'alpha').click();
  await expect(article(page, 1, 'alpha').getByText('Line of alpha. Disk was full.')).toBeVisible();
  // Shown again with its edit unwritten: the autosave picks it up, or the
  // pane says it is unsaved; it never claims Saved over a file without it.
  await expectFile(vault, 'alpha.md').toBe(edited('alpha', ' Disk was full.'));
});

test('a hidden tab whose save was refused for a changed file keeps its typing when let go', async ({
  page,
}) => {
  const { vault } = await openVault(page);
  await openAndType(page, 'alpha', ' Mine.');
  // The file moves on underneath before the flush as it hides.
  const theirs = '---\nfavorite: true\n---\n\n# alpha\n\nLine of alpha.\n';
  await vault.write('alpha.md', theirs);
  await row(page, 'beta').click({ modifiers: ['Meta'] });
  await expect(article(page, 1, 'beta')).toBeVisible();
  await evictAlpha(page);
  // Their change is not written over, and my typing is not dropped: it is kept
  // and offered when alpha opens again.
  expect(await vault.read('alpha.md')).toBe(theirs);
  await tab(page, 1, 'alpha').click();
  await expect(article(page, 1, 'alpha').getByText('Line of alpha. Mine.')).toBeVisible();
});

/** Renames a note from the sidebar's row menu. */
async function renameFromSidebar(page: Page, from: string, to: string) {
  const pages = sidebarSection(page, 'userSpace');
  await row(page, from).hover();
  await pages.getByRole('button', { name: `Options for ${from}`, exact: true }).click();
  await page.getByRole('menuitem', { name: /^Rename/ }).click();
  const field = pages.getByRole('textbox', { name: `Name for ${from}` });
  await field.fill(to);
  await field.press('Enter');
}

test('typing in a tab whose note was renamed while it was hidden writes the renamed file', async ({
  page,
}) => {
  const { vault } = await openVault(page);
  await row(page, 'alpha').click();
  await row(page, 'beta').click({ modifiers: ['Meta'] });
  await expect(article(page, 1, 'beta')).toBeVisible();
  await renameFromSidebar(page, 'alpha', 'omega');
  await expect.poll(() => vault.exists('omega.md')).toBe(true);
  await tab(page, 1, 'omega').click();
  await caretAtLineEnd(article(page, 1, 'omega').getByText('Line of alpha.'));
  await page.keyboard.type(' After the rename.');
  await expectFile(vault, 'omega.md').toBe(edited('alpha', ' After the rename.'));
  expect(await vault.exists('alpha.md')).toBe(false);
});

test('a hidden tab with unwritten typing follows a rename and writes the typing to the new name', async ({
  page,
}) => {
  const { vault, host } = await openVault(page);
  await openAndType(page, 'alpha', ' Not yet written.');
  host.failNext('write_text_file', 'the disk is full');
  await row(page, 'beta').click({ modifiers: ['Meta'] });
  await expect(article(page, 1, 'beta')).toBeVisible();
  await expect.poll(() => host.callsTo('write_text_file')).toBeGreaterThan(0);
  await renameFromSidebar(page, 'alpha', 'omega');
  await expect.poll(() => vault.exists('omega.md')).toBe(true);
  await tab(page, 1, 'omega').click();
  await expect(
    article(page, 1, 'omega').getByText('Line of alpha. Not yet written.'),
  ).toBeVisible();
  await expectFile(vault, 'omega.md').toBe(edited('alpha', ' Not yet written.'));
  expect(await vault.exists('alpha.md')).toBe(false);
});

test('a hidden tab with unwritten typing, at a vault switch, writes to its own vault and never to the next', async ({
  page,
}) => {
  const { vault: a, host } = await openVault(page);
  const b = await createVault();
  for (const name of NAMES) await b.write(`${name}.md`, `# ${name}\n\nB's ${name}.\n`);
  await openAndType(page, 'alpha', ' Unwritten in A.');
  host.failNext('write_text_file', 'the disk is full');
  await row(page, 'beta').click({ modifiers: ['Meta'] });
  await row(page, 'gamma').click({ modifiers: ['Meta'] });
  await expect(article(page, 1, 'gamma')).toBeVisible();
  await expect.poll(() => host.callsTo('write_text_file')).toBeGreaterThan(0);
  await switchTo(page, host, a, b);
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await expectFile(a, 'alpha.md').toBe(edited('alpha', ' Unwritten in A.'));
  expect(await b.read('alpha.md')).toBe("# alpha\n\nB's alpha.\n");
  await expect(tabsOf(page, 1)).toHaveText(['New tab']);
});

test('a vault whose remembered tabs name the same notes gets its own notes in them, and A’s typing stays in A', async ({
  page,
}) => {
  const { vault: a, host } = await openVault(page);
  const b = await createVault();
  for (const name of NAMES) await b.write(`${name}.md`, `# ${name}\n\nB's ${name}.\n`);
  await row(page, 'alpha').click();
  await row(page, 'gamma').click({ modifiers: ['Meta'] });
  await row(page, 'alpha').click({ modifiers: ['Meta'] });
  await expect(tabsOf(page, 1)).toHaveText(['alpha', 'gamma', 'alpha']);
  const shown = pane(page, 1).locator('.pane__tab:not([hidden])');
  await caretAtLineEnd(shown.getByText('Line of alpha.'));
  await page.keyboard.type(' Typed in A.');
  // B remembers the same three places, with the same ids.
  const remembered = await page.evaluate(
    (key) => window.localStorage.getItem(key),
    `atlas.workspace:${a.root}`,
  );
  const planted = JSON.parse(remembered ?? '{}') as { vault: string };
  planted.vault = b.root;
  await page.evaluate(([key, value]) => window.localStorage.setItem(key, value), [
    `atlas.workspace:${b.root}`,
    JSON.stringify(planted),
  ] as const);
  await switchTo(page, host, a, b);
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await expect(tabsOf(page, 1)).toHaveText(['alpha', 'gamma', 'alpha']);
  await expect(
    pane(page, 1).locator('.pane__tab:not([hidden])').getByText("B's alpha."),
  ).toBeVisible();
  await expect(pane(page, 1).getByText('Typed in A.')).toHaveCount(0);
  await expectFile(a, 'alpha.md').toBe(edited('alpha', ' Typed in A.'));
  expect(await b.read('alpha.md')).toBe("# alpha\n\nB's alpha.\n");
  // Every B tab on alpha shows B's alpha.
  await tab(page, 1, 'gamma').click();
  await strip(page, 1).getByRole('tab', { name: 'alpha', exact: true }).first().click();
  await expect(
    pane(page, 1).locator('.pane__tab:not([hidden])').getByText("B's alpha."),
  ).toBeVisible();
  expect(await b.read('alpha.md')).toBe("# alpha\n\nB's alpha.\n");
});

test('⌘W on a tab whose last write fails keeps the typing, and ⌘⇧T brings it back with it', async ({
  page,
}) => {
  const { vault, host } = await openVault(page);
  await row(page, 'beta').click();
  await row(page, 'alpha').click({ modifiers: ['Meta'] });
  await caretAtLineEnd(article(page, 1, 'alpha').getByText('Line of alpha.'));
  await page.keyboard.type(' Closed on a full disk.');
  host.failNext('write_text_file', 'the disk is full');
  await page.keyboard.press('Meta+w');
  await expect(tabsOf(page, 1)).toHaveText(['beta']);
  await expect.poll(() => host.callsTo('write_text_file')).toBeGreaterThan(0);
  await page.keyboard.press('Meta+Shift+t');
  await expect(tab(page, 1, 'alpha')).toHaveAttribute('aria-selected', 'true');
  await expect(
    article(page, 1, 'alpha').getByText('Line of alpha. Closed on a full disk.'),
  ).toBeVisible();
  await expectFile(vault, 'alpha.md').toBe(edited('alpha', ' Closed on a full disk.'));
});
