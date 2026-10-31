/**
 * P17-04: views made and saved in the app, and SQL. A view made from a type
 * page; a filter kept in a new view while the old one stays as it was; a query
 * run, saved as a view and opened again; and a query added to a dashboard.
 */
import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, sidebarSection, type FakeVault } from './host.ts';

const TASK_TYPE = [
  '---',
  'name: task',
  'label: Task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [backlog, doing, done]',
  '  phase: number',
  '---',
  '',
].join('\n');

const TASKS_VIEW = [
  '---',
  'atlas: view',
  'type: task',
  'columns: [status, phase]',
  'limit: 50',
  '---',
  '',
  '# Tasks',
  '',
].join('\n');

const DASHBOARD = ['---', 'atlas: dashboard', 'widgets: []', '---', '', '# Home', ''].join('\n');

const task = (title: string, status: string, phase: number) =>
  ['---', 'type: task', `status: ${status}`, `phase: ${phase}`, '---', '', `# ${title}`, ''].join(
    '\n',
  );

async function openVault(page: Page): Promise<FakeVault> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/views');
  await vault.mkdir('.atlas/dashboards');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write('.atlas/views/Tasks.md', TASKS_VIEW);
  await vault.write('.atlas/dashboards/Home.md', DASHBOARD);
  await vault.write('first.md', task('First', 'doing', 1));
  await vault.write('second.md', task('Second', 'done', 2));
  await vault.write('third.md', task('Third', 'doing', 3));

  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return vault;
}

const views = (page: Page) => sidebarSection(page, 'views');

async function openQueryPage(page: Page) {
  await page.getByRole('button', { name: 'New in Views' }).click();
  await page.getByRole('menuitem', { name: 'New query' }).click();
  await expect(page.getByRole('heading', { name: 'Query', exact: true })).toBeVisible();
  // The page opens on a DFAI query (P24); these tests write SQL by hand.
  await page
    .getByRole('radiogroup', { name: 'Query language' })
    .getByRole('radio', { name: 'SQL' })
    .click();
}

async function runQuery(page: Page, sql: string) {
  const editor = page.getByRole('textbox', { name: 'SQL' });
  await editor.fill(sql);
  await editor.press('Meta+Enter');
}

test('a view added from a type’s tabs opens, and is listed in the sidebar and the tabs', async ({
  page,
}) => {
  const vault = await openVault(page);
  await sidebarSection(page, 'types').getByRole('button', { name: /^Task/ }).click();
  const tabs = page.getByRole('navigation', { name: 'Views' });
  await tabs.getByRole('button', { name: 'Add a view' }).click();
  await page.getByRole('menuitem', { name: /Board/ }).click();

  await expectFile(vault, '.atlas/views/Task board.md').toContain('groupBy: status');
  // It opened as a board, grouped by the type's select.
  await expect(page.locator('.board').getByRole('button', { name: 'First' })).toBeVisible();
  await expect(views(page).getByRole('button', { name: 'Task board', exact: true })).toBeVisible();
  await expect(tabs.getByRole('button', { name: 'Task board' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(tabs.getByRole('button', { name: 'Tasks', exact: true })).toBeVisible();
});

test('a view’s name is checked before anything is written', async ({ page }) => {
  await openVault(page);
  await page.getByRole('button', { name: 'New in Views' }).click();
  await page.getByRole('menuitem', { name: 'New view' }).click();
  const dialog = page.getByRole('dialog', { name: 'New view' });
  await dialog.getByRole('textbox', { name: 'View name' }).fill('tasks');
  await expect(dialog.getByRole('alert')).toHaveText('There is already a view called “tasks”.');
  await expect(dialog.getByRole('button', { name: 'Create view' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Create view' }).click();
  await expect(dialog).toBeVisible();
});

test('a filter saved as a new view leaves the view it came from as it was', async ({ page }) => {
  const vault = await openVault(page);
  await views(page).getByRole('button', { name: 'Tasks', exact: true }).click();
  await expect(page.getByRole('button', { name: 'second', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Filter' }).click();
  await page.getByRole('combobox', { name: 'Property' }).selectOption('status');
  await page.getByRole('combobox', { name: 'Condition' }).selectOption('is');
  await page.getByRole('combobox', { name: 'Value' }).fill('doing');
  await page.getByRole('button', { name: 'Add filter' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'second', exact: true })).toHaveCount(0);

  const unsaved = page.getByRole('group', { name: 'Unsaved view changes' });
  await unsaved.getByRole('button', { name: 'Save as new view…' }).click();
  const name = page.getByRole('textbox', { name: 'New view name' });
  await expect(name).toHaveValue('Tasks copy');
  await name.fill('Doing');
  await name.press('Enter');

  await expectFile(vault, '.atlas/views/Doing.md').toContain('value: doing');
  expect(await vault.read('.atlas/views/Tasks.md')).not.toContain('filters:\n  - key');
  expect(await vault.read('.atlas/views/Tasks.md')).not.toContain('doing');
  await expect(views(page).getByRole('button', { name: 'Doing', exact: true })).toBeVisible();
  // The new one is open, filtered; the old one still lists every task.
  await expect(page.getByRole('button', { name: 'second', exact: true })).toHaveCount(0);
  await page
    .getByRole('navigation', { name: 'Views' })
    .getByRole('button', { name: 'Tasks' })
    .click();
  await expect(page.getByRole('button', { name: 'second', exact: true })).toBeVisible();
  await expect(unsaved).toHaveCount(0);
});

test('Reset puts back what the view note says', async ({ page }) => {
  await openVault(page);
  await views(page).getByRole('button', { name: 'Tasks', exact: true }).click();

  await page.getByRole('button', { name: 'Properties' }).click();
  await page.getByRole('checkbox', { name: 'Phase' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('columnheader', { name: 'Phase' })).toHaveCount(0);

  await page
    .getByRole('group', { name: 'Unsaved view changes' })
    .getByRole('button', { name: 'Reset' })
    .click();
  await expect(page.getByRole('columnheader', { name: 'Phase' })).toBeVisible();
});

test('a SQL query runs, shows its error plainly, and puts a column in from the schema', async ({
  page,
}) => {
  await openVault(page);
  await openQueryPage(page);

  await runQuery(page, 'SELECT * FROM nowhere');
  await expect(page.getByRole('alert')).toHaveText(/no such table: nowhere/);

  const tables = page.getByRole('complementary', { name: 'Tables' });
  await expect(tables.getByText('v_task')).toBeVisible();
  const editor = page.getByRole('textbox', { name: 'SQL' });
  await editor.fill('SELECT title,  FROM v_task');
  await editor.evaluate((field: HTMLTextAreaElement) => field.setSelectionRange(14, 14));
  await tables.getByRole('button', { name: 'Insert v_task.status' }).click();
  await expect(editor).toHaveValue('SELECT title, status FROM v_task');

  await page.getByRole('button', { name: /^Run/ }).click();
  await expect(page.locator('.query__count')).toHaveText('3 rows');
  await expect(page.getByRole('cell', { name: 'doing' }).first()).toBeVisible();
});

test('a type view has the real columns: numbers compare as numbers, modified is there, undeclared keys are not', async ({
  page,
}) => {
  await openVault(page);
  await openQueryPage(page);

  // As text, every phase would be greater than the number 2.
  await runQuery(page, 'SELECT title, modified FROM v_task WHERE phase > 2 ORDER BY modified');
  await expect(page.locator('.query__count')).toHaveText('1 row');
  await expect(page.getByRole('cell', { name: 'Third' })).toBeVisible();

  await runQuery(page, 'SELECT type FROM v_task');
  await expect(page.getByRole('alert')).toHaveText(/no such column: type/);
});

test('a query saved as a view opens again from the sidebar with its rows', async ({ page }) => {
  const vault = await openVault(page);
  await openQueryPage(page);
  await runQuery(page, "SELECT path, title, status FROM v_task WHERE status = 'doing'");
  await expect(page.locator('.query__count')).toHaveText('2 rows');

  await page.getByRole('button', { name: 'Save as view' }).click();
  await page.getByRole('textbox', { name: 'View name' }).fill('Doing by SQL');
  await page.getByRole('button', { name: 'Save view' }).click();

  await expectFile(vault, '.atlas/views/Doing by SQL.md').toContain(
    "sql: SELECT path, title, status FROM v_task WHERE status = 'doing'",
  );
  // Saving opens the view: the query page shows `third` too, so the heading says it.
  await expect(page.getByRole('heading', { level: 1, name: 'Doing by SQL' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'third', exact: true })).toBeVisible();
  // The sidebar lists it once the index catches up, above Tasks — wait, or the
  // click meant for Tasks can land on it as it arrives.
  const saved = views(page).getByRole('button', { name: 'Doing by SQL', exact: true });
  await expect(saved).toBeVisible();

  // Away and back: the view is a note, and runs again when opened.
  await views(page).getByRole('button', { name: 'Tasks', exact: true }).click();
  await expect(page.getByRole('button', { name: 'second', exact: true })).toBeVisible();
  await saved.click();
  await expect(page.getByRole('button', { name: 'first', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'second', exact: true })).toHaveCount(0);
});

test('a query added to a dashboard draws there as a widget', async ({ page }) => {
  const vault = await openVault(page);
  await openQueryPage(page);
  await runQuery(page, 'SELECT status, COUNT(*) AS n FROM v_task GROUP BY status ORDER BY n DESC');
  await expect(page.locator('.query__count')).toHaveText('2 rows');

  await page.getByRole('button', { name: 'Add to dashboard' }).click();
  await page.getByRole('combobox', { name: 'Show as' }).selectOption('bar');
  await page.getByRole('textbox', { name: 'Widget title' }).fill('Tasks by status');
  await page.getByRole('button', { name: 'Add widget' }).click();
  await expect(page.getByText('Added to the dashboard.')).toBeVisible();

  await expectFile(vault, '.atlas/dashboards/Home.md').toContain('kind: sql');
  expect(await vault.read('.atlas/dashboards/Home.md')).toContain('show: bar');

  await sidebarSection(page, 'dashboards')
    .getByRole('button', { name: 'Home', exact: true })
    .click();
  const labels = page.getByLabel('Tasks by status').locator('.bars__label');
  await expect(labels).toHaveText(['doing', 'done']);
});

test('the search palette opens a new query', async ({ page }) => {
  await openVault(page);
  await page.keyboard.press('Meta+k');
  await page.getByRole('searchbox', { name: 'Search the vault' }).fill('new query');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: 'Query builder' })).toBeVisible();
});
