import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost, sidebarSection } from './host.ts';

const TASK_TYPE = [
  '---',
  'name: task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [backlog, next, doing, review, done]',
  '  phase: number',
  '---',
  '',
].join('\n');

const BOARD = [
  '---',
  'atlas: view',
  'type: task',
  'layout: board',
  'groupBy: status',
  'columns: [status, phase]',
  'limit: 200',
  '---',
  '',
  '# Board',
  '',
].join('\n');

/** A vault shaped like the real one: five columns, most cards in one of them. */
async function openBusyBoard(page: Page) {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/views');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write('.atlas/views/Board.md', BOARD);

  for (let i = 0; i < 30; i += 1) {
    const id = `P0${Math.floor(i / 10)}-${String(i % 10).padStart(2, '0')}`;
    await vault.write(
      `${id}.md`,
      [
        '---',
        `title: A task with a real name number ${i}`,
        'type: task',
        'status: done',
        'phase: 1',
        '---',
        '',
        `The description of task ${i}, which is what tells them apart.`,
        '',
      ].join('\n'),
    );
  }
  await vault.write(
    'U-01.md',
    [
      '---',
      'title: Something I asked for',
      'type: task',
      'status: backlog',
      '---',
      '',
      'Why it matters.',
      '',
    ].join('\n'),
  );

  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await sidebarSection(page, 'views').getByRole('button', { name: 'Board', exact: true }).click();
  await expect(page.locator('.board__column').first()).toBeVisible();
  return vault;
}

test('every column shows its Add control, however full the column is', async ({ page }) => {
  await openBusyBoard(page);

  for (const column of ['Backlog', 'Next', 'Doing', 'Review', 'Done']) {
    const add = page.getByRole('button', { name: `Add to ${column}` });
    await expect(add).toBeVisible();
    // Visible to Playwright is not the same as on screen: check it is in the box
    // the board occupies, rather than pushed below it by a full column.
    const inside = await add.evaluate((element) => {
      const board = document.querySelector('.board');
      if (board === null) return false;
      const a = element.getBoundingClientRect();
      const b = board.getBoundingClientRect();
      return a.bottom <= b.bottom + 1 && a.top >= b.top - 1;
    });
    expect(inside, `Add to ${column} sits outside the board`).toBe(true);
  }
});

test('a full column scrolls its own cards rather than growing past the board', async ({ page }) => {
  await openBusyBoard(page);

  const measured = await page.evaluate(() => {
    const column = [...document.querySelectorAll('.board__column')].find(
      (section) => section.getAttribute('aria-label') === 'done',
    );
    const board = document.querySelector('.board');
    if (column === undefined || board === null) return null;
    return {
      column: Math.round(column.getBoundingClientRect().height),
      board: Math.round(board.getBoundingClientRect().height),
    };
  });

  expect(measured?.column ?? 0).toBeLessThanOrEqual((measured?.board ?? 0) + 1);
});

test('the board scrolls sideways when the columns do not fit', async ({ page }) => {
  await openBusyBoard(page);
  // Opened wide, then squeezed: under 944px the sidebar is a drawer (#658).
  await page.setViewportSize({ width: 900, height: 800 });

  const scroll = await page.evaluate(() => {
    const board = document.querySelector('.board');
    if (board === null) return null;
    board.scrollLeft = 10_000;
    return { scrollable: board.scrollWidth > board.clientWidth, scrolled: board.scrollLeft };
  });

  expect(scroll?.scrollable, 'the board should overflow with five columns at 900px').toBe(true);
  expect(scroll?.scrolled ?? 0).toBeGreaterThan(0);
});

test('a card is named by the note, not by its filename', async ({ page }) => {
  await openBusyBoard(page);

  await expect(page.getByRole('button', { name: 'Something I asked for' })).toBeVisible();
});

test('a card shows what the note is about', async ({ page }) => {
  await openBusyBoard(page);

  await expect(page.getByText('Why it matters.')).toBeVisible();
});
