import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, sidebarSection } from './host.ts';
import { dragCardTo, dragWithKeyboard } from './drag.ts';

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

const BOARD = [
  '---',
  'atlas: view',
  'type: task',
  'layout: board',
  'groupBy: status',
  'columns: [status, phase]',
  'limit: 50',
  '---',
  '',
  '# Board',
  '',
].join('\n');

// A task added from the board goes to the task type's home for today (#214).
const TODAY = new Date().toLocaleDateString('en-CA');
const [YEAR, MONTH] = [TODAY.slice(0, 4), TODAY.slice(5, 7)];
const TASKS = `Tasks/${YEAR}/${MONTH}`;

const task = (title: string, status: string) =>
  ['---', 'type: task', `status: ${status}`, 'phase: 1', '---', '', `# ${title}`, ''].join('\n');

async function openBoard(page: Page) {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/views');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write('.atlas/views/Board.md', BOARD);
  await vault.write('first.md', task('First', 'backlog'));
  await vault.write('second.md', task('Second', 'doing'));

  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();

  await sidebarSection(page, 'views').getByRole('button', { name: 'Board', exact: true }).click();
  return vault;
}

const cardHandle = (page: Page, title: string) =>
  page.getByRole('button', { name: title, exact: true });

test('a board shows a column per status, with the cards in them', async ({ page }) => {
  await openBoard(page);

  await expect(page.getByRole('region', { name: 'Backlog' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Doing' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Done' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'first', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'second', exact: true })).toBeVisible();
});

test('dragging a card writes the new status into its file', async ({ page }) => {
  const vault = await openBoard(page);
  await page.locator('[data-path="first.md"]').waitFor();

  await dragCardTo(page, 'first.md', 'Done');

  await expectFile(vault, 'first.md').toContain('status: done');
  // And the note itself is otherwise untouched.
  expect(await vault.read('first.md')).toContain('# First');
});

test('a card can be moved to another column with the keyboard alone', async ({ page }) => {
  const vault = await openBoard(page);

  // backlog → doing → done: two presses, so a card that moved only once, or
  // not at all, leaves a different status in the file.
  await dragWithKeyboard(page, cardHandle(page, 'first'), ['ArrowRight', 'ArrowRight']);

  await expectFile(vault, 'first.md').toContain('status: done');
  expect(await vault.read('first.md')).toContain('# First');
  // The card is drawn anew in done; focus goes with it, so the next Tab
  // carries on from the card rather than from the top of the page.
  await expect(
    page.getByRole('region', { name: 'Done' }).getByRole('button', { name: 'first', exact: true }),
  ).toBeFocused();
});

test('escape puts a keyboard-held card down without writing anything', async ({ page }) => {
  const vault = await openBoard(page);

  await dragWithKeyboard(page, cardHandle(page, 'first'), ['ArrowRight', 'ArrowRight'], {
    finish: 'Escape',
  });
  // A write that is known to happen, made after the cancel: once it has
  // landed, one the cancel made would have landed too.
  await dragWithKeyboard(page, cardHandle(page, 'second'), ['ArrowRight']);
  await expectFile(vault, 'second.md').toContain('status: done');

  expect(await vault.read('first.md')).toContain('status: backlog');
});

test('a key pressed straight after a keyboard pick-up is not lost on a slow runner', async ({
  page,
}) => {
  const vault = await openBoard(page);
  // A loaded CI runner gets to the page's timers late. dnd-kit's keyboard sensor
  // starts listening for arrows from a timer set at the pick-up, so this stands
  // in for that runner: every timer fires 200ms late, in its usual order.
  await page.evaluate(() => {
    const onTime = window.setTimeout.bind(window);
    window.setTimeout = ((run: TimerHandler, delay = 0, ...rest: unknown[]) =>
      onTime(run, Number(delay) + 200, ...rest)) as typeof window.setTimeout;
  });

  await dragWithKeyboard(page, cardHandle(page, 'first'), ['ArrowRight']);

  await expectFile(vault, 'first.md').toContain('status: doing');
});

test('clicking a card after dragging another still opens it', async ({ page }) => {
  const vault = await openBoard(page);
  await dragCardTo(page, 'second.md', 'Done');
  await expectFile(vault, 'second.md').toContain('status: done');

  await page.getByRole('button', { name: 'first', exact: true }).click();
  await expect(page.getByRole('article', { name: 'first' })).toBeVisible();
});

test('adding a card puts it in the column it was added to', async ({ page }) => {
  const vault = await openBoard(page);

  await page.getByRole('button', { name: 'Add to Doing' }).click();
  const input = page.getByRole('textbox', { name: 'New card in Doing' });
  await input.fill('A new card');
  await input.press('Enter');

  await expectFile(vault, `${TASKS}/A new card.md`).toContain('status: doing');
  expect(await vault.read(`${TASKS}/A new card.md`)).toContain('type: task');
});

test('a card opens the note behind it', async ({ page }) => {
  await openBoard(page);

  await page.getByRole('button', { name: 'first', exact: true }).click();
  await expect(page.getByRole('article', { name: 'first' })).toBeVisible();
});

test('a note can be renamed from its pane', async ({ page }) => {
  const vault = await openBoard(page);

  await page.getByRole('button', { name: 'first', exact: true }).click();
  await expect(page.getByRole('article', { name: 'first' })).toBeVisible();

  await page
    .getByRole('article', { name: 'first' })
    .getByRole('button', { name: 'first', exact: true })
    .click();
  const input = page.getByRole('textbox', { name: 'Note name' });
  await input.fill('Renamed task');
  await input.press('Enter');

  await expectFile(vault, 'Renamed task.md').toContain('# First');
  await expect(page.getByRole('article', { name: 'Renamed task' })).toBeVisible();
});

// Reported: the board is squeezed into a narrow column and there is no usable
// way to add a card.
test('the board uses the width of the window, not the width of prose', async ({ page }) => {
  await openBoard(page);
  await page.locator('[data-path="first.md"]').waitFor();

  const measured = await page.evaluate(() => {
    const board = document.querySelector('.board');
    const main = document.querySelector('.shell__main');
    if (board === null || main === null) return null;
    return {
      board: Math.round(board.getBoundingClientRect().width),
      available: Math.round(main.getBoundingClientRect().width),
    };
  });

  expect(measured).not.toBeNull();
  // Prose is capped at 78ch, about 700px. A board must not be.
  expect(measured?.board ?? 0).toBeGreaterThan((measured?.available ?? 0) * 0.8);
});

// Brief rule 7: the columns split the width equally, empty or not.
test('every column takes the same share of the width, the empty one included', async ({ page }) => {
  await openBoard(page);
  await page.locator('[data-path="first.md"]').waitFor();

  const measured = await page.evaluate(() => ({
    board: Math.round(document.querySelector('.board')?.getBoundingClientRect().width ?? 0),
    columns: [...document.querySelectorAll('.board__column')].map((column) => ({
      label: column.getAttribute('aria-label'),
      width: Math.round(column.getBoundingClientRect().width),
      cards: column.querySelectorAll('.board__card').length,
    })),
  }));

  const { board, columns } = measured;
  expect(columns.map((column) => column.label)).toEqual(['Backlog', 'Doing', 'Done']);
  expect(columns.find((column) => column.label === 'Done')?.cards).toBe(0);
  const [first, ...rest] = columns;
  expect(first?.width ?? 0).toBeGreaterThan(180);
  for (const column of rest) expect(column.width).toBeCloseTo(first?.width ?? 0, -1);
  // Equal shares of the whole width: not three capped columns beside a gap.
  const taken = columns.reduce((sum, column) => sum + column.width, 0);
  expect(taken, `columns ${taken}px of a ${board}px board`).toBeGreaterThan(board * 0.9);
});

test('the board fills the height available to it', async ({ page }) => {
  await openBoard(page);
  await page.locator('[data-path="first.md"]').waitFor();

  const measured = await page.evaluate(() => {
    const column = document.querySelector('.board__column');
    const main = document.querySelector('.shell__main');
    if (column === null || main === null) return null;
    return {
      column: Math.round(column.getBoundingClientRect().height),
      available: Math.round(main.getBoundingClientRect().height),
    };
  });

  expect(measured?.column ?? 0).toBeGreaterThan((measured?.available ?? 0) * 0.5);
});

test('a card can be added with a name, from the column', async ({ page }) => {
  const vault = await openBoard(page);
  await page.locator('[data-path="first.md"]').waitFor();

  await page.getByRole('button', { name: 'Add to Doing' }).click();
  const input = page.getByRole('textbox', { name: 'New card in Doing' });
  await input.fill('Write the release notes');
  await input.press('Enter');

  await expectFile(vault, `${TASKS}/Write the release notes.md`).toContain('status: doing');
  // Exact, and inside the column: once the sidebar catches up with the new note
  // its favourites star matches this name too, and a loose locator then fails
  // for a reason that has nothing to do with the board.
  await expect(
    page
      .getByRole('region', { name: 'Doing' })
      .getByRole('button', { name: 'Write the release notes', exact: true }),
  ).toBeVisible();
});

test('adding another card keeps the field open for the next one', async ({ page }) => {
  const vault = await openBoard(page);
  await page.locator('[data-path="first.md"]').waitFor();

  await page.getByRole('button', { name: 'Add to Backlog' }).click();
  const input = page.getByRole('textbox', { name: 'New card in Backlog' });
  await input.fill('First idea');
  await input.press('Enter');
  await input.fill('Second idea');
  await input.press('Enter');

  await expectFile(vault, `${TASKS}/First idea.md`).toContain('status: backlog');
  await expectFile(vault, `${TASKS}/Second idea.md`).toContain('status: backlog');
});

test('escape closes the add field without making a card', async ({ page }) => {
  await openBoard(page);
  await page.locator('[data-path="first.md"]').waitFor();

  await page.getByRole('button', { name: 'Add to Doing' }).click();
  await page.getByRole('textbox', { name: 'New card in Doing' }).press('Escape');

  await expect(page.getByRole('textbox', { name: 'New card in Doing' })).toHaveCount(0);
});
