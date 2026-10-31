import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, sidebarSection, type FakeHost } from './host.ts';
import { dragCardTo } from './drag.ts';

/**
 * Adversarial pass on #260 (PR #274), in WebKit: a card dropped on a board is
 * drawn in its new column before its write lands. A card moved on again
 * before that write lands must end where it was last put — on screen and in
 * its file — and one move's failure must not undo another card's move.
 */

const TASK_TYPE = [
  '---',
  'name: task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [backlog, doing, done]',
  '  due: date',
  '---',
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

const card = (status: string) =>
  ['---', 'type: task', `status: ${status}`, '---', '', 'A card.', ''].join('\n');

async function openBoard(page: Page) {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/views');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write('.atlas/views/Board.md', BOARD);
  await vault.write('one off.md', card('doing'));
  await vault.write('second card.md', card('doing'));
  const host: FakeHost = await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await sidebarSection(page, 'views').getByRole('button', { name: 'Board', exact: true }).click();
  await expect(page.locator('.board__column').first()).toBeVisible();
  return { vault, host };
}

const cardIn = (page: Page, column: string, path: string) =>
  page
    .locator('.board')
    .getByRole('region', { name: column, exact: true })
    .locator(`.board__card[data-path="${path}"]`);

test('a card dragged to done, then to backlog before the first write lands, ends in backlog', async ({
  page,
}) => {
  const { vault, host } = await openBoard(page);
  await expect(cardIn(page, 'Doing', 'one off.md')).toBeVisible();
  const release = host.holdWrites('one off.md');

  await dragCardTo(page, 'one off.md', 'Done');
  await expect(cardIn(page, 'Done', 'one off.md')).toBeVisible();
  await expect.poll(() => host.writesTo('one off.md')).toBe(1);
  await dragCardTo(page, 'one off.md', 'Backlog');
  await expect(cardIn(page, 'Backlog', 'one off.md')).toBeVisible();
  // Coordinator decision (PR #274): a card's writes are serialised, so the second
  // waits for the first and reads what it left. A refused first write can then
  // never be overwritten by the second. While the first is held, only it has
  // reached the host.
  expect(host.writesTo('one off.md')).toBe(1);
  release();
  await expect.poll(() => host.writesTo('one off.md')).toBe(2);

  // The last place it was put wins, in the file and on the board; the page's own
  // first write is not an outside change to refuse the second for. Received on
  // fb990142: the file says `status: done`, the card is drawn in done, and the
  // second write was refused with "the note changed on disk since it was opened"
  // — an alert the next run of the view clears, so the lost move goes unsaid.
  await expectFile(vault, 'one off.md').toContain('status: backlog');
  await expect(cardIn(page, 'Backlog', 'one off.md')).toBeVisible();
  await expect(page.getByText(/changed on disk/)).toHaveCount(0);
});

test('a move whose write fails leaves the board drawn, with the card back where it was', async ({
  page,
}) => {
  const { vault, host } = await openBoard(page);
  await expect(cardIn(page, 'Doing', 'one off.md')).toBeVisible();
  const refuse = host.holdWrites('one off.md');
  await dragCardTo(page, 'one off.md', 'Done');
  await expect(cardIn(page, 'Done', 'one off.md')).toBeVisible();
  await expect.poll(() => host.writesTo('one off.md')).toBeGreaterThan(0);

  refuse({ fail: 'The disk is full.' });
  await expect(page.getByText(/The disk is full/)).toBeVisible();

  // Received on fb990142: the view's error replaces the whole board (ViewBody
  // draws TableView's error), so no column is drawn and the card is nowhere.
  await expect(
    page.locator('.board').getByRole('region', { name: 'Doing', exact: true }),
  ).toBeVisible();
  await expect(cardIn(page, 'Doing', 'one off.md')).toBeVisible();
  expect(await vault.read('one off.md')).toContain('status: doing');
});

test('a move that fails does not hide another card moved meanwhile', async ({ page }) => {
  const { host, vault } = await openBoard(page);
  await expect(cardIn(page, 'Doing', 'second card.md')).toBeVisible();
  const refuse = host.holdWrites('one off.md');
  const land = host.holdWrites('second card.md');
  await dragCardTo(page, 'one off.md', 'Done');
  await expect.poll(() => host.writesTo('one off.md')).toBeGreaterThan(0);
  await dragCardTo(page, 'second card.md', 'Backlog');
  await expect.poll(() => host.writesTo('second card.md')).toBeGreaterThan(0);

  refuse({ fail: 'The disk is full.' });
  await expect(page.getByText(/The disk is full/)).toBeVisible();

  // Its own write is still on its way: it is drawn where it was dropped.
  await expect(cardIn(page, 'Backlog', 'second card.md')).toBeVisible();
  land();
  // Landed before the test ends: a write let go and not waited for was still
  // being made as the vault was removed (Linux CI, run 41229221316, ENOTEMPTY).
  await expectFile(vault, 'second card.md').toContain('status: backlog');
});
