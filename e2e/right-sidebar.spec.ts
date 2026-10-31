/**
 * UI v2 slice 8b (#306): the right sidebar, wired. It shows what has the
 * focus — the tab's note, or a table's focused row — its open state is
 * remembered per vault, ⌥⌘\ and the bar's button toggle it, the chat is its
 * Claude tab, and a narrow window folds it before the left sidebar.
 */
import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, sidebarSection, type FakeVault } from './host.ts';

const TASK_TYPE = [
  '---',
  'name: task',
  'label: Task',
  'properties:',
  '  owner: text',
  '  status:',
  '    kind: select',
  '    options: [next, done]',
  '---',
  '',
].join('\n');

const SHIP = [
  '---',
  'type: task',
  'owner: Mara Quill',
  'status: next',
  '---',
  '',
  '# Ship it',
  '',
  'See [[Plan]] first.',
  '',
  '## Steps',
  '',
  'Build, then verify.',
  '',
  '## Expected',
  '',
  'Green.',
  '',
].join('\n');

const PLAN = [
  '---',
  'type: task',
  'owner: Tobias Fenn',
  'status: next',
  '---',
  '',
  '# Plan',
  '',
].join('\n');

/** A saved view of the tasks as a table: a note with a table in its body. */
const TASKS_VIEW = [
  '---',
  'atlas: view',
  'type: task',
  'layout: table',
  'columns: [owner, status]',
  '---',
  '',
  '# All tasks',
  '',
].join('\n');

async function openVault(
  page: Page,
  { withView = false, width = 1440 }: { withView?: boolean; width?: number } = {},
): Promise<FakeVault> {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  if (withView) {
    await vault.mkdir('.atlas/views');
    await vault.write('.atlas/views/All tasks.md', TASKS_VIEW);
  }
  await vault.write('Ship it.md', SHIP);
  await vault.write('Plan.md', PLAN);
  await installHost(page, vault);
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return vault;
}

const aside = (page: Page) => page.getByRole('complementary', { name: 'Right sidebar' });
// Exact: a note called "The right sidebar" would have an "Options for…" button that matches too.
const toggle = (page: Page) =>
  page.getByRole('button', { name: 'Right sidebar', exact: true }).first();
const leftSidebar = (page: Page) => page.getByRole('navigation', { name: 'Vault' });

async function openNote(page: Page, name: string) {
  await page.getByRole('treeitem', { name, exact: true }).click();
  await expect(page.getByRole('article', { name })).toBeVisible();
}

const altCmdBackslash = async (page: Page) => {
  await page.keyboard.down('Meta');
  await page.keyboard.down('Alt');
  await page.keyboard.press('Backslash');
  await page.keyboard.up('Alt');
  await page.keyboard.up('Meta');
};

test('the bar’s button and ⌥⌘\\ show and hide it, and ⌘\\ still hides the left sidebar', async ({
  page,
}) => {
  await openVault(page);
  await openNote(page, 'Ship it');
  await expect(aside(page)).toHaveCount(0);
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');

  await toggle(page).click();
  await expect(aside(page)).toBeVisible();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');

  await altCmdBackslash(page);
  await expect(aside(page)).toHaveCount(0);
  await altCmdBackslash(page);
  await expect(aside(page)).toBeVisible();

  await page.keyboard.press('Meta+Backslash');
  await expect(leftSidebar(page)).toHaveCount(0);
  await expect(aside(page)).toBeVisible();
  await page.keyboard.press('Meta+Backslash');
  await expect(leftSidebar(page)).toBeVisible();

  await aside(page).getByRole('button', { name: 'Hide right sidebar' }).click();
  await expect(aside(page)).toHaveCount(0);
});

test('its open state and tab are remembered across a reload, per vault', async ({ page }) => {
  await openVault(page);
  await openNote(page, 'Ship it');
  await toggle(page).click();
  await aside(page).getByRole('tab', { name: 'Outline' }).click();
  await expect(aside(page).getByRole('tab', { name: 'Outline' })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  // A reload stands in for quitting: the vault reopens on its own.
  await page.reload();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await expect(aside(page)).toBeVisible();
  await expect(aside(page).getByRole('tab', { name: 'Outline' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('it shows the open note: its properties write the file, its outline and backlinks are the note’s', async ({
  page,
}) => {
  const vault = await openVault(page);
  await openNote(page, 'Ship it');
  await toggle(page).click();

  const panel = aside(page);
  await expect(panel.getByRole('heading', { name: 'Ship it' })).toBeVisible();
  // The properties leave the body while the aside shows them: one editor for the note.
  await expect(
    page.getByRole('article', { name: 'Ship it' }).getByRole('region', {
      name: 'Properties',
    }),
  ).toHaveCount(0);
  const owner = panel.getByRole('textbox', { name: 'Owner' });
  await expect(owner).toHaveValue('Mara Quill');
  await owner.fill('Tobias Fenn');
  await owner.press('Enter');
  await expectFile(vault, 'Ship it.md').toMatch(/\nowner: Tobias Fenn\n/);

  await panel.getByRole('tab', { name: 'Outline' }).click();
  const outline = panel.getByRole('navigation', { name: 'Outline' });
  await expect(outline.getByRole('button')).toHaveText(['Ship it', 'Steps', 'Expected']);

  await panel.getByRole('tab', { name: 'Backlinks' }).click();
  await expect(panel.getByText('Nothing links here yet.')).toBeVisible();
  // Switching notes switches what the aside follows: Plan is linked from Ship it.
  await openNote(page, 'Plan');
  await expect(
    panel.getByRole('region', { name: 'Links here' }).getByRole('button', { name: /^Ship it/ }),
  ).toBeVisible();
  await panel.getByRole('tab', { name: 'Properties' }).click();
  await expect(panel.getByRole('heading', { name: 'Plan' })).toBeVisible();
});

test('selecting a table row shows the row’s properties, and editing one writes its file', async ({
  page,
}) => {
  const vault = await openVault(page);
  await sidebarSection(page, 'types')
    .getByRole('button', { name: /^Task, / })
    .click();
  const table = page.getByRole('article', { name: 'Task', exact: true });
  await expect(table.getByRole('button', { name: 'Plan' })).toBeVisible();
  await toggle(page).click();
  // A type's page also offers its editor, first (slice 12); Properties stays the tab chosen.
  await expect(aside(page).getByRole('tab')).toHaveText(['Type', 'Properties', 'Claude']);
  await expect(aside(page).getByText(/Nothing selected/)).toBeVisible();

  // The focus landing in a row's cell — here Plan's owner — is the selection; the note stays shut.
  await table.getByRole('button', { name: 'Tobias Fenn' }).focus();
  const panel = aside(page);
  await expect(panel.getByText('Task · selected row')).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Plan' })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Plan', exact: true })).toHaveCount(0);

  const owner = panel.getByRole('textbox', { name: 'Owner' });
  await expect(owner).toHaveValue('Tobias Fenn');
  await owner.fill('Mara Quill');
  await owner.press('Enter');
  await expectFile(vault, 'Plan.md').toMatch(/\nowner: Mara Quill\n/);
  // Ship it's owner is already Mara Quill, so only Plan's own row proves the edit landed.
  const planRow = table
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name: 'Plan', exact: true }) });
  await expect(planRow.getByRole('button', { name: 'Mara Quill', exact: true })).toBeVisible();
});

test('a row focused in a view’s table gives way once the focus returns to the page around it', async ({
  page,
}) => {
  await openVault(page, { withView: true });
  await sidebarSection(page, 'views')
    .getByRole('button', { name: 'All tasks', exact: true })
    .click();
  const view = page.getByRole('article', { name: 'All tasks' });
  await expect(view.getByRole('button', { name: 'Tobias Fenn' })).toBeVisible();
  await toggle(page).click();
  const panel = aside(page);
  await expect(panel.getByRole('heading', { name: 'All tasks' })).toBeVisible();

  await view.getByRole('button', { name: 'Tobias Fenn' }).focus();
  await expect(panel.getByText('Task · selected row')).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Plan' })).toBeVisible();

  // The focus landing on the page around the table — its bar's More, which sits
  // above the article in the same tab — lets the row go.
  await page.getByRole('button', { name: 'More' }).first().focus();
  await expect(panel.getByRole('heading', { name: 'All tasks' })).toBeVisible();
  await expect(panel.getByText('Task · selected row')).toHaveCount(0);
});

test('⇧⌘J seats Claude in the aside’s Claude tab, and closes it from there', async ({ page }) => {
  await openVault(page);
  await openNote(page, 'Ship it');
  await page.keyboard.press('Meta+Shift+KeyJ');
  const panel = aside(page);
  await expect(panel.getByRole('tab', { name: 'Claude' })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByRole('complementary', { name: 'Claude' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Claude' }).first()).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // Another tab keeps the aside up; ⇧⌘J then brings Claude back rather than closing.
  await panel.getByRole('tab', { name: 'Properties' }).click();
  await expect(panel.getByRole('complementary', { name: 'Claude' })).toHaveCount(0);
  await page.keyboard.press('Meta+Shift+KeyJ');
  await expect(panel.getByRole('complementary', { name: 'Claude' })).toBeVisible();
  await page.keyboard.press('Meta+Shift+KeyJ');
  await expect(aside(page)).toHaveCount(0);
});

test('a narrow window folds the right sidebar first, and the left one stays', async ({ page }) => {
  await openVault(page);
  await openNote(page, 'Ship it');
  await toggle(page).click();
  await expect(aside(page)).toBeVisible();

  // 1000px: the sidebar's 224 + the aside's 300 leave the work under its 496 floor.
  await page.setViewportSize({ width: 1000, height: 800 });
  await expect(aside(page)).toHaveCount(0);
  await expect(leftSidebar(page)).toBeVisible();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');

  // Hiding the left sidebar by hand makes room: the aside comes back, still remembered open.
  await page.keyboard.press('Meta+Backslash');
  await expect(leftSidebar(page)).toHaveCount(0);
  await expect(aside(page)).toBeVisible();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.keyboard.press('Meta+Backslash');
  await expect(leftSidebar(page)).toBeVisible();
  await expect(aside(page)).toBeVisible();
});

test('Escape in the aside returns the focus to the work', async ({ page }) => {
  await openVault(page);
  await openNote(page, 'Ship it');
  await toggle(page).click();
  const tab = aside(page).getByRole('tab', { name: 'Properties' });
  await tab.focus();
  await page.keyboard.press('Escape');
  await expect(tab).not.toBeFocused();
  await expect(page.locator('.pane--focused')).toBeFocused();
});

test.describe('a narrow window, asked for the aside twice (#387 verification)', () => {
  const chat = (page: Page) => page.getByRole('complementary', { name: 'Claude' });

  test('⇧⌘J, then ⌘\\ bringing the sidebar back, then ⇧⌘J again shows Claude', async ({ page }) => {
    await openVault(page, { width: 1000 });
    await openNote(page, 'Ship it');
    await page.keyboard.press('Meta+Shift+KeyJ');
    await expect(chat(page)).toBeVisible();
    await expect(leftSidebar(page)).toHaveCount(0);
    // The sidebar back: the window is too narrow for both, so the aside folds.
    await page.keyboard.press('Meta+Backslash');
    await expect(leftSidebar(page)).toBeVisible();
    await expect(chat(page)).toHaveCount(0);
    // Asked for again, Claude comes back on screen: one press, not three.
    await page.keyboard.press('Meta+Shift+KeyJ');
    await expect(chat(page)).toBeVisible();
    await expect(leftSidebar(page)).toHaveCount(0);
  });

  test('the bar’s button, in the same state, changes what is on screen and says so', async ({
    page,
  }) => {
    await openVault(page, { width: 1000 });
    await openNote(page, 'Ship it');
    await toggle(page).click();
    await expect(aside(page)).toBeVisible();
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Meta+Backslash');
    await expect(leftSidebar(page)).toBeVisible();
    await expect(aside(page)).toHaveCount(0);
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
    await toggle(page).click();
    await expect(aside(page)).toBeVisible();
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(leftSidebar(page)).toHaveCount(0);
  });

  test('⌥⌘\\ in the same state shows the aside with one press', async ({ page }) => {
    await openVault(page, { width: 1000 });
    await openNote(page, 'Ship it');
    await altCmdBackslash(page);
    await expect(aside(page)).toBeVisible();
    await page.keyboard.press('Meta+Backslash');
    await expect(aside(page)).toHaveCount(0);
    await altCmdBackslash(page);
    await expect(aside(page)).toBeVisible();
  });

  test('at 750px, where hiding the sidebar would make no room, ⇧⌘J leaves it as it was', async ({
    page,
  }) => {
    await openVault(page, { width: 750 });
    await openNote(page, 'Ship it');
    await page.keyboard.press('Meta+Shift+KeyJ');
    await expect(leftSidebar(page)).toBeVisible();
    await expect(chat(page)).toHaveCount(0);
  });
});
