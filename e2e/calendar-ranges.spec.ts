import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, sidebarSection } from './host.ts';
import { dragWithKeyboard, dragWithPointer } from './drag.ts';
import { focusThenPress } from './typing.ts';

/**
 * The calendar's ranges (U-14): month, week, 3 days, day and agenda, with the
 * page's clock held on Tuesday 22 September 2026 at noon, local time.
 */
const NOW = new Date(2026, 8, 22, 12);

/** A task added on the calendar goes to the task type's home for the page's today (#214). */
const TASKS = 'Tasks/2026/09';

const TASK_TYPE = ['---', 'name: task', 'properties:', '  due: date', '---', ''].join('\n');

const CALENDAR = [
  '---',
  'atlas: view',
  'type: task',
  'layout: calendar',
  'dateKey: due',
  'columns: [due]',
  'limit: 100',
  '---',
  '',
  '# Calendar',
  '',
].join('\n');

const task = (due: string, body: string) =>
  ['---', 'type: task', `due: ${due}`, '---', '', body, ''].join('\n');

async function openCalendar(page: Page) {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/views');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write('.atlas/views/Calendar.md', CALENDAR);
  await vault.write('standup.md', task('2026-09-22T09:00', 'Every morning.'));
  await vault.write('errand.md', task('2026-09-22', 'Some time today.'));
  await vault.write('overdue.md', task('2026-09-18', 'Should have been done.'));

  await installHost(page, vault);
  await page.clock.setFixedTime(NOW);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await sidebarSection(page, 'views')
    .getByRole('button', { name: 'Calendar', exact: true })
    .click();
  await expect(page.locator('.calendar__grid')).toBeVisible();
  return vault;
}

const title = (page: Page) =>
  page.getByRole('group', { name: 'Calendar dates' }).locator('.month-nav__label');

async function chooseRange(page: Page, range: string) {
  await page
    .getByRole('radiogroup', { name: 'Calendar range' })
    .getByRole('radio', { name: range, exact: true })
    .click();
}

const columns = (page: Page) => page.getByRole('group', { name: /^\d{4}-\d{2}-\d{2}$/ });

test('each range has its own title and columns', async ({ page }) => {
  await openCalendar(page);
  await expect(title(page)).toHaveText('September 2026');

  await chooseRange(page, 'Week');
  await expect(title(page)).toHaveText('Sep 21 – 27, 2026');
  await expect(columns(page)).toHaveCount(7);
  await expect(columns(page).first()).toHaveAttribute('aria-label', '2026-09-21');

  await chooseRange(page, '3 days');
  await expect(title(page)).toHaveText('Sep 22 – 24');
  await expect(columns(page)).toHaveCount(3);

  await chooseRange(page, 'Day');
  await expect(title(page)).toHaveText('Tue, Sep 22, 2026');
  await expect(columns(page)).toHaveCount(1);
  // The day's all-day note is listed above its clock, and its timed one on it.
  await expect(
    page.getByLabel('All day 2026-09-22').getByRole('button', { name: 'errand' }),
  ).toBeVisible();
  await expect(
    page.getByLabel('2026-09-22', { exact: true }).getByRole('button', { name: /standup/ }),
  ).toBeVisible();

  await chooseRange(page, 'Agenda');
  await expect(title(page)).toHaveText('From Sep 22');

  await focusThenPress(page.getByRole('region', { name: 'Calendar' }), 'w');
  await expect(title(page)).toHaveText('Sep 21 – 27, 2026');
  await page.keyboard.press('ArrowRight');
  await expect(title(page)).toHaveText('Sep 28 – Oct 4, 2026');
  await page.keyboard.press('t');
  await expect(title(page)).toHaveText('Sep 21 – 27, 2026');
});

test('the range is an unsaved change until Save view writes it', async ({ page }) => {
  const vault = await openCalendar(page);
  await chooseRange(page, 'Week');
  await page.getByRole('button', { name: 'Save view' }).click();
  await expectFile(vault, '.atlas/views/Calendar.md').toContain('calendarRange: week');
});

test('dragging a note to another day and time in the week writes it, keeping its time shape', async ({
  page,
}) => {
  const vault = await openCalendar(page);
  await chooseRange(page, 'Week');

  const standup = page.getByRole('button', { name: /^standup/ });
  const from = await standup.boundingBox();
  const column = await columns(page).first().boundingBox();
  if (from === null || column === null) throw new Error('the week is not on screen');
  const grab = { x: from.x + from.width / 2, y: from.y + 6 };
  // A day along and an hour down: 48px is an hour on the clock.
  await dragWithPointer(page, {
    from: grab,
    to: { x: grab.x + column.width, y: grab.y + 48 },
    overText: /standup would be on Wednesday 23 September 2026 at 10:00/,
  });
  await expectFile(vault, 'standup.md').toContain('due: 2026-09-23T10:00');

  // An all-day note moved a day with the keyboard stays a date.
  await dragWithKeyboard(page, page.getByRole('button', { name: 'errand', exact: true }), [
    'ArrowRight',
  ]);
  await expectFile(vault, 'errand.md').toMatch(/due: 2026-09-23\n/);
});

test('the agenda shows what is overdue, then today', async ({ page }) => {
  await openCalendar(page);
  await chooseRange(page, 'Agenda');

  const overdue = page.getByRole('region', { name: 'Overdue' });
  await expect(overdue.getByRole('button', { name: 'overdue' })).toBeVisible();
  const today = page.getByRole('region', { name: 'Today, Tue, Sep 22, 2026' });
  await expect(today.getByRole('button', { name: 'errand' })).toBeVisible();
  await expect(today.getByRole('button', { name: 'standup' })).toBeVisible();
  // Overdue is listed first, above today.
  const overdueTop = (await overdue.boundingBox())?.y ?? Infinity;
  const todayTop = (await today.boundingBox())?.y ?? -Infinity;
  expect(overdueTop).toBeLessThan(todayTop);
});

test('clicking an empty slot on the clock adds a note at that time', async ({ page }) => {
  const vault = await openCalendar(page);
  await chooseRange(page, '3 days');

  // 14:00 is 14 hours of 48px down the column.
  await page
    .getByLabel('2026-09-23', { exact: true })
    .click({ position: { x: 20, y: 14 * 48 + 5 } });
  await page.getByRole('textbox', { name: /New card in 2026-09-23 at 14:00/ }).fill('Lunch');
  await page.keyboard.press('Enter');

  await expectFile(vault, `${TASKS}/Lunch.md`).toMatch(/due: '?2026-09-23T14:00'?/);
  await expect(
    page.getByLabel('2026-09-23', { exact: true }).getByRole('button', { name: /Lunch/ }),
  ).toBeVisible();
});

test('a keyboard adds a note at an hour: to the day, down the hours, Enter', async ({ page }) => {
  const vault = await openCalendar(page);
  await chooseRange(page, '3 days');

  await page.getByRole('button', { name: 'Add at 09:00 on Wednesday 23 September 2026' }).focus();
  for (let hour = 9; hour < 14; hour += 1) await page.keyboard.press('ArrowDown');
  await expect(
    page.getByRole('button', { name: 'Add at 14:00 on Wednesday 23 September 2026' }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: /New card in 2026-09-23 at 14:00/ }).fill('Dentist');
  await page.keyboard.press('Enter');

  await expectFile(vault, `${TASKS}/Dentist.md`).toMatch(/due: '?2026-09-23T14:00'?/);
});
