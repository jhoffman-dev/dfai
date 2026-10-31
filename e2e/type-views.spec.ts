/**
 * Issue #11: a type owns its views. Clicking a type shows its views as tabs;
 * the tabs add, rename, copy and delete views, and drag (or Alt+arrow) to
 * reorder, the order kept in each view's own frontmatter (ADR-0023).
 */
import { expect, test, type Page } from './fixtures.ts';
import { dragWithPointer } from './drag.ts';
import {
  createVault,
  expectFile,
  installHost,
  sidebarSection,
  type FakeHost,
  type FakeVault,
} from './host.ts';

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

const PROJECT_TYPE = ['---', 'name: project', 'label: Project', '---', ''].join('\n');
const IDEA_TYPE = ['---', 'name: idea', 'label: Idea', '---', ''].join('\n');

const view = (title: string, layout: string, extra: readonly string[] = []) =>
  [
    '---',
    'atlas: view',
    'type: task',
    `layout: ${layout}`,
    ...extra,
    '---',
    '',
    `# ${title}`,
    '',
  ].join('\n');

async function openVaultWithHost(page: Page): Promise<{ vault: FakeVault; host: FakeHost }> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/views');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write('.atlas/types/project.md', PROJECT_TYPE);
  await vault.write('.atlas/types/idea.md', IDEA_TYPE);
  await vault.write('.atlas/views/Board.md', view('Board', 'board', ['groupBy: status']));
  await vault.write('.atlas/views/Everything.md', view('Everything', 'table'));
  await vault.write(
    '.atlas/views/Projects.md',
    ['---', 'atlas: view', 'type: project', '---', '', '# Projects', ''].join('\n'),
  );
  await vault.write(
    'Ship it.md',
    ['---', 'type: task', 'status: doing', '---', '', '# Ship it', ''].join('\n'),
  );

  const host = await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return { vault, host };
}

const openVault = async (page: Page) => (await openVaultWithHost(page)).vault;

const tabStrip = (page: Page) => page.getByRole('navigation', { name: 'Views' });
const tabTitles = (page: Page) => tabStrip(page).locator('.view-tabs__tab');
/**
 * The view named is the one open: its tab is the pressed one.
 *
 * A view just added is opened in the pane, which draws its page — tabs and
 * toolbar with it — afresh. That happens some time after the view's file is
 * written, so the file is not the thing to wait for before using the page:
 * a Filter pressed on the page being replaced opened a popover that went with
 * it, and a tab focused there lost its focus (#52).
 */
const expectOpen = (page: Page, name: string) =>
  expect(tabStrip(page).getByRole('button', { name, exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
const openType = (page: Page, label: string) =>
  sidebarSection(page, 'types')
    .getByRole('button', { name: new RegExp(`^${label}, `) })
    .click();

test('clicking a type shows its views as tabs — only its own — and opens the first', async ({
  page,
}) => {
  await openVault(page);
  await openType(page, 'Task');

  await expect(tabTitles(page)).toHaveText(['Board', 'Everything']);
  await expect(tabStrip(page).getByRole('button', { name: 'Board' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.locator('.board').getByRole('button', { name: 'Ship it' })).toBeVisible();
  // The type's row is where the sidebar says you are.
  await expect(
    sidebarSection(page, 'types').getByRole('button', { name: /^Task, / }),
  ).toHaveAttribute('aria-current', 'page');

  // The tab last open is the one the type opens on next.
  await tabStrip(page).getByRole('button', { name: 'Everything' }).click();
  await expect(tabStrip(page).getByRole('button', { name: 'Everything' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await openType(page, 'Project');
  await expect(tabTitles(page)).toHaveText(['Projects']);
  await openType(page, 'Task');
  await expect(tabStrip(page).getByRole('button', { name: 'Everything' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('a view opened from the sidebar lands among its type’s tabs, selected', async ({ page }) => {
  await openVault(page);
  await sidebarSection(page, 'views')
    .getByRole('button', { name: 'Everything', exact: true })
    .click();
  await expect(tabTitles(page)).toHaveText(['Board', 'Everything']);
  await expect(tabStrip(page).getByRole('button', { name: 'Everything' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('a type with no views shows its default table, written only once the tabs change', async ({
  page,
}) => {
  const vault = await openVault(page);
  await openType(page, 'Idea');

  await expect(tabTitles(page)).toHaveText(['Idea table']);
  expect(await vault.exists('.atlas/views/Idea table.md')).toBe(false);

  await tabStrip(page).getByRole('button', { name: 'Add a view' }).click();
  await page.getByRole('menuitem', { name: /List/ }).click();

  await expectFile(vault, '.atlas/views/Idea table.md').toContain('order: 1');
  await expectFile(vault, '.atlas/views/Idea list.md').toContain('order: 2');
  await expect(tabTitles(page)).toHaveText(['Idea table', 'Idea list']);
  await expect(tabStrip(page).getByRole('button', { name: 'Idea list' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('views are added, renamed and deleted from the tabs, nobody naming a file', async ({
  page,
}) => {
  const vault = await openVault(page);
  await openType(page, 'Task');

  await tabStrip(page).getByRole('button', { name: 'Add a view' }).click();
  await page.getByRole('menuitem', { name: /List/ }).click();
  await expectFile(vault, '.atlas/views/Task list.md').toContain('layout: list');
  await expect(tabTitles(page)).toHaveText(['Board', 'Everything', 'Task list']);
  await expect(tabStrip(page).getByRole('button', { name: 'Task list' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await tabStrip(page).getByRole('button', { name: 'View options' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const name = tabStrip(page).getByRole('textbox', { name: 'View name' });
  await name.fill('Today');
  await name.press('Enter');
  await expectFile(vault, '.atlas/views/Task list.md').toContain('title: Today');
  await expect(tabTitles(page)).toHaveText(['Board', 'Everything', 'Today']);

  await tabStrip(page).getByRole('button', { name: 'View options' }).click();
  await page.getByRole('menuitem', { name: 'Delete view' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Move to Trash' }).click();
  await expect.poll(() => vault.exists('.atlas/views/Task list.md')).toBe(false);
  // The tab before it is where the page lands.
  await expect(tabTitles(page)).toHaveText(['Board', 'Everything']);
  await expect(tabStrip(page).getByRole('button', { name: 'Everything' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('dragging a tab reorders the type’s views, and the order survives a reload', async ({
  page,
}) => {
  const vault = await openVault(page);
  await openType(page, 'Task');
  await expect(tabTitles(page)).toHaveText(['Board', 'Everything']);

  await dragWithPointer(page, {
    from: tabStrip(page).getByRole('button', { name: 'Everything' }),
    to: tabStrip(page).getByRole('button', { name: 'Board' }),
    overText: 'Everything is over Board.',
  });

  await expect(tabTitles(page)).toHaveText(['Everything', 'Board']);
  await expectFile(vault, '.atlas/views/Everything.md').toContain('order: 1');
  // Placed first, Everything reads before every view nobody placed: Board is
  // not written at all (ADR-0023, a move writes the moved view alone).
  expect(await vault.read('.atlas/views/Board.md')).toBe(
    view('Board', 'board', ['groupBy: status']),
  );

  // A reload stands in for quitting and relaunching.
  await page.reload();
  await openType(page, 'Task');
  await expect(tabTitles(page)).toHaveText(['Everything', 'Board']);
});

test('Alt+arrow moves the focused tab, for the keyboard', async ({ page }) => {
  const vault = await openVault(page);
  await openType(page, 'Task');

  await tabStrip(page).getByRole('button', { name: 'Board' }).focus();
  await page.keyboard.press('Alt+ArrowRight');

  await expect(tabTitles(page)).toHaveText(['Everything', 'Board']);
  await expect(tabStrip(page).getByText('Board moved to tab 2 of 2.')).toBeAttached();
  await expectFile(vault, '.atlas/views/Board.md').toContain('order: 2');
});

test('Alt+arrow twice on a view just added moves it two places, not one', async ({ page }) => {
  const vault = await openVault(page);
  await openType(page, 'Task');
  await tabStrip(page).getByRole('button', { name: 'Add a view' }).click();
  await page.getByRole('menuitem', { name: /List/ }).click();
  await expect(tabTitles(page)).toHaveText(['Board', 'Everything', 'Task list']);
  await expectOpen(page, 'Task list');

  await tabStrip(page).getByRole('button', { name: 'Task list' }).focus();
  await page.keyboard.press('Alt+ArrowLeft');
  await page.keyboard.press('Alt+ArrowLeft');

  await expect(tabTitles(page)).toHaveText(['Task list', 'Board', 'Everything']);
  await page.reload();
  await openType(page, 'Task');
  await expect(tabTitles(page)).toHaveText(['Task list', 'Board', 'Everything']);
  await expectFile(vault, '.atlas/views/Task list.md').toContain('order:');
});

test('“+” chosen twice in quick succession adds two views, and nothing goes wrong', async ({
  page,
}) => {
  const { vault, host } = await openVaultWithHost(page);
  await openType(page, 'Task');
  const add = async () => {
    await tabStrip(page).getByRole('button', { name: 'Add a view' }).click();
    await page.getByRole('menuitem', { name: /List/ }).click();
  };
  // The first view's write is held in flight, so the second is asked for
  // before the first exists: that is the succession this is about, and it
  // no longer depends on how fast the test clicks. Once the first is written
  // the pane opens it and draws its tabs afresh, and a "+" pressed on the old
  // ones as they went was lost — which is how this failed under load (#52).
  const writeTheFirst = host.holdWrites('.atlas/views/Task list.md');
  await add();
  await add();
  expect(await vault.exists('.atlas/views/Task list.md')).toBe(false);
  writeTheFirst();

  await expectFile(vault, '.atlas/views/Task list 2.md').toContain('layout: list');
  expect(await vault.exists('.atlas/views/Task list.md')).toBe(true);
  await expect(tabTitles(page)).toHaveText(['Board', 'Everything', 'Task list', 'Task list 2']);
  await expect(page.getByText(/already/)).toHaveCount(0);
});

test('a view deleted and made again under its name starts without the old one’s edits', async ({
  page,
}) => {
  const vault = await openVault(page);
  await openType(page, 'Task');
  await tabStrip(page).getByRole('button', { name: 'Add a view' }).click();
  await page.getByRole('menuitem', { name: /List/ }).click();
  await expectFile(vault, '.atlas/views/Task list.md').toContain('layout: list');
  await expectOpen(page, 'Task list');

  await page.getByRole('button', { name: 'Filter' }).click();
  await page.getByRole('combobox', { name: 'Property' }).selectOption('status');
  await page.getByRole('combobox', { name: 'Condition' }).selectOption('is');
  await page.getByRole('combobox', { name: 'Value' }).fill('done');
  await page.getByRole('button', { name: 'Add filter' }).click();
  await page.keyboard.press('Escape');
  const unsaved = page.getByRole('group', { name: 'Unsaved view changes' });
  await expect(unsaved).toBeVisible();

  await tabStrip(page).getByRole('button', { name: 'View options' }).click();
  await page.getByRole('menuitem', { name: 'Delete view' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Move to Trash' }).click();
  await expect.poll(() => vault.exists('.atlas/views/Task list.md')).toBe(false);
  await expect(tabTitles(page)).toHaveText(['Board', 'Everything']);

  await tabStrip(page).getByRole('button', { name: 'Add a view' }).click();
  await page.getByRole('menuitem', { name: /List/ }).click();
  await expectFile(vault, '.atlas/views/Task list.md').toContain('layout: list');
  await expect(tabStrip(page).getByRole('button', { name: 'Task list' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('button', { name: 'Ship it', exact: true })).toBeVisible();
  await expect(unsaved).toHaveCount(0);
});

test('a type is edited from its sidebar menu and from the search palette', async ({ page }) => {
  await openVault(page);
  const row = sidebarSection(page, 'types').getByRole('button', { name: /^Task, / });

  await row.click({ button: 'right' });
  await page
    .getByRole('menu', { name: 'Task' })
    .getByRole('menuitem', { name: 'Edit type' })
    .click();
  const aside = page.getByRole('complementary', { name: 'Right sidebar' });
  await expect(page.getByRole('button', { name: 'Edit type' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(aside.getByRole('button', { name: 'Edit Status' })).toBeVisible();

  await openType(page, 'Project');
  await expect(tabTitles(page)).toHaveText(['Projects']);
  await page.keyboard.press('Meta+k');
  await page.getByRole('searchbox', { name: 'Search the vault' }).fill('edit task type');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Edit type' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // Task's definition, not Project's: only Task has a status.
  await expect(aside.getByRole('textbox', { name: 'Name of this type' })).toHaveValue('Task');
  await expect(aside.getByRole('button', { name: 'Edit Status' })).toBeVisible();
});
