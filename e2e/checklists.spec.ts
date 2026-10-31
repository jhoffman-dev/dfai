import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, sidebarSection, type FakeVault } from './host.ts';
import { toastSaying } from './toasts.ts';

/**
 * P30-03: a task's checklist is its subtasks. Its progress is a bar on the
 * board, and a line of it can be made a task of its own, which links back to
 * the line; one Undo takes back both.
 */

const note = (frontmatter: string[], body: string) =>
  ['---', ...frontmatter, '---', '', body, ''].join('\n');

const TASK_TYPE = [
  '---',
  'name: task',
  'label: Task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [inbox, backlog, next-action, in-progress, waiting, someday, longterm, archive]',
  '    done: archive',
  '  completed: date',
  '  source: text',
  '---',
  '',
  '# Task',
  '',
].join('\n');

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

// A promoted line is a task, made in the task type's home for today (#214).
const TODAY = new Date().toLocaleDateString('en-CA');
const [YEAR, MONTH] = [TODAY.slice(0, 4), TODAY.slice(5, 7)];

const PLAN = note(
  ['type: task', 'status: in-progress', 'project: "[[Larkspur launch]]"'],
  [
    '- [x] Book the hall',
    '- [ ] Order chairs',
    '- [x] Send the invitations',
    '- [ ] Ring Mara Quill',
    '- [ ] Print the programme',
  ].join('\n'),
);

async function openVault(page: Page): Promise<FakeVault> {
  const vault = await createVault();
  for (const folder of ['.atlas/types', '.atlas/views', 'tasks']) await vault.mkdir(folder);
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write('.atlas/views/Board.md', BOARD);
  await vault.write('tasks/Plan the launch.md', PLAN);
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return vault;
}

async function openBoard(page: Page) {
  await sidebarSection(page, 'views').getByRole('button', { name: 'Board', exact: true }).click();
  await expect(page.locator('.board__column').first()).toBeVisible();
}

test('a task with 2 of 5 boxes ticked shows 40% on the board', async ({ page }) => {
  await openVault(page);
  await openBoard(page);
  const card = page.locator('[data-path="tasks/Plan the launch.md"]');
  const bar = card.getByRole('progressbar', { name: 'Checklist progress' });
  await expect(bar).toHaveAttribute('aria-valuenow', '40');
  await expect(bar).toHaveText('40%');
});

test('promoting a line makes the task, links it back, and one Undo takes back both', async ({
  page,
}) => {
  const vault = await openVault(page);
  await openBoard(page);
  await page
    .locator('[data-path="tasks/Plan the launch.md"]')
    .getByRole('button', { name: 'Plan the launch' })
    .click();
  await expect(page.getByRole('article', { name: 'Plan the launch' })).toBeVisible();

  await page.getByLabel('Note', { exact: true }).getByText('Order chairs', { exact: true }).click();
  await page.getByRole('button', { name: 'Make this line a task' }).click();

  // In the vault's own `tasks` folder: the type's home is Tasks/<y>/<m>, and the
  // app writes into the folder already there under another case rather than
  // make a second beside it. A case-sensitive disk (Linux) tells them apart.
  const made = `tasks/${YEAR}/${MONTH}/Order chairs.md`;
  await expectFile(vault, made).toMatch(/source: "\[\[Plan the launch#\^[a-z0-9]{6}\]\]"/);
  const task = await vault.read(made);
  expect(task).toContain('type: task\n');
  expect(task).toContain('status: inbox\n');
  expect(task).toContain('project: "[[Larkspur launch]]"\n');
  const id = /#\^([a-z0-9]{6})/.exec(task)?.[1] ?? '';
  await expectFile(vault, 'tasks/Plan the launch.md').toBe(
    PLAN.replace('- [ ] Order chairs\n', `- [ ] [[Order chairs]] ^${id}\n`),
  );
  // Said in the window's toast (UI v2, slice 15), held under the pointer while the file is read.
  const notice = toastSaying(page, 'is a task now');
  await expect(notice).toContainText('“Order chairs” is a task now.');
  await notice.hover();
  const link = page.getByLabel('Note', { exact: true }).locator('[data-wikilink="Order chairs"]');
  await expect(link).toHaveCount(1);

  await notice.getByRole('button', { name: 'Undo' }).click();
  await expectFile(vault, 'tasks/Plan the launch.md').toBe(PLAN);
  await expect.poll(() => vault.exists(made)).toBe(false);
  await expect(notice).toHaveCount(0);
  // The pane reads the note back as it was: the line is words again, not a link.
  await expect(link).toHaveCount(0);
  await expect(
    page.getByLabel('Note', { exact: true }).getByText('Order chairs', { exact: true }),
  ).toBeVisible();
});
