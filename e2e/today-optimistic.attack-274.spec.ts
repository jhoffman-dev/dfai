import { utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from './fixtures.ts';
import { createVault, emitVaultChanged, expectFile, installHost, type FakeHost } from './host.ts';
import { focusThenPress } from './typing.ts';

/**
 * Adversarial pass on #260 (PR #274), in WebKit: Today draws a tick before
 * its write lands. A ticked repeating task must be drawn where its roll puts
 * it; a failed write must put the row back with focus on it, not lost to
 * `<body>`; an outside edit while the write is held must be refused, not
 * written over; and 500 rows must still hand focus on after a held tick.
 */

const NOW = new Date(2026, 9, 13, 12, 0, 0);
const DAY = 86_400_000;

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
  '  defer: date',
  '  recurrence: text',
  '---',
  '',
].join('\n');

const task = (frontmatter: string[]) =>
  ['---', 'type: task', ...frontmatter, '---', '', 'A task.', ''].join('\n');

async function openTodayWith(
  page: Page,
  notes: Record<string, string>,
): Promise<{ host: FakeHost; vault: Awaited<ReturnType<typeof createVault>> }> {
  const vault = await createVault();
  for (const folder of ['.atlas/types', 'Tasks']) await vault.mkdir(folder);
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await Promise.all(Object.entries(notes).map(([path, text]) => vault.write(path, text)));
  const when = new Date(NOW.getTime() - DAY);
  await Promise.all(Object.keys(notes).map((path) => utimes(join(vault.root, path), when, when)));
  const host = await installHost(page, vault);
  await page.clock.setFixedTime(NOW);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible({ timeout: 60_000 });
  await page.getByRole('list', { name: 'Go to' }).getByRole('button', { name: 'Today' }).click();
  await expect(today(page)).toBeVisible();
  return { host, vault };
}

const today = (page: Page) => page.getByRole('article', { name: 'Today' });
const section = (page: Page, name: string) =>
  today(page).getByRole('region', { name, exact: true });
const itemsIn = (page: Page, name: string) => section(page, name).locator('.table__title');

/** The row the focus is in, by its path; 'body' when it is lost to the document. */
function focusedRow(page: Page): Promise<string> {
  return page.evaluate(async () => {
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const at = document.activeElement;
    if (at === null || at === document.body) return 'body';
    return (
      at.closest('[data-today-row]')?.getAttribute('data-today-row') ?? `not a row: ${at.tagName}`
    );
  });
}

test('a ticked repeating task is drawn where its roll puts it while the write is held', async ({
  page,
}) => {
  const { host, vault } = await openTodayWith(page, {
    'Tasks/Water the plants.md': task([
      'status: in-progress',
      'due: 2026-10-10',
      'recurrence: daily',
    ]),
    'Tasks/Call the bank.md': task(['status: next-action']),
  });
  await expect(itemsIn(page, 'Overdue')).toHaveText(['Water the plants']);
  const release = host.holdWrites('Tasks/Water the plants.md');

  await section(page, 'Overdue')
    .getByRole('checkbox', { name: 'Mark Water the plants done' })
    .click();
  await expect.poll(() => host.writesTo('Tasks/Water the plants.md')).toBeGreaterThan(0);

  // The roll leaves it Next Action, due 10-11: still overdue. Received on
  // fb990142: the Overdue section empties until the index reads the roll.
  await expect(itemsIn(page, 'Overdue')).toHaveText(['Water the plants'], { timeout: 1_000 });
  release();
  await expectFile(vault, 'Tasks/Water the plants.md').toContain('due: 2026-10-11');
  await expect(itemsIn(page, 'Overdue')).toHaveText(['Water the plants']);
});

test('a tick whose write fails puts the row back with the focus on it, not on the document', async ({
  page,
}) => {
  const { host } = await openTodayWith(page, {
    'Tasks/Draft the plan.md': task(['status: in-progress']),
    'Tasks/Ship the page.md': task(['status: in-progress']),
  });
  await expect(itemsIn(page, 'In progress')).toHaveText(['Draft the plan', 'Ship the page']);
  const release = host.holdWrites('Tasks/Draft the plan.md');
  const box = section(page, 'In progress').getByRole('checkbox', {
    name: 'Mark Draft the plan done',
  });
  await focusThenPress(box, 'Space');
  await expect(itemsIn(page, 'In progress')).toHaveText(['Ship the page']);
  await expect.poll(() => host.writesTo('Tasks/Draft the plan.md')).toBeGreaterThan(0);

  release({ fail: 'The disk is full.' });
  await expect(itemsIn(page, 'In progress')).toHaveText(['Draft the plan', 'Ship the page']);
  await expect(today(page).getByText(/The disk is full/)).toBeVisible();

  // Focus follows the work (#111): the row is back, so focus is in it again.
  // Received on fb990142: 'body' — the row left with the focus, and came back without it.
  await expect.poll(() => focusedRow(page)).toBe('Tasks/Draft the plan.md');
});

test('an outside edit while a tick is held is refused, not written over, and the row shows the edit', async ({
  page,
}) => {
  const { host, vault } = await openTodayWith(page, {
    'Tasks/Draft the plan.md': task(['status: in-progress']),
    'Tasks/Ship the page.md': task(['status: next-action']),
  });
  await expect(itemsIn(page, 'In progress')).toHaveText(['Draft the plan']);
  const release = host.holdWrites('Tasks/Draft the plan.md');
  await section(page, 'In progress')
    .getByRole('checkbox', { name: 'Mark Draft the plan done' })
    .click();
  await expect.poll(() => host.writesTo('Tasks/Draft the plan.md')).toBeGreaterThan(0);

  // Another program puts it on hold while the tick is still on its way.
  await vault.write('Tasks/Draft the plan.md', task(['status: waiting']));
  await emitVaultChanged(page, ['Tasks/Draft the plan.md']);
  release();

  await expect(itemsIn(page, 'Waiting')).toHaveText(['Draft the plan']);
  await expect(today(page).getByText(/changed/)).toBeVisible();
  expect(await vault.read('Tasks/Draft the plan.md')).toContain('status: waiting');
});

const ROWS = 500;
const pad = (n: number) => String(n).padStart(3, '0');

test('500 rows: a held tick on the last row, then the first, each leaves at once and hands focus on', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const notes: Record<string, string> = {};
  for (let n = 1; n <= ROWS; n += 1)
    notes[`Tasks/Task ${pad(n)}.md`] = task(['status: next-action']);
  const { host, vault } = await openTodayWith(page, notes);
  const next = section(page, 'Next actions');
  await expect(next.locator('.review__count').first()).toHaveText(String(ROWS), {
    timeout: 30_000,
  });

  // The last row: reached from the keyboard, so the virtual list places it.
  await focusThenPress(next.getByRole('checkbox', { name: 'Mark Task 001 done' }), 'End');
  const last = next.getByRole('checkbox', { name: `Mark Task ${pad(ROWS)} done` });
  if (!(await last.isVisible())) await last.scrollIntoViewIfNeeded();
  let release = host.holdWrites(`Tasks/Task ${pad(ROWS)}.md`);
  await last.click();
  await expect(next.locator('.review__count').first()).toHaveText(String(ROWS - 1));
  release();
  await expectFile(vault, `Tasks/Task ${pad(ROWS)}.md`).toContain('status: archive');
  await expect.poll(() => focusedRow(page)).toBe(`Tasks/Task ${pad(ROWS - 1)}.md`);

  // Then the first.
  await page.keyboard.press('Home');
  const first = next.getByRole('checkbox', { name: 'Mark Task 001 done' });
  await first.scrollIntoViewIfNeeded();
  release = host.holdWrites('Tasks/Task 001.md');
  await first.click();
  await expect(next.locator('.review__count').first()).toHaveText(String(ROWS - 2));
  await expect(next.getByRole('checkbox', { name: 'Mark Task 001 done' })).toHaveCount(0);
  release();
  await expectFile(vault, 'Tasks/Task 001.md').toContain('status: archive');
  await expect.poll(() => focusedRow(page)).toBe('Tasks/Task 002.md');
});
