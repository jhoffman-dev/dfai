import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, sidebarSection, type FakeVault } from './host.ts';
import { dragCardTo } from './drag.ts';

/**
 * P30-02: tasks follow GTD's eight statuses (ADR-0029). A vault on the old
 * board's statuses is offered the move from the Inbox, previewed task by
 * task, run, and undone byte for byte; a board drags between the new
 * statuses, Waiting included with nobody to wait on (#202), and a tick
 * finishes a task with the day.
 */

const note = (frontmatter: string[], body: string) =>
  ['---', ...frontmatter, '---', '', body, ''].join('\n');

const OLD_TASK_TYPE = [
  '---',
  'name: task',
  'label: Task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [backlog, next, doing, review, done]',
  '    done: done',
  '  # Kept in words, as this vault always has.',
  '  estimate: text',
  '---',
  '',
  '# Task',
  '',
].join('\n');

const GTD_TASK_TYPE = [
  '---',
  'name: task',
  'label: Task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [inbox, backlog, next-action, in-progress, waiting, someday, longterm, archive]',
  '    done: archive',
  '  waiting_on:',
  '    kind: relation',
  '    target: person',
  '  completed: date',
  '---',
  '',
  '# Task',
  '',
].join('\n');

const PERSON_TYPE = ['---', 'name: person', 'label: Person', '---', '', '# Person', ''].join('\n');

const BOARD = [
  '---',
  'atlas: view',
  'type: task',
  'layout: board',
  'groupBy: status',
  'columns: [status]',
  'limit: 50',
  '---',
  '',
  '# Board',
  '',
].join('\n');

/** The old board's tasks, one in each of its columns, written as a person would. */
const OLD_TASKS: Record<string, string> = {
  'tasks/Write the brief.md': note(['type: task', 'status: backlog'], 'Two pages.'),
  'tasks/Call the bank.md': note(
    ['type: task', 'status: next', 'estimate: 10 min'],
    'About the card.',
  ),
  'tasks/Draft the memo.md': note(['type: task', "status: 'doing'"], 'For Tobias Fenn.'),
  'tasks/Check figures.md': note(['type: task', 'status: review   # nearly'], 'Q3.'),
  'tasks/Ship it.md': note(['type: task', 'status: done'], 'Shipped.'),
};

async function openVault(page: Page, files: Record<string, string>): Promise<FakeVault> {
  const vault = await createVault();
  for (const folder of ['.atlas/types', '.atlas/views', 'tasks', 'People', 'Inbox']) {
    await vault.mkdir(folder);
  }
  await vault.write('.atlas/types/person.md', PERSON_TYPE);
  await vault.write('.atlas/views/Board.md', BOARD);
  await vault.write('People/Mara Quill.md', note(['type: person'], 'A neighbour.'));
  // Something waiting in the Inbox, so the sidebar offers it.
  await vault.write('Inbox/Sort the post.md', note([], 'Letters.'));
  for (const [path, text] of Object.entries(files)) await vault.write(path, text);

  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return vault;
}

async function openInbox(page: Page) {
  await page
    .getByRole('list', { name: 'Go to' })
    .getByRole('button', { name: /^Inbox/ })
    .click();
  return page.getByRole('region', { name: 'Move tasks to GTD statuses' });
}

async function openBoard(page: Page) {
  await sidebarSection(page, 'views').getByRole('button', { name: 'Board', exact: true }).click();
  await expect(page.locator('.board__column').first()).toBeVisible();
}

/** Today where the browser is, as the app writes it: the test runs on the same Mac. */
const today = () => new Date().toLocaleDateString('en-CA');

/**
 * The board draws a drop only once the index has read the written file back,
 * which is after the write lands. Until then the moved card still sits in its
 * old column, and the cards below it have not closed the gap; a drag that
 * measures one of them then presses where it no longer is.
 */
async function expectCardIn(page: Page, path: string, column: string) {
  await expect(
    page
      .locator('.board')
      .getByRole('region', { name: column, exact: true })
      .locator(`.board__card[data-path="${path}"]`),
  ).toBeVisible();
}

test('the move to GTD is previewed task by task, run, and undone byte for byte', async ({
  page,
}) => {
  // Opening gives the Task type DFAI's own `focus` (#108), before any move: that is the vault the move starts from.
  const opened = {
    '.atlas/types/task.md': OLD_TASK_TYPE.replace(
      '  estimate: text\n',
      '  estimate: text\n  focus:\n    kind: date\n    label: Chosen for\n',
    ),
    ...OLD_TASKS,
  };
  const vault = await openVault(page, { '.atlas/types/task.md': OLD_TASK_TYPE, ...OLD_TASKS });
  await expectFile(vault, '.atlas/types/task.md').toBe(opened['.atlas/types/task.md']);
  const files = opened;
  const offer = await openInbox(page);

  await expect(offer).toContainText('4 tasks would move to them.');
  await offer.getByRole('button', { name: 'Preview the move' }).click();
  const rows = offer.getByRole('table', { name: 'Tasks that move' }).getByRole('row');
  await expect(rows).toHaveCount(5);
  await expect(rows.filter({ hasText: 'Call the bank' })).toContainText('NextNext Action');
  await expect(rows.filter({ hasText: 'Check figures' })).toContainText('ReviewIn Progress');
  await expect(rows.filter({ hasText: 'Ship it' })).toContainText(/DoneArchive, completed \d{4}-/);
  // Previewing writes nothing.
  for (const [path, text] of Object.entries(files)) expect(await vault.read(path)).toBe(text);

  await offer.getByRole('button', { name: 'Move 4 tasks' }).click();
  await expectFile(vault, 'tasks/Ship it.md').toContain('status: archive');
  expect(await vault.read('tasks/Ship it.md')).toMatch(/\ncompleted: \d{4}-\d{2}-\d{2}\n/);
  expect(await vault.read('tasks/Call the bank.md')).toBe(
    note(['type: task', 'status: next-action', 'estimate: 10 min'], 'About the card.'),
  );
  expect(await vault.read('.atlas/types/task.md')).toContain(
    '# Kept in words, as this vault always has.',
  );
  expect(await vault.read('.atlas/types/task.md')).toContain('waiting_on:');
  await expectFile(vault, '.atlas/views/Next actions.md').toContain('defer <= @today');
  await expect(offer.getByRole('status')).toContainText('Moved tasks to GTD statuses');

  await offer.getByRole('button', { name: 'Undo the move to GTD' }).click();
  await expect(offer.getByRole('status')).toContainText('Undid the move to GTD');
  for (const [path, text] of Object.entries(files)) {
    await expectFile(vault, path).toBe(text);
  }
  expect(await vault.exists('.atlas/views/Next actions.md')).toBe(false);
});

test('a board drags a task between the new statuses, and Waiting needs nobody (#202)', async ({
  page,
}) => {
  const vault = await openVault(page, {
    '.atlas/types/task.md': GTD_TASK_TYPE,
    'tasks/Call the bank.md': note(['type: task', 'status: next-action'], 'About the card.'),
    'tasks/Hear from Mara.md': note(
      ['type: task', 'status: next-action', 'waiting_on: "[[Mara Quill]]"'],
      'The seeds.',
    ),
  });
  await openBoard(page);
  await page.locator('[data-path="tasks/Call the bank.md"]').waitFor();
  // The column is named as its heading reads, not by the raw option (#338).
  await expect(
    page.locator('.board').getByRole('region', { name: 'Next Action', exact: true }),
  ).toBeVisible();

  await dragCardTo(page, 'tasks/Call the bank.md', 'In Progress');
  await expectFile(vault, 'tasks/Call the bank.md').toContain('status: in-progress');
  await expectCardIn(page, 'tasks/Call the bank.md', 'In Progress');

  await dragCardTo(page, 'tasks/Hear from Mara.md', 'Waiting');
  await expectFile(vault, 'tasks/Hear from Mara.md').toContain('status: waiting');
  await expectCardIn(page, 'tasks/Hear from Mara.md', 'Waiting');

  // Nobody in Waiting on: the drag lands, and nothing asks who.
  await dragCardTo(page, 'tasks/Call the bank.md', 'Waiting');
  await expectFile(vault, 'tasks/Call the bank.md').toContain('status: waiting');
  expect(await vault.read('tasks/Call the bank.md')).not.toContain('waiting_on');
  await expectCardIn(page, 'tasks/Call the bank.md', 'Waiting');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('ticking a task archives it with the day; unticking puts its status back', async ({
  page,
}) => {
  const vault = await openVault(page, {
    '.atlas/types/task.md': GTD_TASK_TYPE,
    'tasks/Draft the memo.md': note(['type: task', 'status: in-progress'], 'For Tobias Fenn.'),
  });
  await openBoard(page);
  const tick = page.getByRole('checkbox', { name: 'Mark Draft the memo done' });

  await tick.click();
  await expectFile(vault, 'tasks/Draft the memo.md').toContain('status: archive');
  expect(await vault.read('tasks/Draft the memo.md')).toContain(`completed: ${today()}`);

  // Untick only once the board shows it ticked: a click before then would tick it again.
  await expect(tick).toBeChecked();
  await tick.click();
  await expectFile(vault, 'tasks/Draft the memo.md').toBe(
    note(['type: task', 'status: in-progress'], 'For Tobias Fenn.'),
  );
});
