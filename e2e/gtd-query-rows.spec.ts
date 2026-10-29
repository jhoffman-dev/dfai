import { utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, sidebarSection, type FakeVault } from './host.ts';
import { toastSaying } from './toasts.ts';

/**
 * #107: the GTD lists are query views, and their task rows act as Today's
 * do. On a fixed clock, a row is ticked done (a repeating one rolling on,
 * its choice for today ended), moved to another status from its menu, and
 * chosen for today and taken off again — each file checked byte for byte,
 * and an Undo putting every byte back. A query block in a note stays look-only.
 */

/** 2026-10-28, midday where the test runs. */
const NOW = new Date(2026, 9, 28, 12, 0, 0);

const task = (frontmatter: string[]) =>
  ['---', 'type: task', ...frontmatter, '---', '', 'A task.', ''].join('\n');

const GTD_TASK_TYPE = [
  '---',
  'name: task',
  'label: Task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [inbox, backlog, next-action, in-progress, waiting, someday, longterm, archive]',
  '    done: archive',
  '  defer: date',
  '  due: date',
  '  completed: date',
  '  focus: date',
  '  recurrence: text',
  '---',
  '',
  '# Task',
  '',
].join('\n');

const view = (layout: string, query: string) =>
  ['---', 'atlas: view', `layout: ${layout}`, `query: ${query}`, '---', ''].join('\n');

const PRINTER = task(['status: next-action', 'due: 2026-11-02 # before the proofs go out']);
const HALL = task(['status: next-action']);
const BEDS = task([
  'status: next-action',
  'due: 2026-10-28',
  'recurrence: every week',
  'focus: 2026-10-28',
]);
const AGENDA = task(['status: someday']);

const NOTES: Record<string, string> = {
  '.atlas/types/task.md': GTD_TASK_TYPE,
  '.atlas/views/Next actions.md': view(
    'list',
    'FROM task WHERE status = next-action SORT BY title SHOW status, due',
  ),
  '.atlas/views/Someday and Longterm.md': view(
    'board',
    'FROM task WHERE status = someday OR status = longterm SORT BY title GROUP BY status SHOW status',
  ),
  'Tasks/Call the printer.md': PRINTER,
  'Tasks/Book the hall.md': HALL,
  'Tasks/Water the beds.md': BEDS,
  'Tasks/Draft the agenda.md': AGENDA,
  'Planning.md': '# Planning\n\n```atlas-query\nlayout: list\nFROM task SORT BY title\n```\n',
};

async function openVault(page: Page): Promise<FakeVault> {
  const vault = await createVault();
  for (const folder of ['.atlas/types', '.atlas/views', 'Tasks']) await vault.mkdir(folder);
  for (const [path, text] of Object.entries(NOTES)) {
    await vault.write(path, text);
    await utimes(join(vault.root, path), NOW, NOW);
  }
  await installHost(page, vault);
  await page.clock.setFixedTime(NOW);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return vault;
}

async function openView(page: Page, name: string) {
  await sidebarSection(page, 'views').getByRole('button', { name, exact: true }).click();
  await expect(page.locator('.qresult__list, .qresult__board').first()).toBeVisible();
}

const box = (page: Page, title: string) =>
  page.getByRole('checkbox', { name: `Mark ${title} done` });

test('a query view’s rows tick done, roll a repeating task on, and undo byte for byte', async ({
  page,
}) => {
  const vault = await openVault(page);
  await openView(page, 'Next actions');
  await expect(box(page, 'Call the printer')).toBeVisible();

  await box(page, 'Call the printer').click();
  await expectFile(vault, 'Tasks/Call the printer.md').toBe(
    task([
      'status: archive',
      'due: 2026-11-02 # before the proofs go out',
      'completed: 2026-10-28',
    ]),
  );
  await expect(toastSaying(page, 'Finished “Call the printer”.')).toBeVisible();
  // Finished, it is no next action: once the index has it, the view lets it go.
  await expect(box(page, 'Call the printer')).toHaveCount(0);

  // A repeating task chosen for today rolls on to its next day, and the choice ends.
  // Rolled on, it is open work again, so its box is clear the moment it is ticked.
  await box(page, 'Water the beds').click();
  await expectFile(vault, 'Tasks/Water the beds.md').toBe(
    task([
      'status: next-action',
      'due: 2026-11-04',
      'recurrence: every week',
      'lastCompleted: 2026-10-28',
    ]),
  );
  await toastSaying(page, 'Finished “Water the beds”.')
    .getByRole('button', { name: 'Undo' })
    .click();
  await expectFile(vault, 'Tasks/Water the beds.md').toBe(BEDS);
});

test('a query view’s row is chosen for today and taken off again, leaving the file as it was', async ({
  page,
}) => {
  const vault = await openVault(page);
  await openView(page, 'Next actions');
  const choose = page.getByRole('button', { name: 'Choose Book the hall for today' });
  await choose.click();
  await expectFile(vault, 'Tasks/Book the hall.md').toBe(
    task(['status: next-action', 'focus: 2026-10-28']),
  );
  const takeOff = page.getByRole('button', { name: 'Take Book the hall off today' });
  await expect(takeOff).toHaveAttribute('aria-pressed', 'true');
  // Held until the index reads the choice back, then free to act on again.
  await expect(takeOff).toBeEnabled();
  // From the keyboard: the toggle is a button in the row's own order.
  await takeOff.focus();
  await page.keyboard.press('Enter');
  await expectFile(vault, 'Tasks/Book the hall.md').toBe(HALL);
  await expect(page.getByRole('button', { name: 'Choose Book the hall for today' })).toBeVisible();
});

test('a board’s card moves to another status from its menu, and the Undo takes it back', async ({
  page,
}) => {
  const vault = await openVault(page);
  await openView(page, 'Someday and Longterm');
  const longterm = page.locator('.board').getByRole('region', { name: 'longterm', exact: true });

  await page.getByRole('button', { name: 'Move Draft the agenda to…' }).click();
  await page.getByRole('menuitem', { name: 'Longterm' }).click();
  await expectFile(vault, 'Tasks/Draft the agenda.md').toBe(task(['status: longterm']));
  await expect(longterm.getByText('Draft the agenda')).toBeVisible();

  await toastSaying(page, 'Moved “Draft the agenda” to Longterm.')
    .getByRole('button', { name: 'Undo' })
    .click();
  await expectFile(vault, 'Tasks/Draft the agenda.md').toBe(AGENDA);
  await expect(longterm.getByText('Draft the agenda')).toHaveCount(0);
});

test('a row whose file changed since the view read it refuses, says so on the row, and tries again', async ({
  page,
}) => {
  const vault = await openVault(page);
  await openView(page, 'Next actions');
  await expect(box(page, 'Book the hall')).toBeVisible();
  // Changed behind the view's back, unheard by the watcher: the row still says Next Action.
  const changed = task(['status: waiting']);
  await vault.write('Tasks/Book the hall.md', changed);

  await box(page, 'Book the hall').click();
  const refusal = page.getByRole('alert').filter({ hasText: 'changed since' });
  await expect(refusal).toBeVisible();
  await expectFile(vault, 'Tasks/Book the hall.md').toBe(changed);
  await expect(box(page, 'Book the hall')).not.toBeChecked();

  // Back as the row read it, the same tick is tried again and lands.
  await vault.write('Tasks/Book the hall.md', HALL);
  await refusal.getByRole('button', { name: 'Try again: Book the hall' }).click();
  await expectFile(vault, 'Tasks/Book the hall.md').toBe(
    task(['status: archive', 'completed: 2026-10-28']),
  );
});

test('a query block in a note stays look-only', async ({ page }) => {
  await openVault(page);
  const pages = sidebarSection(page, 'userSpace');
  await pages.getByRole('treeitem', { name: 'Planning', exact: true }).click();
  const block = page.getByRole('group', { name: 'Query block' });
  await expect(block.getByRole('button', { name: 'Book the hall' })).toBeVisible();
  await expect(block.getByRole('checkbox')).toHaveCount(0);
  await expect(block.getByRole('button', { name: /^Move .* to…$/ })).toHaveCount(0);
  await expect(block.getByRole('button', { name: /for today$/ })).toHaveCount(0);
});
