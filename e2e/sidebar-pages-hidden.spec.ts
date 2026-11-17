import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost, sidebarSection } from './host.ts';
import { expectFocusIn, focusOn, focusThenPress } from './typing.ts';

// #902: the sidebar's Pages section is hidden on a first run, and shown from the
// header's "Sidebar options" menu or ⌘K until it is hidden again. Every test
// here runs as a first run does; the rest of the suite starts with Pages shown.

async function openVault(page: Page): Promise<void> {
  const vault = await createVault();
  await vault.mkdir('Notes');
  await vault.write('Garden.md', '# Garden\n\nBeds and paths.\n');
  await vault.write('Notes/Seed list.md', '# Seed list\n');

  await installHost(page, vault, { sidebarAsFirstRun: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
}

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Vault' });
const headings = (page: Page) => sidebar(page).getByRole('heading', { level: 2 });
const pages = (page: Page) => sidebarSection(page, 'userSpace');
const treeItem = (page: Page, name: string) =>
  pages(page).getByRole('treeitem', { name, exact: true });
const optionsButton = (page: Page) => page.getByRole('button', { name: 'Sidebar options' });
const showPagesItem = (page: Page) =>
  page
    .getByRole('menu', { name: 'Sidebar options' })
    .getByRole('menuitemcheckbox', { name: 'Show Pages' });

const WITHOUT_PAGES = ['Favorites', 'Types', 'Views', 'Dashboards'];
const WITH_PAGES = [...WITHOUT_PAGES, 'Pages'];

/** Opens ⌘K and asks it for `words`; the palette's dialog. */
async function palette(page: Page, words: string) {
  await page.keyboard.down('Meta');
  await page.keyboard.press('k');
  await page.keyboard.up('Meta');
  await page.getByRole('searchbox', { name: 'Search the vault' }).fill(words);
  return page.getByRole('dialog', { name: 'Search notes' });
}

test('Pages is hidden on a first run, and no tree is drawn', async ({ page }) => {
  await openVault(page);

  // The other four are there first, so Pages' absence is the sidebar's answer.
  await expect(headings(page)).toHaveText(WITHOUT_PAGES);
  await expect(pages(page)).toHaveCount(0);
  await expect(page.getByRole('tree')).toHaveCount(0);
  await expect(optionsButton(page)).toBeVisible();
});

test('Pages is shown from the header menu by keyboard alone, works, and stays across a reload until hidden', async ({
  page,
}) => {
  await openVault(page);
  await expect(headings(page)).toHaveText(WITHOUT_PAGES);

  // Reached with Tab from the header's New note button, then opened with Enter.
  await focusThenPress(page.getByRole('button', { name: 'New note', exact: true }), 'Tab');
  await expect(optionsButton(page)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(showPagesItem(page)).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('ArrowDown');
  await expect(showPagesItem(page)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(showPagesItem(page)).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(optionsButton(page)).toBeFocused();

  await expect(headings(page)).toHaveText(WITH_PAGES);
  // The tree works as it always has: a folder opens, a note opens.
  await focusThenPress(treeItem(page, 'Notes'), 'ArrowRight');
  await expect(treeItem(page, 'Seed list')).toBeVisible();
  await focusThenPress(treeItem(page, 'Garden'), 'Enter');
  await expect(page.getByRole('article', { name: 'Garden' })).toBeVisible();

  // A reload stands in for quitting and relaunching.
  await page.reload();
  await expect(headings(page)).toHaveText(WITH_PAGES);
  await expect(treeItem(page, 'Garden')).toBeVisible();

  await optionsButton(page).click();
  await expect(showPagesItem(page)).toHaveAttribute('aria-checked', 'true');
  await showPagesItem(page).click();
  await expect(showPagesItem(page)).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Escape');
  await expect(headings(page)).toHaveText(WITHOUT_PAGES);
  await expect(page.getByRole('tree')).toHaveCount(0);

  await page.reload();
  await expect(headings(page)).toHaveText(WITHOUT_PAGES);
  await expect(pages(page)).toHaveCount(0);
});

test('⌘K offers Show Pages while it is hidden and Hide Pages while it is shown, never both', async ({
  page,
}) => {
  await openVault(page);
  await expect(headings(page)).toHaveText(WITHOUT_PAGES);

  let found = await palette(page, 'Pages');
  await expect(found.getByRole('option', { name: 'Show Pages' })).toBeVisible();
  await expect(found.getByRole('option', { name: 'Hide Pages' })).toHaveCount(0);
  await found.getByRole('option', { name: 'Show Pages' }).click();
  await expect(headings(page)).toHaveText(WITH_PAGES);
  await expect(treeItem(page, 'Garden')).toBeVisible();
  // Where the files are, ready for the keyboard.
  await expectFocusIn(pages(page));

  found = await palette(page, 'Pages');
  await expect(found.getByRole('option', { name: 'Hide Pages' })).toBeVisible();
  await expect(found.getByRole('option', { name: 'Show Pages' })).toHaveCount(0);
  await found.getByRole('option', { name: 'Hide Pages' }).click();
  await expect(headings(page)).toHaveText(WITHOUT_PAGES);
  await expect(page.getByRole('tree')).toHaveCount(0);
});

test('hiding Pages from a tree row hands the focus to the Search row, not the page', async ({
  page,
}) => {
  await openVault(page);
  const shown = await palette(page, 'Show Pages');
  await shown.getByRole('option', { name: 'Show Pages' }).click();
  await focusOn(treeItem(page, 'Garden'));

  // ⌘K from the tree row, which is gone by the time the palette closes.
  const hidden = await palette(page, 'Hide Pages');
  await hidden.getByRole('option', { name: 'Hide Pages' }).click();

  await expect(page.getByRole('dialog', { name: 'Search notes' })).toHaveCount(0);
  await expect(page.getByRole('tree')).toHaveCount(0);
  await expect(sidebar(page).getByRole('button', { name: 'Search', exact: true })).toBeFocused();
});

test('⌘K Show Pages brings a hidden sidebar back with Pages in it; Hide Pages leaves the sidebar alone', async ({
  page,
}) => {
  await openVault(page);
  await expect(headings(page)).toHaveText(WITHOUT_PAGES);
  await page.getByRole('button', { name: 'Hide sidebar' }).click();
  await expect(sidebar(page)).toBeHidden();

  const shown = await palette(page, 'Show Pages');
  await shown.getByRole('option', { name: 'Show Pages' }).click();
  await expect(sidebar(page)).toBeVisible();
  await expect(headings(page)).toHaveText(WITH_PAGES);
  await expectFocusIn(pages(page));

  await page.getByRole('button', { name: 'Hide sidebar' }).click();
  await expect(sidebar(page)).toBeHidden();
  const hidden = await palette(page, 'Hide Pages');
  await hidden.getByRole('option', { name: 'Hide Pages' }).click();
  await expect(hidden).toHaveCount(0);
  await expect(sidebar(page)).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('atlas.sidebar.hidden')))
    .toBe('["userSpace"]');
});

for (const [where, width] of [
  ['beside the work', 1280],
  ['in the drawer', 720],
] as const) {
  test(`⌘K Show Pages from inside a note moves the focus to Pages, ${where}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openVault(page);
    const found = await palette(page, 'Garden');
    await found
      .getByRole('option', { name: /Garden/ })
      .first()
      .click();
    const editor = page
      .getByRole('article', { name: 'Garden' })
      .locator('[contenteditable="true"]');
    await editor.click();
    await expectFocusIn(editor);

    const shown = await palette(page, 'Show Pages');
    await shown.getByRole('option', { name: 'Show Pages' }).click();
    await expect(pages(page)).toBeVisible();
    await expectFocusIn(pages(page));
  });
}
