import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, type FakeHost, type FakeVault } from './host.ts';

/**
 * The Inbox stays usable however much waits in it (#164-#167): the list keeps
 * its room below a long Proposals section, and every row can be reached.
 */

const TASK_TYPE = [
  '---',
  'name: task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [next, doing, done]',
  '---',
  '',
].join('\n');

const proposal = (n: number) =>
  [
    '---',
    'type: proposal',
    'kind: task',
    'state: open',
    'confidence: high',
    `made_by: after-meeting · run ${n}`,
    'payload:',
    `  title: Follow up with Larkspur Payroll ${n}`,
    '  properties:',
    '    status: next',
    '---',
    '',
    `Mara Quill asked for it on call ${n}.`,
    '',
  ].join('\n');

const captured = (n: number) =>
  ['---', 'type: task', 'status: next', '---', '', `Captured line ${n}.`, ''].join('\n');

async function openInbox(
  page: Page,
  { proposals, waiting }: { proposals: number; waiting: number },
): Promise<{ vault: FakeVault; host: FakeHost }> {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('Inbox/Proposals');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  for (let n = 1; n <= proposals; n += 1) {
    await vault.write(`Inbox/Proposals/Proposal ${n}.md`, proposal(n));
  }
  await Promise.all(
    Array.from({ length: waiting }, (_, n) => vault.write(`Inbox/Item ${n + 1}.md`, captured(n))),
  );
  const host = await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  // Five hundred notes take a while to index under a loaded suite.
  await expect(page.getByText(/notes indexed/)).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /^Inbox/ }).click();
  return { vault, host };
}

// An accepted task goes to the task type's home for today (#214).
const TODAY = new Date().toLocaleDateString('en-CA');
const [YEAR, MONTH] = [TODAY.slice(0, 4), TODAY.slice(5, 7)];
const TASKS = `Tasks/${YEAR}/${MONTH}`;

/** The task the first card would make, by the number its title ends in. */
async function firstCard(page: Page) {
  const card = cards(page).first();
  const label = (await card.getAttribute('aria-label')) ?? '';
  const title = /Follow up with Larkspur Payroll \d+/.exec(label)?.[0] ?? '';
  expect(title).not.toBe('');
  return { card, label, task: `${TASKS}/${title}.md`, title };
}

const inboxPage = (page: Page) => page.getByRole('article', { name: 'Inbox' });

/**
 * Every offer this vault makes is on the Inbox. One read after the page stops
 * holding its rows for them lands above the list, and the list is held still
 * by scrolling (#130): what is placed, and where, moves with it.
 */
async function everyOfferShown(page: Page) {
  const inbox = inboxPage(page);
  await expect(
    inbox.getByRole('complementary', { name: 'Set your types up for the Inbox' }),
  ).toBeVisible();
  for (const offer of ['Move tasks to GTD statuses', 'Process meetings when they arrive']) {
    await expect(inbox.getByRole('region', { name: offer })).toBeVisible();
  }
}
const cards = (page: Page) =>
  page.getByRole('list', { name: 'Open proposals' }).getByRole('region');

/**
 * The cards, once nothing more will be drawn above them. The GTD offer is read
 * after the cards and lands above them, moving every button down; a click begun
 * before it lands can hit the space the button just left.
 */
async function settledCards(page: Page, count: number) {
  await expect(cards(page)).toHaveCount(count);
  await expect(page.getByRole('region', { name: 'Move tasks to GTD statuses' })).toBeVisible();
}

test('the Inbox list keeps its rows whole below a long Proposals section (#164)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openInbox(page, { proposals: 8, waiting: 12 });
  await expect(cards(page)).toHaveCount(8);
  const rows = inboxPage(page).locator('.inbox__grid tbody tr');
  await expect(rows).toHaveCount(12);

  // The list is never squeezed into a box shorter than its rows: the page scrolls instead.
  const sheet = inboxPage(page).locator('.table__sheet');
  await expect
    .poll(() => sheet.evaluate((element) => element.scrollHeight - element.clientHeight))
    .toBeLessThanOrEqual(1);

  // And the last row, scrolled to, shows its controls whole.
  const last = rows.last();
  await last.scrollIntoViewIfNeeded();
  const controls = last.getByRole('combobox').first();
  await expect(controls).toBeInViewport({ ratio: 1 });
});

test('an answered proposal leaves at once, and the next can be answered while it is written (#166)', async ({
  page,
}) => {
  const { vault, host } = await openInbox(page, { proposals: 3, waiting: 0 });
  await settledCards(page, 3);
  const { card, label, task, title } = await firstCard(page);
  const release = host.holdWrites(task);

  await card.getByRole('button', { name: 'Accept' }).click();

  await expect(page.getByRole('region', { name: label, exact: true })).toHaveCount(0);
  await expect(cards(page)).toHaveCount(2);
  await expect(cards(page).first().getByRole('button', { name: 'Accept' })).toBeEnabled();
  expect(await vault.exists(task)).toBe(false);

  release();
  await expect(page.getByRole('status').filter({ hasText: `Accepted: ${title}.` })).toBeVisible();
  await expectFile(vault, task).toContain('type: task');
});

test('a proposal whose write fails comes back, saying why (#166)', async ({ page }) => {
  const { vault, host } = await openInbox(page, { proposals: 2, waiting: 0 });
  await settledCards(page, 2);
  const { card, label, task } = await firstCard(page);
  host.failNext('create_note', 'The disk is full.');

  await card.getByRole('button', { name: 'Accept' }).click();

  const back = page.getByRole('region', { name: label, exact: true });
  await expect(back).toBeVisible();
  await expect(back.getByText(/The disk is full/)).toBeVisible();
  await expect(cards(page)).toHaveCount(2);
  expect(await vault.exists(task)).toBe(false);
});

test('every note waiting can be reached past the first 500, and the page says how many wait (#167)', async ({
  page,
}) => {
  await openInbox(page, { proposals: 0, waiting: 505 });
  const inbox = inboxPage(page);
  // The table says how many rows it holds; only those near the screen are in the page (#238).
  const table = inbox.locator('table.inbox__grid');
  await expect(table).toHaveAttribute('aria-rowcount', '501', { timeout: 15_000 });
  await expect(page.getByText(/^505 to process/)).toBeVisible();
  await expect(inbox.getByText('Showing the newest 500 of 505.')).toBeVisible();
  // Not before the offers have landed above the list, moving "Show more" down.
  await everyOfferShown(page);

  await inbox.getByRole('button', { name: 'Show more' }).click();

  await expect(table).toHaveAttribute('aria-rowcount', '506');
  await expect(inbox.getByRole('button', { name: 'Show more' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Inbox/ })).toContainText('505');
  // The last of them is there once the page is scrolled to it.
  await scrollToEnd(page);
  await expect(table.locator('tr[aria-rowindex="506"]')).toBeVisible();
});

test('Tab walks on past the rows on screen, each row put in the page and in view as it comes (#238)', async ({
  page,
}) => {
  await openInbox(page, { proposals: 0, waiting: 300 });
  const table = inboxPage(page).locator('table.inbox__grid');
  await expect(table).toHaveAttribute('aria-rowcount', '301', { timeout: 15_000 });
  // The rows placed are read once: an offer landing after that scrolls the list, and places others.
  await everyOfferShown(page);
  const placed = table.locator('tbody tr.table__row');
  expect(await placed.count()).toBeLessThan(100);
  // The last of the rows placed from the top down, before the list's gap; its own last row is kept too.
  const indexes = (await placed.evaluateAll((rows) =>
    rows.map((row) => Number(row.getAttribute('aria-rowindex'))),
  )) as number[];
  const lastPlaced = indexes.findIndex((index, at) => index !== at + 2) + 1;
  expect(lastPlaced).toBeGreaterThan(2);

  await table.locator(`tr[aria-rowindex="${lastPlaced}"]`).getByRole('combobox').first().focus();
  const focusedRow = () =>
    page.evaluate(() =>
      Number(document.activeElement?.closest('tr')?.getAttribute('aria-rowindex')),
    );
  // Several rows past the last one that was in the page, a key at a time.
  const target = lastPlaced + 3;
  for (let presses = 0; presses < 120 && (await focusedRow()) < target; presses += 1) {
    await page.keyboard.press('Tab');
  }

  expect(await focusedRow()).toBe(target);
  await expect(page.locator(':focus')).toBeInViewport();
});

for (const grown of [1_500, 3_000]) {
  test(`content above the list growing ${grown}px with no scroll leaves no gap on screen (#247)`, async ({
    page,
  }) => {
    await openInbox(page, { proposals: 0, waiting: 300 });
    const table = inboxPage(page).locator('table.inbox__grid');
    await expect(table).toHaveAttribute('aria-rowcount', '301', { timeout: 15_000 });
    const scroller = page.locator('.panel__body--rows');
    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight / 2;
    });
    await expect.poll(() => gapOnScreen(page)).toBe(0);

    // What sits above the list grows, as offers or proposals landing would: no scroll follows.
    await page.evaluate((height) => {
      const head = document.querySelector<HTMLElement>('article[aria-label="Inbox"] > *');
      if (head !== null) head.style.paddingTop = `${height}px`;
    }, grown);

    await expect.poll(() => gapOnScreen(page)).toBe(0);
  });
}

/** How many pixels of the Inbox's spacer rows are in the page's view. */
function gapOnScreen(page: Page): Promise<number> {
  return page.evaluate(async () => {
    // Two frames, so what the page does about a change has been drawn.
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const scroller = document.querySelector('.panel__body--rows');
    if (scroller === null) return Number.NaN;
    const view = scroller.getBoundingClientRect();
    let shown = 0;
    for (const gap of document.querySelectorAll('.inbox__grid tr.table__spacer')) {
      const box = gap.getBoundingClientRect();
      shown += Math.max(0, Math.min(box.bottom, view.bottom) - Math.max(box.top, view.top));
    }
    return Math.round(shown);
  });
}

/** Scrolls the page the Inbox is in to its end. */
async function scrollToEnd(page: Page) {
  await page.locator('.panel__body--rows').evaluate((scroller) => {
    scroller.scrollTop = scroller.scrollHeight;
  });
}
