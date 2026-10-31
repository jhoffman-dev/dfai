import { expect, test, type Page } from './fixtures.ts';
import {
  createVault,
  expectFile,
  installHost,
  sidebarSection,
  type FakeHost,
  type FakeVault,
} from './host.ts';
import { dragCardTo } from './drag.ts';

const TASK_TYPE = [
  '---',
  'name: task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [backlog, doing, done]',
  '  due: date',
  '  recurrence: text',
  '---',
  '',
].join('\n');

const TASK_TEMPLATE = [
  '---',
  'type: task',
  'status: backlog',
  'due:',
  '---',
  '',
  '# ',
  '',
  '',
].join('\n');

const BOARD = [
  '---',
  'atlas: view',
  'type: task',
  'layout: board',
  'groupBy: status',
  'columns: [status, due]',
  'limit: 50',
  '---',
  '',
  '# Board',
  '',
].join('\n');

async function openTaskVault(page: Page): Promise<FakeVault> {
  return (await openTaskVaultOn(page)).vault;
}

async function openTaskVaultOn(page: Page): Promise<{ vault: FakeVault; host: FakeHost }> {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/views');
  await vault.mkdir('.atlas/templates');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write('.atlas/templates/Task.md', TASK_TEMPLATE);
  await vault.write('.atlas/views/Board.md', BOARD);
  await vault.write(
    'one off.md',
    ['---', 'type: task', 'status: doing', '---', '', 'Once.', ''].join('\n'),
  );
  await vault.write(
    'water the plants.md',
    [
      '---',
      'type: task',
      'status: doing',
      'due: 2026-09-20',
      'recurrence: weekly',
      '---',
      '',
      'Every week.',
      '',
    ].join('\n'),
  );

  const host = await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return { vault, host };
}

/** A card as the board draws it in one column. */
const cardIn = (page: Page, column: string, path: string) =>
  page
    .locator('.board')
    .getByRole('region', { name: column, exact: true })
    .locator(`.board__card[data-path="${path}"]`);

async function openBoard(page: Page) {
  await sidebarSection(page, 'views').getByRole('button', { name: 'Board', exact: true }).click();
  await expect(page.locator('.board__column').first()).toBeVisible();
}

test('a captured line becomes a task in the Inbox, without leaving the note in view', async ({
  page,
}) => {
  const vault = await openTaskVault(page);

  await page.keyboard.down('Meta');
  await page.keyboard.down('Shift');
  await page.keyboard.press('n');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Meta');

  const capture = page.getByRole('dialog', { name: 'Capture a task' });
  await expect(capture).toBeVisible();
  await expect(capture.getByText(/a Task/)).toBeVisible();

  await page.getByRole('textbox', { name: 'What needs doing' }).fill('Renew the passport');
  await page.getByRole('textbox', { name: 'What needs doing' }).press('Enter');

  // It is a task, from the vault's own template, waiting in the Inbox (P30-01).
  await expectFile(vault, 'Inbox/Renew the passport.md').toContain('type: task');
  expect(await vault.read('Inbox/Renew the passport.md')).toContain('status: backlog');
});

test('capture stays open for the next thought', async ({ page }) => {
  const vault = await openTaskVault(page);

  await page.keyboard.down('Meta');
  await page.keyboard.down('Shift');
  await page.keyboard.press('n');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Meta');

  const field = page.getByRole('textbox', { name: 'What needs doing' });
  await field.fill('First thing');
  await field.press('Enter');
  await field.fill('Second thing');
  await field.press('Enter');

  await expectFile(vault, 'Inbox/First thing.md').toContain('type: task');
  await expectFile(vault, 'Inbox/Second thing.md').toContain('type: task');
});

test('finishing a repeating task moves it on instead of ending it', async ({ page }) => {
  const vault = await openTaskVault(page);
  await openBoard(page);
  await page.locator('[data-path="water the plants.md"]').waitFor();

  await dragCardTo(page, 'water the plants.md', 'Done');

  const saved = await expect
    .poll(() => vault.read('water the plants.md'))
    .toContain('due: 2026-09-27')
    .then(() => vault.read('water the plants.md'));

  // Back in play rather than finished, and it remembers when it was last done.
  expect(saved).toContain('status: backlog');
  expect(saved).toContain('lastCompleted: 2026-09-20');
  expect(saved).toContain('recurrence: weekly');
});

test('finishing an ordinary task just finishes it', async ({ page }) => {
  const vault = await openTaskVault(page);
  await openBoard(page);
  await page.locator('[data-path="one off.md"]').waitFor();

  await dragCardTo(page, 'one off.md', 'Done');

  await expectFile(vault, 'one off.md').toContain('status: done');
});

test('capture does not also make a blank note', async ({ page }) => {
  const vault = await openTaskVault(page);

  await page.keyboard.down('Meta');
  await page.keyboard.down('Shift');
  await page.keyboard.press('n');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Meta');

  await page.getByRole('textbox', { name: 'What needs doing' }).fill('Only this');
  await page.getByRole('textbox', { name: 'What needs doing' }).press('Enter');
  await expectFile(vault, 'Inbox/Only this.md').toContain('type: task');

  await expect(page.getByRole('treeitem', { name: 'Untitled', exact: true })).toHaveCount(0);
});

test('a card dropped on a column is drawn there before its write lands (#260)', async ({
  page,
}) => {
  const { vault, host } = await openTaskVaultOn(page);
  await openBoard(page);
  await expect(cardIn(page, 'Doing', 'one off.md')).toBeVisible();
  const release = host.holdWrites('one off.md');

  await dragCardTo(page, 'one off.md', 'Done');

  // In its new column while the file still says otherwise: it does not snap back meanwhile (#257).
  await expect(cardIn(page, 'Done', 'one off.md')).toBeVisible();
  await expect(cardIn(page, 'Doing', 'one off.md')).toHaveCount(0);
  expect(await vault.read('one off.md')).toContain('status: doing');

  // The write has reached the host and is held there, not still on its way.
  await expect.poll(() => host.writesTo('one off.md')).toBeGreaterThan(0);
  release();
  await expectFile(vault, 'one off.md').toContain('status: done');
  await expect(cardIn(page, 'Done', 'one off.md')).toBeVisible();
  await expect(cardIn(page, 'Doing', 'one off.md')).toHaveCount(0);
});

test('a repeating task dropped on done is drawn back in play at once, not on done (#260)', async ({
  page,
}) => {
  const { vault, host } = await openTaskVaultOn(page);
  await openBoard(page);
  await expect(cardIn(page, 'Doing', 'water the plants.md')).toBeVisible();
  const release = host.holdWrites('water the plants.md');

  await dragCardTo(page, 'water the plants.md', 'Done');

  await expect(cardIn(page, 'Backlog', 'water the plants.md')).toBeVisible();
  await expect(cardIn(page, 'Backlog', 'water the plants.md')).toContainText('Sep 27, 2026');
  await expect(cardIn(page, 'Done', 'water the plants.md')).toHaveCount(0);
  expect(await vault.read('water the plants.md')).toContain('status: doing');

  // The write has reached the host and is held there, not still on its way.
  await expect.poll(() => host.writesTo('water the plants.md')).toBeGreaterThan(0);
  release();
  await expectFile(vault, 'water the plants.md').toContain('due: 2026-09-27');
  await expect(cardIn(page, 'Backlog', 'water the plants.md')).toBeVisible();
});

test('a card whose write fails goes back to its column on the board, and the board says why (#260)', async ({
  page,
}) => {
  const { vault, host } = await openTaskVaultOn(page);
  await openBoard(page);
  const release = host.holdWrites('one off.md');

  await dragCardTo(page, 'one off.md', 'Done');
  await expect(cardIn(page, 'Done', 'one off.md')).toBeVisible();

  // The write has reached the host and is held there, not still on its way.
  await expect.poll(() => host.writesTo('one off.md')).toBeGreaterThan(0);
  release({ fail: 'The disk is full.' });

  await expect(page.getByText(/The disk is full/)).toBeVisible();
  // The board stays drawn, with the card back in the column it was moved from.
  await expect(cardIn(page, 'Doing', 'one off.md')).toBeVisible();
  await expect(cardIn(page, 'Done', 'one off.md')).toHaveCount(0);
  expect(await vault.read('one off.md')).toContain('status: doing');
});
