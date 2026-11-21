import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, sidebarSection, type FakeVault } from './host.ts';

/**
 * #928: a task's due may carry a time of day. Set in the properties panel, it
 * shows beside the day on Today; a task table sorted by due lists a day's
 * date-only due first, then its timed ones by time; a timed due whose time
 * has passed is overdue; cleared, the note is byte for byte what it was, and
 * a reload reads it back from the file. A date-only due nobody edits is
 * never rewritten.
 */

/** 2026-12-04, midday where the test runs. */
const NOW = new Date(2026, 11, 4, 12, 0, 0);

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
  'columns: [status, due]',
  'limit: 50',
  '---',
  '',
  '# Tasks',
  '',
].join('\n');

const task = (due: string) =>
  ['---', 'type: task', 'status: next-action', `due: ${due}`, '---', '', 'A task.', ''].join('\n');

/** First by name, so a sort by due is seen to move it. */
const CALL = task('2026-12-04');
const PAY = task('2026-12-04');
/** Due at nine this morning: overdue at midday. */
const WRITE = task('2026-12-04T09:00');

async function openVault(page: Page): Promise<FakeVault> {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/views');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write('.atlas/views/Tasks.md', TABLE);
  await vault.write('Call Mara Quill.md', CALL);
  await vault.write('Pay Larkspur Payroll.md', PAY);
  await vault.write('Write to Tobias Fenn.md', WRITE);
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

const timeField = (page: Page) =>
  page.getByRole('region', { name: 'Properties' }).getByLabel(/^due time$/i);

async function openToday(page: Page) {
  await page.getByRole('list', { name: 'Go to' }).getByRole('button', { name: 'Today' }).click();
  await expect(page.getByRole('article', { name: 'Today' })).toBeVisible();
}

const todayRow = (page: Page, section: string, title: string) =>
  page
    .getByRole('region', { name: section })
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name: title, exact: true }) });

const tableTitles = (page: Page) => page.locator('.table__title');

test('a time is set on a due, shown, sorted by, cleared, and read back after a reload', async ({
  page,
}) => {
  const vault = await openVault(page);

  // Set in the properties panel: the due gains its time, and nothing else changes.
  await openNote(page, 'Call Mara Quill');
  await expect(timeField(page)).toHaveValue('');
  await timeField(page).fill('15:30');
  await timeField(page).press('Enter');
  await expectFile(vault, 'Call Mara Quill.md').toBe(
    CALL.replace('due: 2026-12-04', 'due: 2026-12-04T15:30'),
  );

  // Today: due today with its time; the one due at nine is overdue by midday; a day alone shows none.
  await openToday(page);
  await expect(todayRow(page, 'Due today', 'Call Mara Quill')).toContainText('Due today at 15:30');
  await expect(todayRow(page, 'Due today', 'Pay Larkspur Payroll')).toContainText('Due today');
  await expect(todayRow(page, 'Due today', 'Pay Larkspur Payroll')).not.toContainText(' at ');
  await expect(todayRow(page, 'Overdue', 'Write to Tobias Fenn')).toContainText(
    'Due 2026-12-04 at 09:00',
  );

  // A task table sorted by due: the day alone first, then by time.
  await sidebarSection(page, 'views').getByRole('button', { name: 'Tasks', exact: true }).click();
  await expect(tableTitles(page)).toHaveText([
    'Call Mara Quill',
    'Pay Larkspur Payroll',
    'Write to Tobias Fenn',
  ]);
  await page.getByRole('button', { name: /^due$/i }).click();
  await expect(tableTitles(page)).toHaveText([
    'Pay Larkspur Payroll',
    'Write to Tobias Fenn',
    'Call Mara Quill',
  ]);

  // Cleared: the time goes, the date stays, and the note is byte for byte what it was.
  await openNote(page, 'Call Mara Quill');
  await page.getByRole('button', { name: /^clear due time$/i }).click();
  await expectFile(vault, 'Call Mara Quill.md').toBe(CALL);

  // Read again from the files: no time here; the others never rewritten.
  await page.reload();
  await openNote(page, 'Call Mara Quill');
  await expect(timeField(page)).toHaveValue('');
  await openToday(page);
  await expect(todayRow(page, 'Due today', 'Call Mara Quill')).toContainText('Due today');
  await expect(todayRow(page, 'Due today', 'Call Mara Quill')).not.toContainText(' at ');
  expect(await vault.read('Call Mara Quill.md')).toBe(CALL);
  expect(await vault.read('Pay Larkspur Payroll.md')).toBe(PAY);
  expect(await vault.read('Write to Tobias Fenn.md')).toBe(WRITE);
});
