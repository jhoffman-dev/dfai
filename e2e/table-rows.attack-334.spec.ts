/**
 * Attack on #334 (UI v2 slice 4, #296): the virtualised table at its new
 * heights — 34px rows, 32px group rows, 30px "+ New", overscan 8 — across
 * 2,000 grouped rows in WebKit. Fast scrolling, jumps the scrollbar makes,
 * where each line sits deep in the list, folding, and the keyboard under the
 * 32px sticky header.
 */
import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost, sidebarSection } from './host.ts';
import { focusOn } from './typing.ts';

const STATUSES = ['backlog', 'doing', 'done'] as const;
const TASKS = 2000;
const HEIGHT = { group: 32, row: 34, new: 30 } as const;

const TASK_TYPE = [
  '---',
  'name: task',
  'properties:',
  '  status:',
  '    kind: select',
  `    options: [${STATUSES.join(', ')}]`,
  '  due: date',
  '---',
  '',
].join('\n');

const title = (at: number) => `Chore ${String(at).padStart(4, '0')}`;
const statusOf = (at: number) => STATUSES[Math.min(2, Math.floor(((at - 1) * 3) / TASKS))]!;
const inGroup = (status: string) =>
  Array.from({ length: TASKS }, (_, at) => statusOf(at + 1)).filter((s) => s === status).length;

async function openTable(page: Page, { groupBy }: { groupBy: boolean }) {
  await page.setViewportSize({ width: 1440, height: 900 });
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/views');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write(
    '.atlas/views/Chores.md',
    [
      '---',
      'atlas: view',
      'type: task',
      'layout: table',
      ...(groupBy ? ['groupBy: status'] : []),
      'columns: [status, due]',
      `limit: ${TASKS * 2}`,
      '---',
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
  await sidebarSection(page, 'views').getByRole('button', { name: 'Chores', exact: true }).click();
  await expect(page.locator('.table__row').first()).toBeVisible();
}

const sheet = (page: Page) => page.locator('.table__sheet');

/** Two frames: what the reader sees once a scroll has been drawn. */
const frames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );

/**
 * Points down the sheet's window, below the sticky header, that hit no drawn
 * line: a spacer, the bare sheet or the table itself is a blank band.
 */
function blankPoints(page: Page): Promise<number[]> {
  return page.locator('.table__sheet').evaluate((element) => {
    const box = element.getBoundingClientRect();
    const head = element.querySelector('thead th')!.getBoundingClientRect();
    const blank: number[] = [];
    const x = box.left + 40;
    for (let y = head.bottom + 2; y < box.bottom - 2; y += 9) {
      const hit = document.elementFromPoint(x, y);
      const line = hit?.closest('tr');
      if (!line || line.classList.contains('table__spacer') || line.closest('thead')) {
        blank.push(Math.round(y - box.top));
      }
    }
    return blank;
  });
}

/**
 * Each drawn line's top against where the estimates put it: the sum of the
 * heights of every line before it, worked out from the groups as they stand.
 */
function placementErrors(page: Page, kinds: readonly (keyof typeof HEIGHT)[]) {
  return page.locator('.table__sheet tbody').evaluate(
    (body, { kinds, heights }) => {
      const origin = body.getBoundingClientRect().top;
      const errors: string[] = [];
      for (const spacer of body.querySelectorAll<HTMLElement>('tr.table__spacer')) {
        const declared = parseFloat(spacer.querySelector('td')!.style.height);
        const drawn = spacer.getBoundingClientRect().height;
        if (Math.abs(declared - drawn) > 1)
          errors.push(`spacer: declared ${declared}, drawn ${drawn}`);
      }
      for (const line of body.querySelectorAll<HTMLElement>('tr[data-index]')) {
        const index = Number(line.dataset['index']);
        let expected = 0;
        for (let at = 0; at < index; at += 1) expected += heights[kinds[at]!]!;
        const top = line.getBoundingClientRect().top - origin;
        if (Math.abs(top - expected) > 1)
          errors.push(`line ${index}: at ${top}, estimated ${expected}`);
      }
      return errors;
    },
    { kinds: [...kinds], heights: HEIGHT as Record<string, number> },
  );
}

/** The lines the grouped table lays out: a header, its rows unless folded, then "+ New". */
function lineKinds({ folded = [] as string[], withNew }: { folded?: string[]; withNew: boolean }) {
  const kinds: (keyof typeof HEIGHT)[] = [];
  for (const status of STATUSES) {
    kinds.push('group');
    if (folded.includes(status)) continue;
    for (let at = 0; at < inGroup(status); at += 1) kinds.push('row');
    if (withNew) kinds.push('new');
  }
  return kinds;
}

/** Whether the app gives each group a "+ New" line: looked for at the list's end, where the last one is drawn. */
async function hasNewLines(page: Page): Promise<boolean> {
  await sheet(page).evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await frames(page);
  const found = (await page.locator('tr.table__group-new').count()) > 0;
  await sheet(page).evaluate((element) => {
    element.scrollTop = 0;
  });
  await frames(page);
  return found;
}

test.describe('2,000 grouped rows', () => {
  test.setTimeout(180_000);

  test('a burst of fast wheel turns leaves no blank band in the window', async ({ page }) => {
    await openTable(page, { groupBy: true });
    const where = await sheet(page).boundingBox();
    await page.mouse.move(where!.x + 200, where!.y + 300);
    const seen: string[] = [];
    for (let turn = 0; turn < 12; turn += 1) {
      for (let tick = 0; tick < 6; tick += 1) await page.mouse.wheel(0, 2400);
      await frames(page);
      const blank = await blankPoints(page);
      if (blank.length > 0) seen.push(`turn ${turn}: blank at ${blank.join(',')}`);
    }
    expect(seen).toEqual([]);
  });

  test('scrollbar jumps — far down, to the end, back near the top — leave no blank band', async ({
    page,
  }) => {
    await openTable(page, { groupBy: true });
    const seen: string[] = [];
    for (const fraction of [0.5, 0.93, 1, 0.07, 0.61, 0.33, 0]) {
      await sheet(page).evaluate((element, at) => {
        element.scrollTop = (element.scrollHeight - element.clientHeight) * at;
      }, fraction);
      await frames(page);
      const blank = await blankPoints(page);
      if (blank.length > 0) seen.push(`${fraction}: blank at ${blank.join(',')}`);
    }
    expect(seen).toEqual([]);
  });

  test('deep in the list every drawn line sits where the estimates place it', async ({ page }) => {
    await openTable(page, { groupBy: true });
    const withNew = await hasNewLines(page);
    const kinds = lineKinds({ withNew });
    // Proven to match: the window holds lines.
    await expect
      .poll(() => page.locator('.table__sheet tbody tr[data-index]').count())
      .toBeGreaterThan(10);
    for (const fraction of [0.5, 0.9, 1]) {
      await sheet(page).evaluate((element, at) => {
        element.scrollTop = (element.scrollHeight - element.clientHeight) * at;
      }, fraction);
      await frames(page);
      expect(await placementErrors(page, kinds), `at ${fraction}`).toEqual([]);
    }
  });

  test('folding the first group and unfolding it keeps every line where it belongs', async ({
    page,
  }) => {
    await openTable(page, { groupBy: true });
    const withNew = await hasNewLines(page);
    await page.locator('.table__group-toggle', { hasText: /^Backlog/ }).click();
    await frames(page);
    const folded = lineKinds({ folded: ['backlog'], withNew });
    expect(await placementErrors(page, folded)).toEqual([]);
    await sheet(page).evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await frames(page);
    expect(await placementErrors(page, folded)).toEqual([]);
    await sheet(page).evaluate((element) => {
      element.scrollTop = 0;
    });
    await frames(page);
    await page.locator('.table__group-toggle', { hasText: /^Backlog/ }).click();
    await frames(page);
    await sheet(page).evaluate((element) => {
      element.scrollTop = (element.scrollHeight - element.clientHeight) * 0.8;
    });
    await frames(page);
    expect(await placementErrors(page, lineKinds({ withNew }))).toEqual([]);
  });

  test('the scroll height is the estimates’ sum: nothing grows the list as it is measured', async ({
    page,
  }) => {
    await openTable(page, { groupBy: true });
    const withNew = await hasNewLines(page);
    const sum = lineKinds({ withNew }).reduce((total, kind) => total + HEIGHT[kind], 0);
    for (const fraction of [0.25, 0.75, 1]) {
      await sheet(page).evaluate((element, at) => {
        element.scrollTop = (element.scrollHeight - element.clientHeight) * at;
      }, fraction);
      await frames(page);
    }
    const body = await page
      .locator('.table__sheet tbody')
      .evaluate((element) => element.getBoundingClientRect().height);
    expect(Math.abs(body - sum)).toBeLessThanOrEqual(2);
  });
});

/** Whether the focused element is a table stop wholly in the sheet's window, below the sticky header. */
function focusPlacement(page: Page) {
  return page.evaluate(() => {
    const focused = document.activeElement as HTMLElement | null;
    const sheetEl = document.querySelector('.table__sheet')!;
    const line = focused?.closest('tr');
    if (!focused || !line || !sheetEl.contains(line)) {
      return { inTable: false, clear: false, text: focused?.tagName ?? 'none' };
    }
    const box = sheetEl.getBoundingClientRect();
    const head = sheetEl.querySelector('thead th')!.getBoundingClientRect();
    const row = line.getBoundingClientRect();
    // Wholly in the window, and its last cell under nothing at the window's foot.
    const cell = line.lastElementChild!.getBoundingClientRect();
    const hit = document.elementFromPoint(cell.right - 20, (cell.top + cell.bottom) / 2);
    const uncovered = hit !== null && line.contains(hit);
    const clear = row.top >= head.bottom - 0.5 && row.bottom <= box.bottom + 0.5 && uncovered;
    return { inTable: true, clear, text: focused.textContent ?? '' };
  });
}

for (const groupBy of [false, true]) {
  test.describe(groupBy ? 'keyboard, grouped' : 'keyboard, flat', () => {
    test.setTimeout(180_000);

    test('Up, Down, Home and End keep the focused row whole and clear of the sticky header', async ({
      page,
    }) => {
      await openTable(page, { groupBy });
      await page.locator('.table__link').first().focus();
      const problems: string[] = [];
      const press = async (key: string, times = 1) => {
        for (let at = 0; at < times; at += 1) await page.keyboard.press(key);
        await expect.poll(async () => (await focusPlacement(page)).inTable).toBe(true);
        await frames(page);
        const placed = await focusPlacement(page);
        if (!placed.clear) problems.push(`${key}×${times}: "${placed.text}" not wholly in view`);
      };
      await press('ArrowDown', 40);
      await press('End');
      await press('ArrowUp', 30);
      await press('Home');
      await press('ArrowDown', 3);
      await press('ArrowUp');
      expect(problems).toEqual([]);
    });

    test('PageDown and PageUp keep the focus on a row the reader can see', async ({ page }) => {
      await openTable(page, { groupBy });
      await focusOn(page.locator('.table__link').first());
      const problems: string[] = [];
      for (const key of ['PageDown', 'PageDown', 'PageDown', 'PageUp']) {
        await page.keyboard.press(key);
        await frames(page);
        const placed = await focusPlacement(page);
        if (!placed.inTable) problems.push(`${key}: focus left the table, on ${placed.text}`);
        else if (!placed.clear) problems.push(`${key}: "${placed.text}" scrolled out of view`);
      }
      expect(problems).toEqual([]);
    });
  });
}
