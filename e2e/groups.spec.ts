import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, sidebarSection } from './host.ts';
import { dragWithKeyboard, dragWithPointer } from './drag.ts';
import { focusThenPress } from './typing.ts';

/**
 * Issue #6: groups and sub-groups on a table, Coda-style, and swimlanes on a
 * board — each checked in the files they write.
 */

const TASK_TYPE = [
  '---',
  'name: task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [backlog, doing, done]',
  '  area:',
  '    kind: select',
  '    options: [home, work]',
  '  estimate: number',
  '---',
  '',
].join('\n');

// A task added from a view goes to the task type's home for today (#214).
const TODAY = new Date().toLocaleDateString('en-CA');
const [YEAR, MONTH] = [TODAY.slice(0, 4), TODAY.slice(5, 7)];
const TASKS = `Tasks/${YEAR}/${MONTH}`;

const view = (name: string, lines: readonly string[]) =>
  [
    '---',
    'atlas: view',
    'type: task',
    ...lines,
    'columns: [status, area, estimate]',
    'limit: 50',
    '---',
    '',
    `# ${name}`,
    '',
  ].join('\n');

const task = (title: string, status: string, area: string, estimate: number) =>
  [
    '---',
    'type: task',
    `status: ${status}`,
    `area: ${area}`,
    `estimate: ${estimate}`,
    '---',
    '',
    `# ${title}`,
    '',
    'Body kept as written.',
    '',
  ].join('\n');

async function openVault(page: Page) {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/views');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write('.atlas/views/Table.md', view('Table', ['layout: table']));
  await vault.write(
    '.atlas/views/Grouped.md',
    view('Grouped', ['layout: table', 'groupBy: status', 'subGroupBy: area']),
  );
  await vault.write(
    '.atlas/views/Lanes.md',
    view('Lanes', ['layout: board', 'groupBy: status', 'subGroupBy: area']),
  );
  await vault.write('alpha.md', task('Alpha', 'doing', 'home', 2));
  await vault.write('beta.md', task('Beta', 'doing', 'work', 3));
  await vault.write('gamma.md', task('Gamma', 'backlog', 'home', 5));

  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return vault;
}

async function openView(page: Page, name: string) {
  await sidebarSection(page, 'views').getByRole('button', { name, exact: true }).click();
}

const header = (page: Page, name: RegExp) =>
  page.locator('.table__group-toggle').filter({ hasText: name });

test('a table is grouped, then sub-grouped, from the Group control', async ({ page }) => {
  await openVault(page);
  await openView(page, 'Table');
  await expect(page.locator('.table__title')).toHaveCount(3);
  await expect(page.locator('.table__group')).toHaveCount(0);

  await page.getByRole('button', { name: 'Group', exact: true }).click();
  await page
    .getByRole('radiogroup', { name: 'Group by' })
    .getByRole('radio', { name: 'Status' })
    .check();
  await page
    .getByRole('radiogroup', { name: 'Then by' })
    .getByRole('radio', { name: 'Area' })
    .check();
  await page.keyboard.press('Escape');

  // Backlog then doing, in the type's order; each with its count and sum.
  await expect(page.locator('.table__group-toggle[data-depth="0"]')).toHaveText([
    /^Backlog\s*1$/,
    /^Doing\s*2$/,
  ]);
  const doing = page.locator('tr.table__group').filter({ has: header(page, /^Doing/) });
  await expect(doing.getByLabel('2 tasks')).toBeVisible();
  await expect(doing.locator('.table__summary')).toHaveText(['', '', 'Sum 5']);
  // Sub-groups one step in: doing splits into home and work.
  await expect(page.locator('.table__group-toggle[data-depth="1"]')).toHaveText([
    /^Home\s*1$/,
    /^Home\s*1$/,
    /^Work\s*1$/,
  ]);
  await expect(page.locator('.table__title')).toHaveText(['gamma', 'alpha', 'beta']);
});

test('a folded group draws nothing of its rows, and stays folded on coming back', async ({
  page,
}) => {
  await openVault(page);
  await openView(page, 'Grouped');
  await expect(page.locator('.table__title')).toHaveText(['gamma', 'alpha', 'beta']);

  await header(page, /^Doing/).click();
  await expect(header(page, /^Doing/)).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.table__title')).toHaveText(['gamma']);

  // The keyboard folds too: Up through the lines above — gamma's name,
  // backlog's sub-group, then backlog itself (#248) — and Enter to fold it.
  await focusThenPress(header(page, /^Doing/), 'ArrowUp');
  await expect(page.locator('.table__row .table__link')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.table__group-toggle[data-depth="1"]')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(header(page, /^Backlog/)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.table__title')).toHaveCount(0);
  await page.keyboard.press('Space');
  await expect(page.locator('.table__title')).toHaveText(['gamma']);

  await openView(page, 'Table');
  await expect(page.locator('.table__title')).toHaveCount(3);
  await openView(page, 'Grouped');
  await expect(header(page, /^Doing/)).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.table__title')).toHaveText(['gamma']);
});

test('"+ New" at a sub-group’s foot makes a note with both of its values', async ({ page }) => {
  const vault = await openVault(page);
  await openView(page, 'Grouped');

  await page.getByRole('button', { name: 'New task in doing · work' }).click();

  await expectFile(vault, `${TASKS}/New task.md`).toContain('status: doing');
  const written = await vault.read(`${TASKS}/New task.md`);
  expect(written).toContain('area: work');
  expect(written).toContain('type: task');
});

test('a board lays swimlanes across its columns', async ({ page }) => {
  await openVault(page);
  await openView(page, 'Lanes');

  await expect(page.locator('.board__lane-head')).toHaveText([
    /^Backlog\s*1$/,
    /^Doing\s*2$/,
    /^Done\s*0$/,
  ]);
  const home = page.getByRole('region', { name: 'home lane' });
  await expect(home.getByLabel('2 cards')).toBeVisible();
  await expect(
    page
      .getByRole('region', { name: 'Doing, in Home' })
      .getByRole('button', { name: 'alpha', exact: true }),
  ).toBeVisible();

  await home.getByRole('button', { name: /^home/i }).click();
  await expect(home.getByRole('button', { name: /^home/i })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(page.getByRole('button', { name: 'alpha', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'beta', exact: true })).toBeVisible();
});

test('dragging a card to another column and lane writes both properties', async ({ page }) => {
  const vault = await openVault(page);
  await openView(page, 'Lanes');

  await dragWithPointer(page, {
    from: page.locator('.board__card[data-path="alpha.md"]'),
    to: page.getByRole('region', { name: 'Done, in Work', exact: true }),
    overText: 'is over Done, in Work.',
  });

  await expectFile(vault, 'alpha.md').toContain('status: done');
  const written = await vault.read('alpha.md');
  expect(written).toContain('area: work');
  // Everything nobody moved is as it was.
  expect(written).toContain('estimate: 2');
  expect(written).toContain('# Alpha\n\nBody kept as written.\n');
});

test('a card moves across a column and a lane from the keyboard alone', async ({ page }) => {
  const vault = await openVault(page);
  await openView(page, 'Lanes');

  // doing, in work → backlog, in home: one left, one up.
  await dragWithKeyboard(page, page.getByRole('button', { name: 'beta', exact: true }), [
    'ArrowLeft',
    'ArrowUp',
  ]);

  await expectFile(vault, 'beta.md').toContain('status: backlog');
  expect(await vault.read('beta.md')).toContain('area: home');
});

test('"+ New" in a board cell makes a note in its column and lane', async ({ page }) => {
  const vault = await openVault(page);
  await openView(page, 'Lanes');

  const cell = page.getByRole('region', { name: 'Done, in Home', exact: true });
  await cell.hover();
  await cell.getByRole('button', { name: 'Add to Done, in Home' }).click();
  const input = page.getByRole('textbox', { name: 'New card in Done, in Home' });
  await input.fill('Paint');
  await input.press('Enter');

  await expectFile(vault, `${TASKS}/Paint.md`).toContain('status: done');
  expect(await vault.read(`${TASKS}/Paint.md`)).toContain('area: home');
});
