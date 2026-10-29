import { expect, test, type Page } from './fixtures.ts';
import { dragAnnouncement, dragWithPointer } from './drag.ts';
import {
  createVault,
  emitVaultChanged,
  expectFile,
  installHost,
  sidebarSection,
  type FakeVault,
} from './host.ts';

/**
 * P31-01: timeblocks are notes of the Block type, written into a vault whose
 * tasks follow GTD as it opens. A task's page shows its estimate beside what its
 * blocks schedule and what is done, and says when it is over-scheduled.
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
  '  estimate:',
  '    kind: number',
  '    label: Estimate (minutes)',
  '---',
  '',
  '# Task',
  '',
].join('\n');

const task = (estimate: number) =>
  note(['type: task', 'status: next-action', `estimate: ${estimate}`], 'Something to do.');

const block = (start: string, end: string, tasks: readonly string[]) =>
  note(
    [
      'type: block',
      `start: ${start}`,
      `end: ${end}`,
      'tasks:',
      ...tasks.map((name) => `  - "[[${name}]]"`),
    ],
    'Time set aside.',
  );

async function openVault(page: Page): Promise<FakeVault> {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write('Quarterly report.md', task(120));
  await vault.write('Invoice Larkspur.md', task(20));
  await vault.write('Call Mara.md', task(20));
  await vault.write('Reply to Tobias.md', task(20));
  // The report, split over three blocks: 1h, 30m and 30m.
  // Notes at the top of the vault, so the tree lists each without opening a folder.
  await vault.write(
    'Monday focus.md',
    block('2026-10-12T09:00', '2026-10-12T10:00', ['Quarterly report']),
  );
  await vault.write(
    'Tuesday focus.md',
    block('2026-10-13T14:00', '2026-10-13T14:30', ['Quarterly report']),
  );
  await vault.write(
    'Late push.md',
    block('2026-10-14T23:45', '2026-10-15T00:15', ['Quarterly report']),
  );
  // An hour of admin, shared by three 20-minute tasks; Mara's call also has a half hour of its own.
  await vault.write(
    'Admin.md',
    block('2026-10-12T13:00', '2026-10-12T14:00', [
      'Invoice Larkspur',
      'Call Mara',
      'Reply to Tobias',
    ]),
  );
  await vault.write('Call slot.md', block('2026-10-12T16:00', '2026-10-12T16:30', ['Call Mara']));

  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return vault;
}

async function openNote(page: Page, name: string) {
  await page.getByRole('treeitem', { name, exact: true }).click();
  await expect(page.getByRole('article', { name })).toBeVisible();
}

const schedule = (page: Page) => page.getByRole('region', { name: 'Schedule' });

test('a vault whose tasks follow GTD gets the Block type as it opens', async ({ page }) => {
  const vault = await openVault(page);

  await expectFile(vault, '.atlas/types/block.md').toContain('name: block\n');
  const type = await vault.read('.atlas/types/block.md');
  expect(type).toContain('  tasks:\n    kind: relation\n    target: task\n    many: true\n');
  // The Task type gains DFAI's own `focus` alone (#108); nothing of its own changes.
  await expectFile(vault, '.atlas/types/task.md').toBe(
    TASK_TYPE.replace(
      '    label: Estimate (minutes)\n',
      '    label: Estimate (minutes)\n  focus:\n    kind: date\n    label: Chosen for\n',
    ),
  );
});

test('a 2h task split over 1h, 30m and 30m blocks reads 2h scheduled of 2h', async ({ page }) => {
  await openVault(page);
  await openNote(page, 'Quarterly report');

  await expect(schedule(page)).toContainText('Scheduled2h of 2h');
  await expect(schedule(page)).toContainText('Done0m of 2h');
  await expect(schedule(page)).not.toContainText('over the estimate');
});

test('a container shares its hour among its tasks, and over-scheduling is said', async ({
  page,
}) => {
  await openVault(page);

  await openNote(page, 'Invoice Larkspur');
  await expect(schedule(page)).toContainText('Scheduled20m of 20m');

  await openNote(page, 'Call Mara');
  await expect(schedule(page)).toContainText('Scheduled50m of 20m');
  await expect(schedule(page)).toContainText('30m over the estimate');
});

test('the schedule follows an estimate edited on the task’s page', async ({ page }) => {
  const vault = await openVault(page);
  await openNote(page, 'Quarterly report');
  await expect(schedule(page)).toContainText('Scheduled2h of 2h');

  const estimate = page
    .getByRole('region', { name: 'Properties' })
    .getByLabel('Estimate (minutes)', { exact: true });
  await estimate.fill('90');
  await estimate.press('Enter');

  await expectFile(vault, 'Quarterly report.md').toContain('estimate: 90\n');
  // The watcher tells the app its own save landed, and the index takes it in.
  await emitVaultChanged(page, ['Quarterly report.md']);
  await expect(schedule(page)).toContainText('Scheduled2h of 1h 30m');
  await expect(schedule(page)).toContainText('30m over the estimate');
});

test('a note that is not a task shows no schedule', async ({ page }) => {
  await openVault(page);
  await openNote(page, 'Admin');
  await expect(page.getByRole('region', { name: 'Properties' })).toBeVisible();
  await expect(schedule(page)).toHaveCount(0);
});

/**
 * P31-02: planning the day. A calendar of blocks has the next actions beside
 * its week, to drag onto empty time — a block for the task, sized to what it
 * still needs — or onto a block, which it joins. The page's clock is held on
 * Monday 12 October 2026 at noon, local time.
 */
const PLAN_NOW = new Date(2026, 9, 12, 12);

const GTD_TASK_TYPE = [
  '---',
  'name: task',
  'label: Task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [inbox, backlog, next-action, in-progress, waiting, someday, longterm, archive]',
  '    done: archive',
  '  contexts: multiSelect',
  '  defer: date',
  '  due: date',
  '  estimate:',
  '    kind: number',
  '    label: Estimate (minutes)',
  '  project:',
  '    kind: relation',
  '    target: project',
  '---',
  '',
  '# Task',
  '',
].join('\n');

const BLOCK_TYPE = [
  '---',
  'name: block',
  'label: Block',
  'properties:',
  '  start:',
  '    kind: date',
  '    required: true',
  '  end:',
  '    kind: date',
  '    required: true',
  '  tasks:',
  '    kind: relation',
  '    target: task',
  '    many: true',
  '---',
  '',
  '# Block',
  '',
].join('\n');

const PLAN_VIEW = [
  '---',
  'atlas: view',
  'type: block',
  'layout: calendar',
  'dateKey: start',
  'startKey: start',
  'endKey: end',
  'calendarRange: week',
  'columns: [start]',
  'limit: 100',
  '---',
  '',
  '# Plan',
  '',
].join('\n');

const ADMIN_BLOCK = block('2026-10-12T13:00', '2026-10-12T14:00', ['Invoice Larkspur']);

async function openPlanner(page: Page): Promise<FakeVault> {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/views');
  await vault.write('.atlas/types/task.md', GTD_TASK_TYPE);
  await vault.write('.atlas/types/block.md', BLOCK_TYPE);
  await vault.write('.atlas/views/Plan.md', PLAN_VIEW);
  await vault.write('Quarterly report.md', task(120));
  await vault.write('Call Mara.md', task(20));
  await vault.write('Invoice Larkspur.md', task(30));
  await vault.write('Reply to Tobias.md', task(15));
  // An hour of the report is set aside already: a drop makes a block for the hour left.
  await vault.write(
    'Monday focus.md',
    block('2026-10-12T09:00', '2026-10-12T10:00', ['Quarterly report']),
  );
  await vault.write('Admin.md', ADMIN_BLOCK);

  await installHost(page, vault);
  await page.clock.setFixedTime(PLAN_NOW);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await sidebarSection(page, 'views').getByRole('button', { name: 'Plan', exact: true }).click();
  await expect(page.locator('.clock__column')).toHaveCount(7);
  return vault;
}

const tray = (page: Page) => page.getByRole('complementary', { name: 'Next actions to plan' });
const trayTask = (page: Page, title: string) =>
  tray(page).locator(`.plan-tray__task[data-path="${title}.md"]`);

/** Scrolls the clock so `hour` is near its top, as a person scrolls to the part of the day they plan. */
async function showHour(page: Page, hour: number) {
  await page.locator('.clock__scroll').evaluate((clock, top) => {
    clock.scrollTop = top;
  }, hour * 48);
}

/** A point on a day's clock, `minutes` after midnight, as the page now draws it. */
async function onTheClock(page: Page, date: string, minutes: number) {
  const day = await page.locator(`.clock__column[data-date="${date}"]`).boundingBox();
  if (day === null) throw new Error(`${date} is not on screen`);
  return { x: day.x + day.width / 2, y: day.y + minutes * (48 / 60) + 4 };
}

test('a task dragged onto empty time becomes a block linked to it, for what it still needs', async ({
  page,
}) => {
  const vault = await openPlanner(page);
  // Nothing is set aside for the call or the reply yet, so they are listed first.
  await expect(tray(page).locator('.plan-tray__task')).toHaveText([
    /^Call Mara0m of 20m scheduled$/,
    /^Reply to Tobias0m of 15m scheduled$/,
    /^Invoice Larkspur1h of 30m scheduled$/,
    /^Quarterly report1h of 2h scheduled$/,
  ]);

  await showHour(page, 12);
  await dragWithPointer(page, {
    from: trayTask(page, 'Quarterly report'),
    to: await onTheClock(page, '2026-10-14', 14 * 60),
    overText: /Quarterly report would go on Wednesday 14 October 2026 at 14:00/,
  });

  await expectFile(vault, 'Quarterly report block.md').toBe(
    [
      '---',
      'type: block',
      'start: 2026-10-14T14:00',
      'end: 2026-10-14T15:00',
      'tasks:',
      '  - "[[Quarterly report]]"',
      '---',
      '',
    ].join('\n'),
  );
  await expect(page.locator('.clock__note[data-path="Quarterly report block.md"]')).toContainText(
    '14:00 – 15:00',
  );
  // Split over two blocks, the report is now scheduled for all of its estimate.
  await expect(trayTask(page, 'Quarterly report')).toContainText('2h of 2h scheduled');
});

test('a task dropped on a block joins its tasks, the rest of the block kept as written', async ({
  page,
}) => {
  const vault = await openPlanner(page);
  await showHour(page, 12);

  await dragWithPointer(page, {
    from: trayTask(page, 'Call Mara'),
    to: page.locator('.clock__note[data-path="Admin.md"]'),
    overText: /Call Mara would go in Admin\./,
  });

  await expectFile(vault, 'Admin.md').toBe(
    ADMIN_BLOCK.replace(
      '  - "[[Invoice Larkspur]]"\n',
      '  - "[[Invoice Larkspur]]"\n  - "[[Call Mara]]"\n',
    ),
  );
  // The hour is shared by what each still needs: the call's 20 minutes of it.
  await expect(trayTask(page, 'Call Mara')).toContainText('20m of 20m scheduled');
  expect(await vault.exists('Call Mara block.md')).toBe(false);
});

test('Escape that lands before a move has been announced is still heard as a cancel (#450)', async ({
  page,
}) => {
  await openPlanner(page);
  await showHour(page, 8);
  const to = await onTheClock(page, '2026-10-13', 10 * 60);
  const call = trayTask(page, 'Call Mara');
  const from = await call.boundingBox();
  if (from === null) throw new Error('the tray is not on screen');
  await page.mouse.move(from.x + 20, from.y + 10);
  await page.mouse.down();
  await page.mouse.move(from.x + 28, from.y + 18, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 20 });
  await expect(dragAnnouncement(page)).toContainText(/Call Mara would go on Tuesday/);

  // dnd-kit reports a move from an effect after the render the move caused.
  // Escape is pressed the moment that render reaches the page — its DOM
  // changes are observed — so the move is reported after the cancel, as on a
  // slow runner when the key lands between the two.
  await page.evaluate(
    ({ x, y }) =>
      new Promise<void>((done) => {
        const drawn = new MutationObserver(() => {
          drawn.disconnect();
          document.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }),
          );
          done();
        });
        drawn.observe(document.body, { subtree: true, attributes: true, childList: true });
        const held = document.querySelector('.plan-tray__task[data-path="Call Mara.md"] button');
        if (held === null) throw new Error('the held task is not on the page');
        held.dispatchEvent(
          new PointerEvent('pointermove', {
            clientX: x + 3,
            clientY: y + 2,
            bubbles: true,
            isPrimary: true,
            pointerId: 1,
          }),
        );
      }),
    to,
  );
  // React runs the move's pending effect before it draws the cancel, so once
  // the lifted task is gone the late move has been reported too.
  await expect(page.locator('.plan-tray__task--lifted')).toHaveCount(0);
  await expect(dragAnnouncement(page)).toHaveText('Cancelled. Call Mara is not planned.');
  await page.mouse.up();
});

test('the keyboard plans a task: choose it, go to the hour, Enter', async ({ page }) => {
  const vault = await openPlanner(page);

  await trayTask(page, 'Invoice Larkspur').getByRole('button').focus();
  await page.keyboard.press('Enter');
  // Today's first hour stop takes focus, and each hour says what Enter will do.
  await expect(
    page.getByRole('button', { name: 'Plan Invoice Larkspur at 09:00 on Monday 12 October 2026' }),
  ).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');

  // Admin gives it an hour, more than its 30 minutes, so it is given the default half hour.
  await expectFile(vault, 'Invoice Larkspur block.md').toContain(
    'start: 2026-10-12T11:00\nend: 2026-10-12T11:30\n',
  );
  await expect(trayTask(page, 'Invoice Larkspur').getByRole('button')).toBeFocused();
});

test('a drag cancelled midway plans nothing, and a drop is undone', async ({ page }) => {
  const vault = await openPlanner(page);
  await showHour(page, 8);
  const to = await onTheClock(page, '2026-10-13', 10 * 60);

  const call = trayTask(page, 'Call Mara');
  const from = await call.boundingBox();
  if (from === null) throw new Error('the tray is not on screen');
  await page.mouse.move(from.x + 20, from.y + 10);
  await page.mouse.down();
  await page.mouse.move(from.x + 28, from.y + 18, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 20 });
  await expect(dragAnnouncement(page)).toContainText(/Call Mara would go on Tuesday/);
  await page.keyboard.press('Escape');
  await expect(dragAnnouncement(page)).toContainText('Cancelled. Call Mara is not planned.');
  await page.mouse.up();
  expect(await vault.exists('Call Mara block.md')).toBe(false);

  await dragWithPointer(page, {
    from: call,
    to,
    overText: /Call Mara would go on Tuesday 13 October 2026 at 10:00/,
  });
  await expectFile(vault, 'Call Mara block.md').toContain('end: 2026-10-13T10:20\n');

  await tray(page).getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => vault.exists('Call Mara block.md')).toBe(false);
  await expect(page.locator('.clock__note[data-path="Call Mara block.md"]')).toHaveCount(0);
});
