import { expect, test, type Page } from './fixtures.ts';
import {
  createVault,
  expectFile,
  expectSaved,
  installHost,
  pageCommand,
  sidebarSection,
  type FakeHost,
  type FakeVault,
} from './host.ts';
import { dragAnnouncement, dragWithPointer, keyboardSensorListening } from './drag.ts';
import { caretAtLineEnd } from './caret.ts';

/**
 * P17-01: folders, new notes in them, moving and deleting — from Pages and
 * from a page's own menu. Every assertion about a file reads the disk.
 */

async function openVault(
  page: Page,
  setup: (vault: FakeVault) => Promise<void> = async () => {},
): Promise<{ vault: FakeVault; host: FakeHost }> {
  const vault = await createVault();
  await vault.write('one.md', '# One\n\nFirst note.\n');
  await setup(vault);
  const host = await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return { vault, host };
}

const pages = (page: Page) => sidebarSection(page, 'userSpace');
const row = (page: Page, name: string) => pages(page).getByRole('treeitem', { name, exact: true });

/** Opens a row's menu from its "Options" button and runs one command. */
async function rowCommand(page: Page, name: string, command: RegExp) {
  await row(page, name).hover();
  await pages(page)
    .getByRole('button', { name: `Options for ${name}`, exact: true })
    .click();
  await page.getByRole('menuitem', { name: command }).click();
}

/** Types at the end of a line of the open note's body. */
async function typeAfter(page: Page, line: string, text: string) {
  await caretAtLineEnd(page.getByLabel('Note', { exact: true }).getByText(line));
  await page.keyboard.type(text);
}

/** Types into the open note's body, after its first line. */
const typeInNote = (page: Page, text: string) => typeAfter(page, 'First note.', text);

test('a folder made from the Pages "+" takes a new note that saves inside it', async ({ page }) => {
  const { vault } = await openVault(page);

  await page.getByRole('button', { name: 'New in Pages' }).click();
  await page.getByRole('menuitem', { name: 'New folder' }).click();
  // It is named in place, as Finder does.
  const name = pages(page).getByRole('textbox', { name: 'Name for New folder' });
  await expect(name).toBeFocused();
  await name.fill('Projects');
  await name.press('Enter');
  await expect(row(page, 'Projects')).toBeVisible();
  await expect.poll(() => vault.isFolder('Projects')).toBe(true);
  await expect.poll(() => vault.isFolder('New folder')).toBe(false);

  await rowCommand(page, 'Projects', /^New note here/);
  await expect(page.getByRole('article', { name: 'Untitled', exact: true })).toBeVisible();
  // An empty file reads as '' too, so that it exists is checked first.
  await expect.poll(() => vault.exists('Projects/Untitled.md')).toBe(true);
  await expectFile(vault, 'Projects/Untitled.md').toBe('');

  await page.getByLabel('Note', { exact: true }).click();
  await page.keyboard.type('Filed where it belongs.');
  await expectFile(vault, 'Projects/Untitled.md').toBe('Filed where it belongs.\n');
  expect(await vault.read('Untitled.md')).toBe('');
});

test('moving an open note with unsaved typing keeps the typing, at the new path', async ({
  page,
}) => {
  const { vault } = await openVault(page, (at) => at.mkdir('Projects'));

  await row(page, 'one').click();
  await typeInNote(page, ' Typed, not saved.');
  await expect(page.getByText('Unsaved')).toBeVisible();

  await pageCommand(page, /^Move to…/);
  const picker = page.getByRole('dialog', { name: 'Move one to…' });
  await expect(picker.getByRole('option', { name: /^Pages$/ })).toHaveCount(0);
  await picker.getByRole('option', { name: /Projects/ }).click();

  await expectFile(vault, 'Projects/one.md').toBe('# One\n\nFirst note. Typed, not saved.\n');
  await expect.poll(() => vault.exists('one.md')).toBe(false);
  // The same page, still open, now in the folder it went to.
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toHaveText(/^Projects\/one$/i);
  await expect(page.getByText('First note. Typed, not saved.')).toBeVisible();

  // And it goes on saving there.
  await typeAfter(page, 'First note. Typed, not saved.', ' More.');
  await expectFile(vault, 'Projects/one.md').toBe('# One\n\nFirst note. Typed, not saved. More.\n');
  await expectSaved(page);
  await expect.poll(() => vault.exists('one.md')).toBe(false);
});

test('a note deleted from Pages goes to the Trash, and its pane closes', async ({ page }) => {
  const { vault, host } = await openVault(page, (at) => at.write('two.md', '# Two\n'));

  await row(page, 'one').click();
  await expect(page.getByRole('article', { name: /^one$/i })).toBeVisible();

  await rowCommand(page, 'one', /^Delete…/);
  const question = page.getByRole('alertdialog', { name: 'Move “one” to the Trash?' });
  await expect(question).toContainText('You can get it back from the Trash in Finder.');
  await question.getByRole('button', { name: 'Move to Trash' }).click();

  await expect(row(page, 'one')).toHaveCount(0);
  await expect(row(page, 'two')).toBeVisible();
  await expect.poll(() => vault.exists('one.md')).toBe(false);
  expect(host.trashed()).toEqual(['one.md']);
  await expect(page.getByText('Select a note to read it.')).toBeVisible();
});

test('deleting a folder says how many notes go with it, and Cancel keeps them', async ({
  page,
}) => {
  const { vault, host } = await openVault(page, async (at) => {
    await at.mkdir('Old/Deeper');
    await at.write('Old/a.md', '# A\n');
    await at.write('Old/Deeper/b.md', '# B\n');
  });

  await rowCommand(page, 'Old', /^Delete…/);
  const question = page.getByRole('alertdialog', { name: 'Move “Old” to the Trash?' });
  await expect(question).toContainText('The 2 notes in it go too.');
  await question.getByRole('button', { name: 'Cancel' }).click();
  await expect(question).toHaveCount(0);
  expect(await vault.read('Old/Deeper/b.md')).toBe('# B\n');

  await rowCommand(page, 'Old', /^Delete…/);
  await page.getByRole('button', { name: 'Move to Trash' }).click();
  await expect(row(page, 'Old')).toHaveCount(0);
  await expect.poll(() => vault.exists('Old')).toBe(false);
  expect(host.trashed()).toEqual(['Old']);
});

test('deleting a note with unsaved typing asks, naming what would be lost', async ({ page }) => {
  const { vault } = await openVault(page);

  await row(page, 'one').click();
  await typeInNote(page, ' Not kept.');
  await rowCommand(page, 'one', /^Delete…/);

  const question = page.getByRole('alertdialog');
  await expect(question.getByRole('alert')).toHaveText('Unsaved changes to one will be lost.');
  await question.getByRole('button', { name: 'Move to Trash' }).click();
  await expect.poll(() => vault.exists('one.md')).toBe(false);
  // Nothing tried to save the typing back into a note that is gone.
  await expect(page.getByRole('alert').filter({ hasText: /kept|changed on disk/ })).toHaveCount(0);
  await expect.poll(() => vault.exists('one.md')).toBe(false);
});

const DASHBOARD = ['---', 'atlas: dashboard', 'widgets: []', '---', ''].join('\n');

test('a dashboard can be deleted from its own "…" menu', async ({ page }) => {
  const { vault, host } = await openVault(page, async (at) => {
    await at.mkdir('.atlas/dashboards');
    await at.write('.atlas/dashboards/Progress.md', DASHBOARD);
  });
  const dashboards = sidebarSection(page, 'dashboards');
  await dashboards.getByRole('button', { name: 'Progress', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Progress' })).toBeVisible();

  // A dashboard stays where DFAI keeps it: it can go, but not move.
  await page.getByRole('button', { name: 'More' }).click();
  // The menu is open before its absence is read, or the check passes on nothing.
  const remove = page.getByRole('menuitem', { name: /^Delete…/ });
  await expect(remove).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /^Move to…/ })).toHaveCount(0);
  await remove.click();
  await page
    .getByRole('alertdialog', { name: 'Move “Progress” to the Trash?' })
    .getByRole('button', { name: 'Move to Trash' })
    .click();

  await expect(dashboards.getByRole('button', { name: 'Progress', exact: true })).toHaveCount(0);
  await expect.poll(() => vault.exists('.atlas/dashboards/Progress.md')).toBe(false);
  expect(host.trashed()).toEqual(['.atlas/dashboards/Progress.md']);
});

test('a note dragged onto a folder moves into it', async ({ page }) => {
  const { vault } = await openVault(page, (at) => at.mkdir('Projects'));

  await dragWithPointer(page, {
    from: row(page, 'one'),
    to: row(page, 'Projects'),
    overText: 'is over Projects.',
  });

  await expect.poll(() => vault.exists('Projects/one.md')).toBe(true);
  await expect.poll(() => vault.exists('one.md')).toBe(false);
  // The folder opens to show where it went.
  await expect(row(page, 'Projects')).toHaveAttribute('aria-expanded', 'true');
  await expect(row(page, 'one')).toBeVisible();
});

test('a note moves into a folder from the keyboard alone', async ({ page }) => {
  const { vault } = await openVault(page, async (at) => {
    await at.mkdir('Archive');
    await at.mkdir('Projects');
  });

  // Picked up with Space, carried down past Archive to Projects, dropped with Space.
  await row(page, 'one').focus();
  await page.keyboard.press('Space');
  await expect(dragAnnouncement(page)).toContainText('Picked up one.');
  await keyboardSensorListening(page);
  await page.keyboard.press('ArrowUp');
  await expect(dragAnnouncement(page)).toContainText('one is over Projects.');
  await page.keyboard.press('Space');
  await expect(dragAnnouncement(page)).toContainText('one moved to Projects.');
  await expect.poll(() => vault.exists('Projects/one.md')).toBe(true);

  // And back out through the menu and the picker, by keys only — from the row
  // as it is now, inside the folder.
  await expect(row(page, 'one')).toHaveCount(1);
  await expect(row(page, 'one')).toHaveAttribute('aria-level', '2');
  await row(page, 'one').focus();
  await page.keyboard.press('Shift+F10');
  await page.getByRole('menuitem', { name: /^Move to…/ }).press('Enter');
  const picker = page.getByRole('dialog', { name: 'Move one to…' });
  await expect(picker.getByRole('searchbox', { name: 'Find a folder' })).toBeFocused();
  await page.keyboard.type('Pag');
  await page.keyboard.press('Enter');
  await expect.poll(() => vault.exists('one.md')).toBe(true);
  await expect.poll(() => vault.exists('Projects/one.md')).toBe(false);
});

test('a folder is renamed in place, and a note open inside it follows', async ({ page }) => {
  const { vault } = await openVault(page, async (at) => {
    await at.mkdir('Drafts');
    await at.write('Drafts/plan.md', '# Plan\n\nThe plan.\n');
  });
  await row(page, 'Drafts').click();
  await row(page, 'plan').click();
  await expect(page.getByRole('article', { name: /^plan$/i })).toBeVisible();

  await rowCommand(page, 'Drafts', /^Rename/);
  const name = pages(page).getByRole('textbox', { name: 'Name for Drafts' });
  await name.fill('Final');
  await name.press('Enter');

  await expect(row(page, 'Final')).toBeVisible();
  await expect.poll(() => vault.exists('Final/plan.md')).toBe(true);
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toHaveText(/^Final\/plan$/i);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('renaming a note offers to update the links to it, and updates them, open panes too', async ({
  page,
}) => {
  const { vault } = await openVault(page, async (at) => {
    await at.write('plan.md', '# Plan\n\nThe plan.\n');
    await at.write('two.md', '# Two\n\nSee [[plan]] first.\n');
    await at.write('three.md', '---\nproject: "[[plan]]"\n---\n\nAnd [[plan|the plan]].\n');
  });
  await row(page, 'two').click();
  await expect(page.getByRole('article', { name: /^two$/i })).toBeVisible();

  await rowCommand(page, 'plan', /^Rename/);
  const name = pages(page).getByRole('textbox', { name: 'Name for plan' });
  await name.fill('Roadmap');
  await name.press('Enter');

  const offer = page.getByRole('alert').filter({ hasText: 'still point at “plan”' });
  await expect(offer).toHaveText('3 links in 2 notes still point at “plan”.');
  // Nothing is rewritten until asked.
  await expectFile(vault, 'two.md').toContain('[[plan]]');
  await page.getByRole('button', { name: 'Update 3 links' }).click();

  await expectFile(vault, 'two.md').toBe('# Two\n\nSee [[Roadmap]] first.\n');
  await expectFile(vault, 'three.md').toBe(
    '---\nproject: "[[Roadmap]]"\n---\n\nAnd [[Roadmap|the plan]].\n',
  );
  await expect(offer).toHaveCount(0);
  // The pane holding two.md reads it again and shows the new name.
  await expect(
    page.getByLabel('Note', { exact: true }).getByText('Roadmap', { exact: true }),
  ).toBeVisible();
});
