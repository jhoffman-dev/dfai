import { expect, test, type Locator, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, sidebarSection, type FakeVault } from './host.ts';

/**
 * #913: a task's priority, 1 (the most urgent) to 4, or none. Set in the
 * properties panel, it is the pill on Today's row; a task table sorted by it
 * lists P1 first and the tasks with none last; cleared, the note is exactly
 * what it was, and a reload reads both back from the file.
 */

/** 2026-11-18, midday where the test runs. */
const NOW = new Date(2026, 10, 18, 12, 0, 0);

const TASK_TYPE = [
  '---',
  'name: task',
  'label: Task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [inbox, backlog, next-action, in-progress, waiting, someday, longterm, archive]',
  '    done: archive',
  '  due: date',
  '  priority: number',
  '---',
  '',
  '# Task',
  '',
].join('\n');

const TABLE = [
  '---',
  'atlas: view',
  'type: task',
  'layout: table',
  'columns: [status, priority]',
  'limit: 50',
  '---',
  '',
  '# Tasks',
  '',
].join('\n');

const task = (frontmatter: readonly string[]) =>
  ['---', 'type: task', 'status: next-action', ...frontmatter, '---', '', 'A task.', ''].join('\n');

const WATER = task([]);

async function openVault(page: Page): Promise<FakeVault> {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/views');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write('.atlas/views/Tasks.md', TABLE);
  await vault.write('Call the bank.md', task([]));
  await vault.write('Renew the licence.md', task(['priority: 3']));
  // Last by name, so a sort by priority is seen to move it to the top.
  await vault.write('Water the plants.md', WATER);
  // The watcher reports the app's own writes, as the real one does, so Today and the table read them.
  await installHost(page, vault, { echoWrites: true });
  await page.clock.setFixedTime(NOW);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return vault;
}

async function openNote(page: Page, title: string) {
  await sidebarSection(page, 'userSpace')
    .getByRole('treeitem', { name: title, exact: true })
    .click();
  await expect(page.getByRole('article', { name: title })).toBeVisible();
}

const priorityField = (page: Page) =>
  page.getByRole('region', { name: 'Properties' }).getByLabel(/^priority$/i);

const todayRow = (page: Page, title: string) =>
  page
    .getByRole('article', { name: 'Today' })
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name: title, exact: true }) });

async function openToday(page: Page) {
  await page.getByRole('list', { name: 'Go to' }).getByRole('button', { name: 'Today' }).click();
  await expect(page.getByRole('article', { name: 'Today' })).toBeVisible();
}

/** A pill as a screen reader is told it: "Priority 1". */
const pill = (scope: Locator, priority: number) =>
  scope.getByText(`Priority ${priority}`, { exact: true });
const anyPill = (scope: Locator) => scope.getByText(/^Priority [1-4]$/);
/** What a pill shows on screen. */
const shown = (scope: Locator) => scope.locator('.priority-pill [aria-hidden="true"]');

const tableTitles = (page: Page) => page.locator('.table__title');

test('a priority is set, shown, sorted by, cleared, and read back after a reload', async ({
  page,
}) => {
  const vault = await openVault(page);

  // Set in the properties panel: the file gains the one line.
  await openNote(page, 'Water the plants');
  await expect(priorityField(page)).toHaveValue('');
  await priorityField(page).selectOption({ label: 'P1' });
  await expectFile(vault, 'Water the plants.md').toBe(
    WATER.replace('---\n\n', 'priority: 1\n---\n\n'),
  );

  // Today draws its pill, P1 on screen and "Priority 1" to a screen reader; none, nothing.
  await openToday(page);
  await expect(pill(todayRow(page, 'Water the plants'), 1)).toHaveCount(1);
  await expect(shown(todayRow(page, 'Water the plants'))).toHaveText('P1');
  await expect(todayRow(page, 'Call the bank')).toBeVisible();
  await expect(anyPill(todayRow(page, 'Call the bank'))).toHaveCount(0);

  // A task table sorted by priority, ascending: P1, then P3, then the one with none.
  await sidebarSection(page, 'views').getByRole('button', { name: 'Tasks', exact: true }).click();
  await expect(tableTitles(page)).toHaveText([
    'Call the bank',
    'Renew the licence',
    'Water the plants',
  ]);
  await page.getByRole('button', { name: /^priority$/i }).click();
  await expect(tableTitles(page)).toHaveText([
    'Water the plants',
    'Renew the licence',
    'Call the bank',
  ]);
  await expect(page.getByRole('button', { name: 'Priority 3' })).toHaveCount(1);

  // Cleared: the line goes, and the note is byte for byte what it was.
  await openNote(page, 'Water the plants');
  await priorityField(page).selectOption({ label: 'No priority' });
  await expectFile(vault, 'Water the plants.md').toBe(WATER);

  // Read again from the files: still none here, still P3 there.
  await page.reload();
  await openNote(page, 'Water the plants');
  await expect(priorityField(page)).toHaveValue('');
  await openToday(page);
  await expect(pill(todayRow(page, 'Renew the licence'), 3)).toHaveCount(1);
  await expect(todayRow(page, 'Water the plants')).toBeVisible();
  await expect(anyPill(todayRow(page, 'Water the plants'))).toHaveCount(0);
  expect(await vault.read('Water the plants.md')).toBe(WATER);
});
