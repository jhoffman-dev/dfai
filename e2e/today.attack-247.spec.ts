import { expect, test, type Locator, type Page } from './fixtures.ts';
import { createVault, installHost } from './host.ts';
import { sweep } from './tab-sweep.ts';

/**
 * Adversarial pass on #247 (Performance B, #238), in WebKit: Today places only
 * the groups and rows near what the page shows. Every control must still be
 * reached by Tab and Shift+Tab, in view as it is reached, and never lost to
 * `<body>`; a tick at the bottom of the screen must hand the focus to the
 * next row, in view; and the rows placed must cover what the page shows.
 */

const NOW = new Date(2026, 9, 13, 12, 0, 0);
const PROJECTS = 300;
const UNFILED = 200;

const TASK_TYPE = [
  '---',
  'name: task',
  'label: Task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [inbox, backlog, next-action, in-progress, waiting, someday, longterm, archive]',
  '    done: archive',
  '  contexts:',
  '    kind: multi-select',
  '  due: date',
  '  defer: date',
  '---',
  '',
].join('\n');

const PROJECT_TYPE = [
  '---',
  'name: project',
  'label: Project',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [planned, active, paused, done]',
  '    done: done',
  '---',
  '',
].join('\n');

const pad = (n: number) => String(n).padStart(3, '0');

/** Every seventh task has a title long enough to wrap, and some carry many contexts. */
function taskTitle(n: number): string {
  if (n % 7 !== 0) return `Task ${pad(n)}`;
  return `Task ${pad(n)} reconcile the Larkspur Payroll quarterly ledger with the Fennwick depot`;
}

function taskNote(extra: string[], n: number): string {
  const contexts =
    n % 5 === 0 ? ['contexts: ["@desk", "@calls", "@errands", "@home", "@town"]'] : [];
  return [
    '---',
    'type: task',
    'status: next-action',
    ...contexts,
    ...extra,
    '---',
    '',
    'A task.',
    '',
  ].join('\n');
}

async function openToday(page: Page): Promise<Locator> {
  const vault = await createVault();
  for (const folder of ['.atlas/types', 'Tasks', 'Projects']) await vault.mkdir(folder);
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write('.atlas/types/project.md', PROJECT_TYPE);
  const writes: Promise<void>[] = [];
  for (let n = 1; n <= PROJECTS; n += 1) {
    writes.push(
      vault.write(`Projects/Project ${pad(n)}.md`, '---\ntype: project\nstatus: active\n---\n'),
    );
    writes.push(
      vault.write(`Tasks/${taskTitle(n)}.md`, taskNote([`project: "[[Project ${pad(n)}]]"`], n)),
    );
  }
  for (let n = PROJECTS + 1; n <= PROJECTS + UNFILED; n += 1) {
    writes.push(vault.write(`Tasks/${taskTitle(n)}.md`, taskNote([], n)));
  }
  await Promise.all(writes);
  await installHost(page, vault);
  await page.clock.setFixedTime(NOW);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible({ timeout: 60_000 });
  await page.getByRole('list', { name: 'Go to' }).getByRole('button', { name: 'Today' }).click();
  const today = page.getByRole('article', { name: 'Today' });
  await expect(today.getByRole('region', { name: 'Next actions', exact: true })).toBeVisible();
  await expect(
    today
      .getByRole('region', { name: 'Next actions', exact: true })
      .locator('.review__count')
      .first(),
  ).toContainText(String(PROJECTS + UNFILED), { timeout: 30_000 });
  return today;
}

interface Focused {
  readonly lost: boolean;
  readonly inPage: boolean;
  readonly row: string | null;
  readonly label: string;
  readonly inView: boolean;
}

/** Where the focus is: on the page or lost, which row, and whether it is in view. */
function focusedNow(page: Page): Promise<Focused> {
  return page.evaluate(async () => {
    // Read once the page has settled from the key: two frames, so a scroll
    // the focus asked for has been made.
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const at = document.activeElement;
    const article = document.querySelector('article[aria-label="Today"]');
    const scroller = document.querySelector('.panel__body');
    if (at === null || at === document.body || article === null || scroller === null) {
      return { lost: true, inPage: false, row: null, label: '', inView: false };
    }
    const box = at.getBoundingClientRect();
    const port = scroller.getBoundingClientRect();
    const inView =
      box.height > 0 &&
      box.top >= Math.max(port.top, 0) - 1 &&
      box.bottom <= Math.min(port.bottom, window.innerHeight) + 1;
    return {
      lost: false,
      inPage: article.contains(at),
      row: at.closest('[data-today-row]')?.getAttribute('data-today-row') ?? null,
      label: at.getAttribute('aria-label') ?? at.textContent?.trim().slice(0, 60) ?? '',
      inView,
    };
  });
}

test.describe.configure({ timeout: 600_000 });

test('Tab reaches every one of 500 rows across 300 groups, each in view, focus never lost', async ({
  page,
}) => {
  const today = await openToday(page);
  await today.locator('input.done-check').first().focus();

  const forward = await sweep(page, 'Tab', 6_000);

  expect(forward.offScreen).toEqual([]);
  expect(forward.rows.size).toBe(PROJECTS + UNFILED);
});

test('Shift+Tab from the last row reaches every one of 500 rows back to the first, each in view', async ({
  page,
}) => {
  const today = await openToday(page);
  // To the end of the page, then focus the last row's tick.
  const scroller = page.locator('.panel__body');
  for (let tries = 0; tries < 20; tries += 1) {
    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await page.waitForTimeout(50);
  }
  const lastTick = today.locator('input.done-check').last();
  await lastTick.focus();
  const start = await focusedNow(page);

  const back = await sweep(page, 'Shift+Tab', 6_000);
  if (start.row !== null) back.rows.add(start.row);

  expect(back.lostAfter).toBeNull();
  expect(back.offScreen).toEqual([]);
  expect(back.rows.size).toBe(PROJECTS + UNFILED);
});

test('a tick on the last row on screen focuses the next row, scrolled into view', async ({
  page,
}) => {
  const today = await openToday(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  const scroller = page.locator('.panel__body');
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight * 0.85;
  });
  await page.waitForTimeout(200);
  // The last tick wholly on screen whose row has a next row below it.
  const target = await today.evaluate((article) => {
    const port = document.querySelector('.panel__body')!.getBoundingClientRect();
    const ticks = [...article.querySelectorAll<HTMLInputElement>('input.done-check')];
    const shown = ticks.filter((box) => {
      const at = box.getBoundingClientRect();
      return at.top >= port.top && at.bottom <= port.bottom;
    });
    const last = shown.at(-1);
    return last?.getAttribute('aria-label') ?? null;
  });
  expect(target).not.toBeNull();
  const order = await today
    .locator('input.done-check')
    .evaluateAll((boxes) => boxes.map((box) => box.getAttribute('aria-label')));
  const expectedNext = order[order.indexOf(target) + 1];
  expect(expectedNext).toBeDefined();

  await today.getByRole('checkbox', { name: target!, exact: true }).click();

  await expect(today.getByRole('checkbox', { name: target!, exact: true })).toHaveCount(0, {
    timeout: 15_000,
  });
  await expect(page.locator(':focus')).toHaveAttribute('aria-label', expectedNext!, {
    timeout: 15_000,
  });
  await expect(page.locator(':focus')).toBeInViewport({ ratio: 1 });
});

test('the groups placed cover what the page shows, at the middle of the list in a narrow window', async ({
  page,
}) => {
  const today = await openToday(page);
  await page.setViewportSize({ width: 560, height: 800 });
  const scroller = page.locator('.panel__body');
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight / 2;
  });
  await page.waitForTimeout(300);

  const blank = await today.evaluate((article) => {
    const port = document.querySelector('.panel__body')!.getBoundingClientRect();
    // Any room left for unplaced groups or rows that shows on screen.
    const spacers = [
      ...article.querySelectorAll<HTMLElement>(
        '.today__groups > div[aria-hidden="true"], tr.table__spacer',
      ),
    ];
    return spacers
      .map((spacer) => spacer.getBoundingClientRect())
      .map((box) => Math.min(box.bottom, port.bottom) - Math.max(box.top, port.top))
      .filter((shown) => shown > 1);
  });

  expect(blank).toEqual([]);
});

test('the room between two groups is the same 12px gap main draws, for groups placed together', async ({
  page,
}) => {
  const today = await openToday(page);
  const gaps = await today.evaluate((article) => {
    const groups = [...article.querySelectorAll<HTMLElement>('.today__group')].slice(0, 8);
    const out: number[] = [];
    for (let at = 1; at < groups.length; at += 1) {
      const above = groups[at - 1]!.querySelector('.table')!.getBoundingClientRect();
      const name = groups[at]!.querySelector('.today__group-name')!.getBoundingClientRect();
      out.push(Math.round(name.top - above.bottom));
    }
    return out;
  });

  expect(gaps.length).toBeGreaterThan(3);
  expect(new Set(gaps)).toEqual(new Set([12]));
});

test('a spacer row stands for exactly the height it is given', async ({ page }) => {
  const today = await openToday(page);
  const scroller = page.locator('.panel__body');
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight - element.clientHeight * 2;
  });
  await page.waitForTimeout(300);

  const spacers = await today.evaluate((article) =>
    [...article.querySelectorAll<HTMLElement>('tr.table__spacer')].map((row) => ({
      given: Number.parseFloat(row.querySelector('td')!.style.height),
      drawn: row.getBoundingClientRect().height,
    })),
  );

  expect(spacers.length).toBeGreaterThan(0);
  for (const { given, drawn } of spacers) expect(drawn).toBeCloseTo(given, 0);
});

test('a Move to… menu open on a row outlasts the page scrolled far from it and back; Escape returns focus', async ({
  page,
}) => {
  const today = await openToday(page);
  const trigger = today.getByRole('button', { name: /^Move Task 002/ });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu', { name: /^Move Task 002/ });
  await expect(menu.getByRole('menuitem').first()).toBeFocused();

  // A wheel does not reach the page under the open menu, so the page is moved
  // as a re-read or a scroll from elsewhere would move it.
  const scroller = page.locator('.panel__body');
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.waitForTimeout(300);
  await scroller.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.waitForTimeout(300);
  await expect(menu.getByRole('menuitem').first()).toBeFocused();

  await page.keyboard.press('Escape');

  await expect(menu).toHaveCount(0);
  await expect(today.getByRole('button', { name: /^Move Task 002/ })).toBeFocused();
});
