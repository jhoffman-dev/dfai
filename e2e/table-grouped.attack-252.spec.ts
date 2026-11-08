/**
 * Attack on #252 (#248): a very long grouped table — 2,000 tasks in three
 * groups — driven from the keyboard in WebKit. Wherever the arrows, Home and
 * End take the focus, it is on a stop that is in view and uncovered, and
 * never lost to the body, however fast the keys come.
 */
import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost, sidebarSection } from './host.ts';
import { focusOn, focusThenPress } from './typing.ts';

const TASKS = 2000;
const STATUSES = ['backlog', 'doing', 'done'] as const;

const TASK_TYPE = [
  '---',
  'name: task',
  'properties:',
  '  status:',
  '    kind: select',
  `    options: [${STATUSES.join(', ')}]`,
  '---',
  '',
].join('\n');

const title = (at: number) => `Chore ${String(at).padStart(4, '0')}`;
/** Backlog, Doing and Done in turn by thirds. */
const statusOf = (at: number) => STATUSES[Math.min(2, Math.floor(((at - 1) * 3) / TASKS))];

async function openGroupedTable(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/views');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write(
    '.atlas/views/Grouped.md',
    [
      '---',
      'atlas: view',
      'type: task',
      'layout: table',
      'groupBy: status',
      'columns: [status]',
      `limit: ${TASKS * 2}`,
      '---',
      '',
      '# Grouped',
      '',
    ].join('\n'),
  );
  await vault.mkdir('Chores');
  for (let at = 1; at <= TASKS; at += 1) {
    await vault.write(
      `Chores/${title(at)}.md`,
      ['---', 'type: task', `status: ${statusOf(at)}`, '---', '', `# ${title(at)}`, ''].join('\n'),
    );
  }
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible({ timeout: 30_000 });
  await sidebarSection(page, 'views').getByRole('button', { name: 'Grouped', exact: true }).click();
  await expect(page.locator('.table__group-toggle').first()).toHaveText(/^Backlog/);
}

/** Where the focus is: its line, whether it is a stop, and whether it is in the sheet's view and on top. */
async function focusState(page: Page) {
  return page.evaluate(() => {
    const focused = document.activeElement as HTMLElement | null;
    const onBody = focused === null || focused === document.body;
    const line = focused?.closest('tr')?.getAttribute('data-index') ?? null;
    const stop = focused?.hasAttribute('data-row-stop') ?? false;
    if (focused === null || onBody) return { onBody, line, stop, shown: false };
    const box = focused.getBoundingClientRect();
    const sheet = focused.closest('.table__sheet')?.getBoundingClientRect();
    const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    const inSheet = sheet !== undefined && box.top >= sheet.top && box.bottom <= sheet.bottom;
    return { onBody, line, stop, shown: inSheet && top !== null && focused.contains(top) };
  });
}

const settled = { onBody: false, stop: true, shown: true };

test('End, Home and a fast run of arrows in a 2,000-row grouped table keep the focus in view', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openGroupedTable(page);
  const lineCount =
    Number(await page.locator('table.table__grid').getAttribute('aria-rowcount')) - 1;
  // Three headers, 2,000 rows, three "+ New".
  expect(lineCount).toBe(TASKS + 6);

  await focusThenPress(page.locator('.table__group-toggle').first(), 'End');
  // The last row is the line before Done's "+ New".
  await expect.poll(() => focusState(page)).toEqual({ ...settled, line: String(lineCount - 2) });

  // A burst of Up presses, as a held key sends them, faster than frames: the
  // focus ends on a stop in view. Where exactly is left to the jsdom test —
  // a press that comes before the line it needs is drawn is lost (#252 attack).
  for (let step = 0; step < 40; step += 1) await page.keyboard.press('ArrowUp');
  await expect.poll(() => focusState(page)).toMatchObject(settled);
  expect(Number((await focusState(page)).line)).toBeLessThan(lineCount - 2);

  await page.keyboard.press('Home');
  await expect.poll(() => focusState(page)).toEqual({ ...settled, line: '0' });

  // A second round trip, from a table already scrolled both ways.
  await page.keyboard.press('End');
  await expect.poll(() => focusState(page)).toEqual({ ...settled, line: String(lineCount - 2) });
  await page.keyboard.press('Home');
  await expect.poll(() => focusState(page)).toEqual({ ...settled, line: '0' });
});

test('a held Down never drops the focus to the body, at any step', async ({ page }) => {
  test.setTimeout(120_000);
  await openGroupedTable(page);
  await focusOn(page.locator('.table__group-toggle').first());
  let lost = 0;
  for (let step = 0; step < 60; step += 1) {
    await page.keyboard.press('ArrowDown');
    if ((await focusState(page)).onBody) lost += 1;
  }
  expect(lost).toBe(0);
  await expect.poll(() => focusState(page)).toEqual({ ...settled, line: '60' });
});
