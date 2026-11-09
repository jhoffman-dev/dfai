import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, pageCommand, sidebarSection } from './host.ts';

const TASK_TYPE = [
  '---',
  'name: task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [backlog, doing, done]',
  '  phase: number',
  '---',
  '',
].join('\n');

const VIEW = [
  '---',
  'atlas: view',
  'type: task',
  'columns: [status, phase]',
  'sorts:',
  '  - key: phase',
  '    direction: asc',
  'limit: 50',
  '---',
  '',
  '# All tasks',
  '',
].join('\n');

const BOARD = [
  '---',
  'atlas: view',
  'type: task',
  'layout: board',
  'groupBy: status',
  'columns: [status, phase]',
  '---',
  '',
].join('\n');

/** A task made from a view goes to the task type's home for today (#214). */
const TODAY = new Date().toLocaleDateString('en-CA');
const TASKS = `Tasks/${TODAY.slice(0, 4)}/${TODAY.slice(5, 7)}`;

const task = (title: string, status: string, phase: number) =>
  ['---', 'type: task', `status: ${status}`, `phase: ${phase}`, '---', '', `# ${title}`, ''].join(
    '\n',
  );

/** A vault with two tasks — or with `extraTasks` more, for a table taller than the window. */
async function openViewVault(page: Page, extraTasks = 0) {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/views');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write('.atlas/views/Tasks.md', VIEW);
  await vault.write('first.md', task('First', 'doing', 1));
  await vault.write('second.md', task('Second', 'done', 2));
  await vault.write('loose.md', '# Not a task\n');
  // A template declares the type it makes, so it looks like a task to the index.
  await vault.mkdir('.atlas/templates');
  await vault.write('.atlas/templates/Task.md', task('Template task', 'backlog', 0));
  await vault.write('.atlas/views/Tasks board.md', BOARD);
  for (let n = 1; n <= extraTasks; n += 1) {
    await vault.write(`task-${n}.md`, task(`Task ${n}`, 'backlog', n + 2));
  }

  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();

  await sidebarSection(page, 'views').getByRole('button', { name: 'Tasks', exact: true }).click();
  return vault;
}

test('opening a saved view shows a table of its notes', async ({ page }) => {
  await openViewVault(page);

  await expect(page.getByRole('button', { name: 'first', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'second', exact: true })).toBeVisible();
  // The note that is not a task is not in the table, and nor is the template.
  await expect(page.getByRole('button', { name: 'Not a task' })).toHaveCount(0);
  await expect(
    page.locator('.table').getByRole('button', { name: 'Task', exact: true }),
  ).toHaveCount(0);
  // Counted in the type's words; the template-shaped note in .atlas is not one.
  await expect(page.getByText('2 tasks')).toBeVisible();
});

test('the SQL behind the view can be read', async ({ page }) => {
  await openViewVault(page);

  await pageCommand(page, /^Show SQL/);
  const sql = page.locator('.page__sql');
  await expect(sql).toContainText('FROM "v_task"');
  await expect(sql).toContainText('ORDER BY "phase" ASC');
});

test('clicking a title opens that note', async ({ page }) => {
  await openViewVault(page);

  await page.getByRole('button', { name: 'first', exact: true }).click();
  await expect(page.getByRole('article', { name: 'first' })).toBeVisible();
});

test('editing a cell writes the note it came from', async ({ page }) => {
  const vault = await openViewVault(page);

  // A status opens its picker (#300): its third option, by its number key.
  await page.getByRole('button', { name: 'Doing', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Set Status' })).toBeVisible();
  await page.keyboard.press('3');

  await expectFile(vault, 'first.md').toContain('status: done');
  // And nothing else about that note changed.
  expect(await vault.read('first.md')).toContain('# First');
});

test('sorting a column changes the view, and Save view writes it into the note', async ({
  page,
}) => {
  const vault = await openViewVault(page);
  const before = await vault.read('.atlas/views/Tasks.md');

  await page.getByRole('button', { name: 'Status', exact: true }).click();
  const unsaved = page.getByRole('group', { name: 'Unsaved view changes' });
  await expect(unsaved).toBeVisible();
  // Explored, not yet saved: the note is as it was.
  expect(await vault.read('.atlas/views/Tasks.md')).toBe(before);

  await unsaved.getByRole('button', { name: 'Save view' }).click();
  await expectFile(vault, '.atlas/views/Tasks.md').toContain('key: status');
  await expect(unsaved).toHaveCount(0);
});

test('a saved view does not pretend to be a note of the type it lists', async ({ page }) => {
  await openViewVault(page);

  // Its frontmatter says `type: task`, but that names what the view lists.
  // Showing a task properties panel here would edit the view note itself.
  await expect(page.getByRole('region', { name: 'Properties' })).toHaveCount(0);
});

test('a table view also uses the width of the window', async ({ page }) => {
  await openViewVault(page);
  await expect(page.getByRole('button', { name: 'first', exact: true })).toBeVisible();

  const measured = await page.evaluate(() => {
    const table = document.querySelector('.table');
    const main = document.querySelector('.shell__main');
    if (table === null || main === null) return null;
    return {
      table: Math.round(table.getBoundingClientRect().width),
      available: Math.round(main.getBoundingClientRect().width),
    };
  });

  expect(measured?.table ?? 0).toBeGreaterThan((measured?.available ?? 0) * 0.8);
});

test('a long table keeps its header in view while the rows scroll', async ({ page }) => {
  await openViewVault(page, 45);
  const header = page.locator('.table__grid th').first();
  const last = page.getByRole('button', { name: 'task-45', exact: true });
  await expect(header).toBeVisible();
  const before = await header.boundingBox();

  // Scroll to the last row: whatever scrolls, the header must not go with it. The
  // rows are virtualised (#238), so the last is drawn only once the sheet scrolls.
  await page.locator('.table__sheet').evaluate((sheet) => {
    sheet.scrollTop = sheet.scrollHeight;
  });
  await expect(last).toBeInViewport();
  await expect(header).toBeInViewport();
  await expect.poll(async () => (await header.boundingBox())?.y).toBe(before?.y);
});

test('the other views over the type are tabs, and a tab opens its view', async ({ page }) => {
  await openViewVault(page);

  const tabs = page.getByRole('navigation', { name: 'Views' });
  // The strip also holds its "+", the open view's options and Edit type; these are the tabs.
  await expect(tabs.locator('.view-tabs__tab')).toHaveText(['Tasks board', 'Tasks']);
  await expect(tabs.getByRole('button', { name: 'Tasks', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await tabs.getByRole('button', { name: 'Tasks board' }).click();
  await expect(
    page.locator('.board').getByRole('button', { name: 'first', exact: true }),
  ).toBeVisible();
  // The template is not a card either.
  await expect(
    page.locator('.board').getByRole('button', { name: 'Task', exact: true }),
  ).toHaveCount(0);
});

test('a filter added from the toolbar applies at once, and is written when saved', async ({
  page,
}) => {
  const vault = await openViewVault(page);

  await page.getByRole('button', { name: 'Filter' }).click();
  await page.getByRole('combobox', { name: 'Property' }).selectOption('status');
  await page.getByRole('combobox', { name: 'Condition' }).selectOption('isNot');
  await page.getByRole('combobox', { name: 'Value' }).fill('done');
  await page.getByRole('button', { name: 'Add filter' }).click();

  await expect(page.getByRole('button', { name: 'second', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'first', exact: true })).toBeVisible();
  expect(await vault.read('.atlas/views/Tasks.md')).not.toContain('operator: isNot');

  await page.keyboard.press('Escape');
  await page
    .getByRole('group', { name: 'Unsaved view changes' })
    .getByRole('button', { name: 'Save view' })
    .click();
  await expectFile(vault, '.atlas/views/Tasks.md').toContain('operator: isNot');
});

test('"New task" makes a task and opens it', async ({ page }) => {
  const vault = await openViewVault(page);

  // The view's own button, found in the view: until the view has drawn,
  // `.first()` on the whole page could find another.
  await page
    .getByRole('article', { name: 'Tasks' })
    .getByRole('button', { name: 'New task', exact: true })
    .first()
    .click();

  await expect(page.getByRole('article', { name: 'New task' })).toBeVisible();
  await expectFile(vault, `${TASKS}/New task.md`).toContain('type: task');
});
