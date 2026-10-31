import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, expectSaved, installHost, sidebarSection } from './host.ts';
import { caretAtLineEnd } from './caret.ts';

/*
 * Tabs in panes (docs/design/tab-model.md, UI v2 7b, Performance 8). What
 * matters is where a click lands and what each tab keeps for itself: its
 * history, its undo, its typing.
 */

const TASK_TYPE = ['---', 'name: task', 'label: Task', 'properties:', '  status: text', '---', ''];

async function openVault(page: Page) {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.write('.atlas/types/task.md', TASK_TYPE.join('\n'));
  await vault.write('alpha.md', '# Alpha\n\nThe first note.\n');
  await vault.write('beta.md', '# Beta\n\nThe second note.\n');
  await vault.write('gamma.md', '# Gamma\n\nThe third note.\n');
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return vault;
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

/** Opens alpha, then beta in a new tab beside it. */
async function alphaThenBetaInTabs(page: Page) {
  await row(page, 'alpha').click();
  await expect(article(page, 1, 'alpha')).toBeVisible();
  await row(page, 'beta').click({ modifiers: ['Meta'] });
  await expect(article(page, 1, 'beta')).toBeVisible();
  await expect(tabsOf(page, 1)).toHaveText(['alpha', 'beta']);
}

test('⌘-click on a sidebar row opens the note in a new tab beside the active one', async ({
  page,
}) => {
  await openVault(page);
  await alphaThenBetaInTabs(page);
  await expect(tab(page, 1, 'beta')).toHaveAttribute('aria-selected', 'true');
  // Alpha is still there behind it, untouched.
  await tab(page, 1, 'alpha').click();
  await expect(article(page, 1, 'alpha')).toBeVisible();
  await expect(tabsOf(page, 1)).toHaveText(['alpha', 'beta']);
});

test('a plain click on a note already open activates its tab rather than opening it again', async ({
  page,
}) => {
  await openVault(page);
  await alphaThenBetaInTabs(page);
  await row(page, 'alpha').click();
  await expect(tab(page, 1, 'alpha')).toHaveAttribute('aria-selected', 'true');
  await expect(tabsOf(page, 1)).toHaveText(['alpha', 'beta']);
  // A note no tab holds replaces the active tab's page.
  await row(page, 'gamma').click();
  await expect(tabsOf(page, 1)).toHaveText(['gamma', 'beta']);
});

test('a restart brings the tabs back, with the active one and its history', async ({ page }) => {
  await openVault(page);
  await alphaThenBetaInTabs(page);
  await row(page, 'gamma').click();
  await expect(tabsOf(page, 1)).toHaveText(['alpha', 'gamma']);

  // A reload stands in for quitting and relaunching.
  await page.reload();

  await expect(tabsOf(page, 1)).toHaveText(['alpha', 'gamma']);
  await expect(tab(page, 1, 'gamma')).toHaveAttribute('aria-selected', 'true');
  await expect(article(page, 1, 'gamma')).toBeVisible();
  // Gamma's tab came back with where it had been: Back leads to beta.
  await expect(page.getByRole('button', { name: 'Back', exact: true })).toHaveAttribute(
    'title',
    'Back to beta (⌘[)',
  );
});

test("each tab's Back is its own", async ({ page }) => {
  await openVault(page);
  await row(page, 'alpha').click();
  await expect(article(page, 1, 'alpha')).toBeVisible();
  await row(page, 'beta').click();
  await expect(article(page, 1, 'beta')).toBeVisible();
  await row(page, 'gamma').click({ modifiers: ['Meta'] });
  await expect(article(page, 1, 'gamma')).toBeVisible();

  // The new tab started on gamma: nothing to go back to.
  const back = page.getByRole('button', { name: 'Back', exact: true });
  await expect(back).toBeDisabled();
  await tab(page, 1, 'beta').click();
  await expect(article(page, 1, 'beta')).toBeVisible();
  await expect(back).toHaveAttribute('title', 'Back to alpha (⌘[)');
  await page.keyboard.press('Meta+[');
  await expect(article(page, 1, 'alpha')).toBeVisible();
  await expect(tabsOf(page, 1)).toHaveText(['alpha', 'gamma']);
});

test('typing in one tab, switching away and back, then ⌘Z undoes in that tab alone', async ({
  page,
}) => {
  const vault = await openVault(page);
  await alphaThenBetaInTabs(page);
  await tab(page, 1, 'alpha').click();
  await caretAtLineEnd(page.getByText('The first note.'));
  await page.keyboard.type(' Edited.');
  await expect(page.getByText('The first note. Edited.')).toBeVisible();

  // Switching away writes the typing; the editor waits behind beta with its undo.
  await tab(page, 1, 'beta').click();
  await expect(article(page, 1, 'beta')).toBeVisible();
  await expectFile(vault, 'alpha.md').toBe('# Alpha\n\nThe first note. Edited.\n');
  await caretAtLineEnd(page.getByText('The second note.'));
  await page.keyboard.type(' Also edited.');
  await expect(page.getByText('The second note. Also edited.')).toBeVisible();

  await tab(page, 1, 'alpha').click();
  await expect(page.getByText('The first note. Edited.')).toBeVisible();
  await page.getByText('The first note. Edited.').click();
  await page.keyboard.press('Meta+z');
  await expect(page.getByText('The first note.', { exact: true })).toBeVisible();
  await expect(page.getByText('The first note. Edited.')).toHaveCount(0);
  await expectSaved(pane(page, 1));
  await expectFile(vault, 'alpha.md').toBe('# Alpha\n\nThe first note.\n');
  // Beta's typing was not undone with it.
  await tab(page, 1, 'beta').click();
  await expect(page.getByText('The second note. Also edited.')).toBeVisible();
});

test('⌘W closes the tab and never the window; the last one leaves an empty tab', async ({
  page,
}) => {
  await openVault(page);
  await alphaThenBetaInTabs(page);
  await page.keyboard.press('Meta+w');
  await expect(tabsOf(page, 1)).toHaveText(['alpha']);
  await expect(article(page, 1, 'alpha')).toBeVisible();
  await page.keyboard.press('Meta+w');
  await expect(tabsOf(page, 1)).toHaveText(['New tab']);
  await expect(pane(page, 1)).toBeVisible();
  await expect(sidebarSection(page, 'userSpace')).toBeVisible();
  // ⌘⇧T brings the last closed one back.
  await page.keyboard.press('Meta+Shift+t');
  await expect(tabsOf(page, 1)).toHaveText(['alpha']);
  await expect(article(page, 1, 'alpha')).toBeVisible();
});

test('⌘T opens a new tab, ⌃Tab walks the tabs, and ⌘1–9 jump to one', async ({ page }) => {
  await openVault(page);
  await alphaThenBetaInTabs(page);
  await page.keyboard.press('Meta+t');
  await expect(tabsOf(page, 1)).toHaveText(['alpha', 'beta', 'New tab']);
  await expect(tab(page, 1, 'New tab')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Control+Tab');
  await expect(tab(page, 1, 'alpha')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Control+Shift+Tab');
  await expect(tab(page, 1, 'New tab')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Meta+2');
  await expect(tab(page, 1, 'beta')).toHaveAttribute('aria-selected', 'true');
  await expect(article(page, 1, 'beta')).toBeVisible();
});

test('Today opens in the active tab as a place, with its own Back', async ({ page }) => {
  await openVault(page);
  await row(page, 'alpha').click();
  await expect(article(page, 1, 'alpha')).toBeVisible();
  await page.getByRole('list', { name: 'Go to' }).getByRole('button', { name: 'Today' }).click();
  await expect(page.getByRole('article', { name: 'Today' })).toBeVisible();
  await expect(tabsOf(page, 1)).toHaveText(['Today']);
  await expect(page.getByRole('button', { name: 'Back', exact: true })).toHaveAttribute(
    'title',
    'Back to alpha (⌘[)',
  );
  // And beside it in a new tab, alpha is still there to come back to.
  await row(page, 'beta').click({ modifiers: ['Meta'] });
  await expect(tabsOf(page, 1)).toHaveText(['Today', 'beta']);
  await tab(page, 1, 'Today').click();
  await expect(page.getByRole('article', { name: 'Today' })).toBeVisible();
});

test('⌘⇧-click opens beside, splitting the window, and the strip says which pane is focused', async ({
  page,
}) => {
  await openVault(page);
  await row(page, 'alpha').click();
  await expect(article(page, 1, 'alpha')).toBeVisible();
  await row(page, 'beta').click({ modifiers: ['Meta', 'Shift'] });
  await expect(article(page, 2, 'beta')).toBeVisible();
  await expect(article(page, 1, 'alpha')).toBeVisible();
  await expect(strip(page, 2).locator('..')).toHaveClass(/tab-strip--focused/);
  await expect(strip(page, 1).locator('..')).not.toHaveClass(/tab-strip--focused/);
  // Once split, ⌘⇧-click lands in the other pane's active tab.
  await row(page, 'gamma').click({ modifiers: ['Meta', 'Shift'] });
  await expect(article(page, 1, 'gamma')).toBeVisible();
  await expect(article(page, 2, 'beta')).toBeVisible();
});
