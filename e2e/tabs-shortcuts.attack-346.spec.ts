import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, sidebarSection, type FakeVault } from './host.ts';
import { caretAtLineEnd } from './caret.ts';

/*
 * Attack on #346: the tab shortcuts and the click routes against the text
 * being edited, and against where each kind of click is meant to land.
 */

const TASK_TYPE = [
  '---',
  'name: task',
  'label: Task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [backlog, doing, done]',
  '---',
  '',
].join('\n');

const task = (title: string, status: string) =>
  ['---', 'type: task', `status: ${status}`, '---', '', `# ${title}`, ''].join('\n');

async function openVault(page: Page): Promise<FakeVault> {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write('first.md', task('First', 'doing'));
  await vault.write('second.md', task('Second', 'backlog'));
  await vault.write('alpha.md', '# alpha\n\nSee [[beta]] for more.\n');
  await vault.write('beta.md', '# beta\n\nLine of beta.\n');
  await vault.write('gamma.md', '# gamma\n\nLine of gamma.\n');
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

/** Beta in one tab, then the Task table in a second one, shown. */
async function noteThenTable(page: Page) {
  await row(page, 'beta').click();
  await expect(article(page, 1, 'beta')).toBeVisible();
  await page.keyboard.press('Meta+t');
  await sidebarSection(page, 'types')
    .getByRole('button', { name: /^Task, \d+ notes?$/ })
    .click();
  await expect(page.locator('.table__link', { hasText: 'First' })).toBeVisible();
  await expect(tabsOf(page, 1)).toHaveCount(2);
}

/** Opens First's status cell for editing and types a new value, without committing it. */
async function typeIntoStatusCell(page: Page, value: string) {
  await page.getByRole('button', { name: 'Doing', exact: true }).click();
  const input = page.locator('.table__input');
  await expect(input).toBeFocused();
  await page.keyboard.press('Meta+a');
  await page.keyboard.type(value);
}

for (const [chord, label] of [
  ['Control+Tab', '⌃Tab'],
  ['Meta+1', '⌘1'],
  ['Meta+w', '⌘W'],
] as const) {
  test(`${label} while typing in a table cell does not throw the typed value away`, async ({
    page,
  }) => {
    const vault = await openVault(page);
    await noteThenTable(page);
    await typeIntoStatusCell(page, 'done');
    await page.keyboard.press(chord);
    // Either the shortcut waits for the cell, or the cell's value is written
    // as the table goes; never the typing gone with the table.
    await expect
      .poll(
        async () =>
          (await vault.read('first.md')).includes('status: done') ||
          ((await page.locator('.table__input').count()) === 1 &&
            (await page.locator('.table__input').inputValue()) === 'done'),
        { timeout: 15_000 },
      )
      .toBe(true);
  });
}

test('⌘1 in the search palette leaves the palette, its query and the tabs as they were', async ({
  page,
}) => {
  await openVault(page);
  await row(page, 'beta').click();
  await row(page, 'gamma').click({ modifiers: ['Meta'] });
  await expect(tab(page, 1, 'gamma')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Meta+k');
  const search = page.getByLabel('Search the vault', { exact: true });
  await expect(search).toBeFocused();
  await page.keyboard.type('bet');
  await page.keyboard.press('Meta+1');
  await expect(search).toBeVisible();
  await expect(search).toHaveValue('bet');
  await page.keyboard.press('Escape');
  await expect(search).toHaveCount(0);
  await expect(tab(page, 1, 'gamma')).toHaveAttribute('aria-selected', 'true');
});

test('⌃T in the editor is the Mac’s transpose, not a new tab', async ({ page }) => {
  const vault = await openVault(page);
  await row(page, 'beta').click();
  await caretAtLineEnd(article(page, 1, 'beta').getByText('Line of beta.'));
  await page.keyboard.type(' ab');
  await page.keyboard.press('Control+t');
  await expect(tabsOf(page, 1)).toHaveText(['beta']);
  await expectFile(vault, 'beta.md').toBe('# beta\n\nLine of beta. ba\n');
});

test('⌘⇧T reopens the most recently closed tab first, then the one before', async ({ page }) => {
  await openVault(page);
  await row(page, 'alpha').click();
  await row(page, 'beta').click({ modifiers: ['Meta'] });
  await row(page, 'gamma').click({ modifiers: ['Meta'] });
  await expect(tabsOf(page, 1)).toHaveText(['alpha', 'beta', 'gamma']);
  await tab(page, 1, 'beta').click();
  await expect(tab(page, 1, 'beta')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Meta+w');
  await expect(tabsOf(page, 1)).toHaveText(['alpha', 'gamma']);
  await tab(page, 1, 'alpha').click();
  await page.keyboard.press('Meta+w');
  await expect(tabsOf(page, 1)).toHaveText(['gamma']);
  await page.keyboard.press('Meta+Shift+t');
  await expect(tabsOf(page, 1)).toHaveCount(2);
  await expect(tab(page, 1, 'alpha')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Meta+Shift+t');
  await expect(tabsOf(page, 1)).toHaveCount(3);
  await expect(tab(page, 1, 'beta')).toHaveAttribute('aria-selected', 'true');
  await expect(article(page, 1, 'beta')).toBeVisible();
});

test('⌘-click on a table row’s title opens the note in a new tab, keeping the table', async ({
  page,
}) => {
  await openVault(page);
  await noteThenTable(page);
  await page.locator('.table__link', { hasText: 'First' }).click({ modifiers: ['Meta'] });
  await expect(tabsOf(page, 1)).toHaveCount(3);
  await expect(article(page, 1, 'first')).toBeVisible();
});

test('⌘⇧-click on a table row’s title opens the note beside, in a split', async ({ page }) => {
  await openVault(page);
  await noteThenTable(page);
  await page.locator('.table__link', { hasText: 'First' }).click({ modifiers: ['Meta', 'Shift'] });
  await expect(article(page, 2, 'first')).toBeVisible();
  await expect(page.locator('.table__link', { hasText: 'First' })).toBeVisible();
});

test('a plain click on a table row’s title peeks the note; expand opens it in the table’s tab', async ({
  page,
}) => {
  await openVault(page);
  await noteThenTable(page);
  await page.locator('.table__link', { hasText: 'First' }).click();
  // Slice 6b: the peek over the table, which stays its tab's page.
  await expect(page.locator('.peek')).toBeVisible();
  // By CSS: the modal peek hides the page under it from role queries.
  await expect(
    page.locator('[aria-label="Pane 1"] .table__link', { hasText: 'First' }),
  ).toBeAttached();
  await page.locator('.peek').getByRole('button', { name: 'Open as full page' }).click();
  await expect(article(page, 1, 'first')).toBeVisible();
  await expect(tabsOf(page, 1)).toHaveCount(2);
});

test('⌘-click on a link in a note opens it in a new tab, keeping the note', async ({ page }) => {
  await openVault(page);
  await row(page, 'alpha').click();
  await expect(article(page, 1, 'alpha')).toBeVisible();
  await article(page, 1, 'alpha')
    .getByRole('link', { name: 'beta' })
    .click({ modifiers: ['Meta'] });
  await expect(tabsOf(page, 1)).toHaveText(['alpha', 'beta']);
});

test('a plain click on a link in a note peeks it; expand follows it in the same tab', async ({
  page,
}) => {
  await openVault(page);
  await row(page, 'alpha').click();
  await expect(article(page, 1, 'alpha')).toBeVisible();
  await article(page, 1, 'alpha').getByRole('link', { name: 'beta' }).click();
  // Slice 6b: the peek over the note, which stays where it was.
  await expect(page.locator('.peek')).toBeVisible();
  // By CSS: the modal peek hides the page under it from role queries.
  await expect(page.locator('[aria-label="Pane 1"] article[aria-label="alpha"]')).toBeVisible();
  await page.locator('.peek').getByRole('button', { name: 'Open as full page' }).click();
  await expect(article(page, 1, 'beta')).toBeVisible();
  await expect(tabsOf(page, 1)).toHaveText(['beta']);
});
