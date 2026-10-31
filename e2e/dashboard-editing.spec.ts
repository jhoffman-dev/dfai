import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, sidebarSection, type FakeVault } from './host.ts';
import { dragAnnouncement, dragWithPointer } from './drag.ts';

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

/**
 * Written the way the markdown writer writes, so a byte-for-byte comparison of
 * the widgets an edit did not touch is a fair one. `owner` is a key no widget
 * reads: it has to survive every edit.
 */
const TASKS_WIDGET = ['  - title: Tasks', '    kind: number', '    type: task'].join('\n');
const STATUS_WIDGET = [
  '  - title: By status',
  '    kind: bar',
  '    type: task',
  '    groupBy: status',
  '    span: 8',
  '    owner: james',
].join('\n');
const OPEN_WIDGET = [
  '  - title: Open work',
  '    kind: list',
  '    type: task',
  '    filters: [{key: status, operator: isNot, value: done}]',
].join('\n');

const DASHBOARD = [
  '---',
  'atlas: dashboard',
  'widgets:',
  TASKS_WIDGET,
  STATUS_WIDGET,
  OPEN_WIDGET,
  '---',
  '',
  '# Progress',
  '',
].join('\n');

const FILE = '.atlas/dashboards/Progress.md';

const task = (name: string, status: string) =>
  [`---`, 'type: task', `status: ${status}`, '---', '', `${name}.`, ''].join('\n');

/** `more` writes whatever else a test needs into the vault before it is opened. */
async function openDashboard(
  page: Page,
  more: (vault: FakeVault) => Promise<void> = async () => {},
): Promise<FakeVault> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/dashboards');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write(FILE, DASHBOARD);
  await vault.write('one.md', task('One', 'doing'));
  await vault.write('two.md', task('Two', 'doing'));
  await vault.write('three.md', task('Three', 'done'));
  await more(vault);

  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await sidebarSection(page, 'dashboards')
    .getByRole('button', { name: 'Progress', exact: true })
    .click();
  await expect(page.getByLabel('Tasks').getByText('3')).toBeVisible();
  return vault;
}

const dashboard = (page: Page) => page.getByLabel('Dashboard', { exact: true });
const widget = (page: Page, title: string) =>
  dashboard(page).getByRole('region', { name: title, exact: true });
const customize = (page: Page) => page.getByRole('button', { name: 'Customize' }).click();

/** The widgets' titles in the order the file lists them. */
async function titlesInFile(vault: FakeVault): Promise<string[]> {
  const text = await vault.read(FILE);
  return [...text.matchAll(/^ {2}- title: (.+)$/gm)].map((match) => match[1] ?? '');
}

async function widgetMenu(page: Page, title: string, command: string) {
  await widget(page, title).getByRole('button', { name: 'Widget options' }).click();
  await page.getByRole('menuitem', { name: command }).click();
}

test('adds a number widget through the sheet and draws it', async ({ page }) => {
  const vault = await openDashboard(page);
  await customize(page);
  await dashboard(page).getByRole('button', { name: 'Add widget' }).click();

  const sheet = page.getByRole('dialog', { name: 'Add widget' });
  await sheet.getByLabel('Title').fill('Doing now');
  await expect(sheet.getByRole('radio', { name: 'Number' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  const filters = sheet.getByRole('group', { name: 'Filters' });
  await filters.getByRole('combobox', { name: 'Property' }).selectOption('status');
  await filters.getByRole('combobox', { name: 'Value' }).fill('doing');
  await filters.getByRole('button', { name: 'Add filter' }).click();
  // The preview is the widget as the dashboard will draw it.
  await expect(sheet.getByRole('region', { name: 'Doing now' })).toContainText('2');
  await sheet.getByRole('button', { name: 'Add widget' }).click();

  await expect(sheet).toBeHidden();
  await expect(widget(page, 'Doing now')).toContainText('2');
  await expectFile(vault, FILE).toContain(
    [
      OPEN_WIDGET,
      '  - title: Doing now',
      '    kind: number',
      '    type: task',
      '    filters:',
      '      - key: status',
      '        operator: is',
      '        value: doing',
      '---',
    ].join('\n'),
  );
  // Nothing it did not add was rewritten.
  expect(await vault.read(FILE)).toContain(`widgets:\n${TASKS_WIDGET}\n${STATUS_WIDGET}\n`);
});

test('edits a widget’s title and filter, keeping keys it does not know', async ({ page }) => {
  const vault = await openDashboard(page);
  await widgetMenu(page, 'By status', 'Edit widget');

  const sheet = page.getByRole('dialog', { name: 'Edit widget' });
  await expect(sheet.getByLabel('Group by')).toHaveValue('status');
  await sheet.getByLabel('Title').fill('Unfinished');
  const filters = sheet.getByRole('group', { name: 'Filters' });
  await filters.getByRole('combobox', { name: 'Property' }).selectOption('status');
  await filters.getByRole('combobox', { name: 'Condition' }).selectOption('isNot');
  await filters.getByRole('combobox', { name: 'Value' }).fill('done');
  await filters.getByRole('button', { name: 'Add filter' }).click();
  await sheet.getByRole('button', { name: 'Save' }).click();

  await expect(widget(page, 'Unfinished').locator('.bars__label')).toHaveText(['doing']);
  await expectFile(vault, FILE).toContain(
    [
      '  - title: Unfinished',
      '    kind: bar',
      '    type: task',
      '    groupBy: status',
      '    span: 8',
      '    owner: james',
      '    filters:',
      '      - key: status',
      '        operator: isNot',
      '        value: done',
    ].join('\n'),
  );
  const text = await vault.read(FILE);
  expect(text).toContain(`widgets:\n${TASKS_WIDGET}\n`);
  expect(text).toContain(`${OPEN_WIDGET}\n---`);
});

test('explains a widget that cannot be drawn, and will not save it', async ({ page }) => {
  await openDashboard(page);
  await customize(page);
  await dashboard(page).getByRole('button', { name: 'Add widget' }).click();
  const sheet = page.getByRole('dialog', { name: 'Add widget' });

  await sheet.getByRole('radio', { name: 'Bar chart' }).click();

  await expect(sheet.getByText('A bar chart needs a property to group by.')).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Add widget' })).toBeDisabled();
  await sheet.getByLabel('Group by').selectOption('status');
  await expect(sheet.getByRole('button', { name: 'Add widget' })).toBeEnabled();
});

test('drags a widget to first place with the pointer', async ({ page }) => {
  const vault = await openDashboard(page);
  await customize(page);

  // A point, not the widget: the grid makes room as soon as the held widget is
  // over Tasks, and Tasks moves out from under the pointer.
  const tasks = await widget(page, 'Tasks').boundingBox();
  if (tasks === null) throw new Error('Tasks is not on screen');
  await dragWithPointer(page, {
    from: widget(page, 'Open work').getByRole('button', { name: 'Move Open work' }),
    to: { x: tasks.x + tasks.width / 2, y: tasks.y + tasks.height / 2 },
    overText: 'Open work is 1 of 3',
  });

  await expect.poll(() => titlesInFile(vault)).toEqual(['Open work', 'Tasks', 'By status']);
  const regions = dashboard(page).getByRole('region');
  await expect(regions).toHaveText([/Open work/, /Tasks/, /By status/]);
  expect(await vault.read(FILE)).toContain(`widgets:\n${OPEN_WIDGET}\n${TASKS_WIDGET}\n`);
});

test('resizes a bar chart from 8 columns to 6 by its edge', async ({ page }) => {
  const vault = await openDashboard(page);
  await customize(page);
  const chart = widget(page, 'By status');
  const before = await chart.boundingBox();
  const grid = await dashboard(page).boundingBox();
  if (before === null || grid === null) throw new Error('the dashboard is not on screen');
  // Twelve columns and eleven gaps of 24px fill the grid, less its 4px padding each side.
  const column = (grid.width - 8 + 24) / 12;
  const edge = await chart.locator('.widget__resize').boundingBox();
  if (edge === null) throw new Error('the resize edge is not on screen');
  const from = { x: edge.x + edge.width / 2, y: edge.y + edge.height / 2 };

  await dragWithPointer(page, {
    from,
    to: { x: from.x - 2 * column, y: from.y },
    overText: 'By status is 2 of 3, 6 columns wide.',
  });

  await expectFile(vault, FILE).toContain(STATUS_WIDGET.replace('span: 8', 'span: 6'));
  await expect(chart).toHaveCSS('--span', '6');
  const after = await chart.boundingBox();
  expect(after?.width).toBeLessThan(before.width - column);
});

test('removes a widget, and Cmd+Z puts it back', async ({ page }) => {
  const vault = await openDashboard(page);
  await customize(page);

  await widgetMenu(page, 'By status', 'Remove widget');

  await expect(widget(page, 'By status')).toHaveCount(0);
  await expect.poll(() => titlesInFile(vault)).toEqual(['Tasks', 'Open work']);
  expect(await vault.read(FILE)).toContain(`widgets:\n${TASKS_WIDGET}\n${OPEN_WIDGET}\n---`);

  await page.keyboard.press('ControlOrMeta+z');

  await expect(widget(page, 'By status')).toBeVisible();
  await expect.poll(() => titlesInFile(vault)).toEqual(['Tasks', 'By status', 'Open work']);
  expect(await vault.read(FILE)).toContain(STATUS_WIDGET);
});

test('moves and resizes with the keyboard alone', async ({ page }) => {
  const vault = await openDashboard(page);
  await customize(page);
  const grip = widget(page, 'Open work').getByRole('button', { name: 'Move Open work' });

  await grip.focus();
  await page.keyboard.press('Space');
  await expect(dragAnnouncement(page)).toHaveText('Picked up Open work, 3 of 3, 6 columns wide.');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowUp');
  await expect(dragAnnouncement(page)).toHaveText('Open work is 1 of 3, 6 columns wide.');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(dragAnnouncement(page)).toHaveText('Open work is 1 of 3, 7 columns wide.');
  await page.keyboard.press('Space');

  await expect.poll(() => titlesInFile(vault)).toEqual(['Open work', 'Tasks', 'By status']);
  await expectFile(vault, FILE).toContain(`widgets:\n${OPEN_WIDGET}\n    span: 7\n${TASKS_WIDGET}`);
  // The focus follows the widget to its new place, so the next move carries on.
  // Until the grid is redrawn from the file, the grip still focused is the one
  // about to be replaced, and it cannot be picked up: wait for the new one.
  const moved = widget(page, 'Open work').getByRole('button', { name: 'Move Open work' });
  await expect(moved).toHaveAttribute('aria-disabled', 'false');
  await expect(moved).toBeFocused();

  // Each key waits for the one before it to be said: pressed back to back, a
  // move and the Escape reached the grid before the pick-up had (Linux CI).
  await page.keyboard.press('Space');
  await expect(dragAnnouncement(page)).toHaveText('Picked up Open work, 1 of 3, 7 columns wide.');
  await page.keyboard.press('ArrowRight');
  await expect(dragAnnouncement(page)).not.toHaveText(/^Picked up/);
  await page.keyboard.press('Escape');
  await expect(dragAnnouncement(page)).toHaveText(
    'Cancelled. Open work stays 1 of 3, 7 columns wide.',
  );
  await expect.poll(() => titlesInFile(vault)).toEqual(['Open work', 'Tasks', 'By status']);
});

test('Done leaves the dashboard as it reads', async ({ page }) => {
  await openDashboard(page);
  await customize(page);
  await expect(dashboard(page).getByRole('button', { name: /^Move / })).toHaveCount(3);

  await page.getByRole('button', { name: 'Done' }).click();

  await expect(dashboard(page).getByRole('button', { name: /^Move / })).toHaveCount(0);
  await expect(dashboard(page).getByRole('button', { name: 'Add widget' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Customize' })).toBeVisible();
});

// Made from the vault's own template while a view is open: it used to land
// among the views, carrying the template's whole reference table as its body.
test('a new dashboard from the template goes with the dashboards, clean', async ({ page }) => {
  const template = await readFile('vault/.atlas/templates/Dashboard.md', 'utf8');
  const vault = await openDashboard(page, async (setUp) => {
    await setUp.mkdir('.atlas/templates');
    await setUp.mkdir('.atlas/views');
    await setUp.write('.atlas/templates/Dashboard.md', template);
    await setUp.write('.atlas/views/Open tasks.md', '---\natlas: view\ntype: task\n---\n');
  });
  await sidebarSection(page, 'views')
    .getByRole('button', { name: 'Open tasks', exact: true })
    .click();

  await page.getByRole('button', { name: 'New note' }).click();
  await page.getByRole('menuitem', { name: 'Dashboard' }).click();

  const made = '.atlas/dashboards/New Dashboard.md';
  await expectFile(vault, made).toContain('atlas: dashboard');
  expect(await vault.read('.atlas/views/New Dashboard.md')).toBe('');
  await expect(
    sidebarSection(page, 'dashboards').getByRole('button', { name: 'New Dashboard', exact: true }),
  ).toBeVisible();
  const body = (await vault.read(made)).split(/^---$/m)[2] ?? '';
  expect(body.trim().split('\n').length).toBeLessThanOrEqual(3);
  expect(body).not.toContain('| `kind`');
});
