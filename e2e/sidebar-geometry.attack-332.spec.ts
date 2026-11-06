import { expect, test, type Locator, type Page } from './fixtures.ts';
import { createVault, installHost, sidebarSection, type FakeHost, type FakeVault } from './host.ts';

// Attack on #332 (UI v2 slice 3a, #294): the sidebar's new geometry — 28px
// rows at a 29px pitch in the virtualised Pages tree, 26px sticky headings
// with a matching scroll-padding-top, and a scroller that reaches both
// sidebar edges with every row's last control 10px in from the row's end.

const AREAS = 10;
const EACH = 25;
const DEEP = 5;
const PITCH = 29;
const ROW = 28;
/** Every row once all is open: each area, its Deep, their notes, then `.atlas` and Loose at the root. */
const ALL_ROWS = AREAS * (1 + 1 + EACH + DEEP) + 2;
const pad = (at: number) => String(at).padStart(2, '0');

async function openVault(
  page: Page,
  extra?: (vault: FakeVault) => Promise<void>,
  hosted?: (host: FakeHost) => void,
) {
  const vault = await createVault();
  for (const folder of ['.atlas/types', '.atlas/views', '.atlas/dashboards']) {
    await vault.mkdir(folder);
  }
  for (let at = 1; at <= 4; at += 1) {
    await vault.write(
      `.atlas/types/kind${pad(at)}.md`,
      ['---', `name: kind${pad(at)}`, `label: Kind ${pad(at)}`, 'properties: {}', '---', ''].join(
        '\n',
      ),
    );
    await vault.write(
      `.atlas/views/View ${pad(at)}.md`,
      ['---', 'atlas: view', `type: kind${pad(at)}`, 'layout: table', '---', ''].join('\n'),
    );
    await vault.write(
      `.atlas/dashboards/Board ${pad(at)}.md`,
      ['---', 'atlas: dashboard', 'widgets: []', '---', '', `# Board ${pad(at)}`, ''].join('\n'),
    );
  }
  for (let area = 1; area <= AREAS; area += 1) {
    await vault.mkdir(`Area ${pad(area)}`);
    await vault.mkdir(`Area ${pad(area)}/Deep`);
    for (let at = 1; at <= EACH; at += 1) {
      await vault.write(
        `Area ${pad(area)}/Note ${pad(area)}-${pad(at)}.md`,
        `# Note ${pad(area)}-${pad(at)}\n`,
      );
    }
    for (let at = 1; at <= DEEP; at += 1) {
      await vault.write(
        `Area ${pad(area)}/Deep/Deep ${pad(area)}-${pad(at)}.md`,
        `# Deep ${pad(area)}-${pad(at)}\n`,
      );
    }
  }
  await vault.write('Loose.md', '# Loose\n');
  await extra?.(vault);
  const host = await installHost(page, vault);
  hosted?.(host);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return vault;
}

const nav = (page: Page) => page.getByRole('navigation', { name: 'Vault' });
const scroller = (page: Page) => nav(page).locator('.sidebar__scroll');
const pages = (page: Page) => sidebarSection(page, 'userSpace');
const treeRow = (page: Page, name: string) =>
  pages(page).getByRole('treeitem', { name, exact: true });

/**
 * Opens every Area folder and its Deep folder from the keyboard, last first,
 * so the folders still to open stay near the top and rendered. Each toggle
 * is left to settle — the rows placed again at their pitch — before the
 * next key, which would otherwise land on rows the virtualiser is still
 * moving.
 */
async function expandAll(
  page: Page,
  {
    awaitingListing,
  }: {
    /** Told each Deep folder's path as this starts to wait for its notes to be listed. */
    awaitingListing?: (folder: string) => void;
  } = {},
) {
  for (let area = AREAS; area >= 1; area -= 1) {
    const folder = treeRow(page, `Area ${pad(area)}`);
    await folder.focus();
    await page.keyboard.press('ArrowRight');
    await expect(folder).toHaveAttribute('aria-expanded', 'true');
    // A folder is marked open before it is listed: until its contents are in,
    // the row after it is whatever follows the folder, where a down arrow
    // would land. Its first child is its Deep folder.
    const at = Number(await folder.getAttribute('data-row'));
    await expect(pages(page).locator(`[data-row="${at + 1}"]`)).toHaveAccessibleName('Deep');
    await expectPlaced(page, `after opening Area ${area}`);
    await page.keyboard.press('ArrowDown');
    const deep = pages(page).locator('[role="treeitem"]:focus');
    await expect(deep).toHaveAccessibleName('Deep');
    await page.keyboard.press('ArrowRight');
    await expect(deep).toHaveAttribute('aria-expanded', 'true');
    // Deep too is marked open before it is listed; until its notes are in, the
    // tree is short by them (#782).
    const deepAt = Number(await deep.getAttribute('data-row'));
    awaitingListing?.(`Area ${pad(area)}/Deep`);
    await expect(pages(page).locator(`[data-row="${deepAt + 1}"]`)).toHaveAccessibleName(
      `Deep ${pad(area)}-01`,
    );
    await expectPlaced(page, `after opening Area ${area}'s Deep`);
  }
}

/** Every rendered tree row: its index, its top relative to the first, and its height. */
const placed = (page: Page) =>
  pages(page)
    .locator('[data-row]')
    .evaluateAll((rows) =>
      rows
        .map((row) => {
          const box = row.getBoundingClientRect();
          return { at: Number(row.getAttribute('data-row')), top: box.top, height: box.height };
        })
        .sort((a, b) => a.at - b.at),
    );

/**
 * Rows whose pitch to the previous one, or own height, is not the design's —
 * or too few rows to judge, which is also wrong.
 */
async function misplaced(page: Page) {
  const rows = await placed(page);
  if (rows.length <= 5) return [`only ${rows.length} rows rendered`];
  const wrong: string[] = [];
  for (let at = 0; at < rows.length; at += 1) {
    const row = rows[at]!;
    if (row.height !== ROW) wrong.push(`row ${row.at} is ${row.height}px tall`);
    const first = rows[0]!;
    const expected = first.top + (row.at - first.at) * PITCH;
    if (Math.abs(row.top - expected) > 0.01) {
      wrong.push(`row ${row.at} at ${row.top - first.top}px, not ${expected - first.top}px`);
    }
  }
  return wrong;
}

/**
 * Every rendered row at its exact pitch and height, once the virtualiser has
 * placed them again: a toggle flips aria-expanded before the rows move, and
 * a read in between sees rows 0px tall or still at their old tops.
 */
async function expectPlaced(page: Page, when: string) {
  await expect.poll(() => misplaced(page), { message: when }).toEqual([]);
}

async function scrollTo(page: Page, top: number) {
  await scroller(page).evaluate(async (area, to) => {
    area.scrollTop = to;
    await new Promise((drawn) => requestAnimationFrame(() => requestAnimationFrame(drawn)));
  }, top);
}

/** Scrolls the sidebar down from the top until the virtualiser renders `row`. */
async function reveal(page: Page, row: Locator) {
  for (let top = 0; top < 20_000; top += 300) {
    await scrollTo(page, top);
    if ((await row.count()) > 0) return;
  }
  throw new Error('the row was never rendered');
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 800 });
});

test('tree rows sit at an exact 29px pitch deep in a long nested list', async ({ page }) => {
  await openVault(page);
  await expandAll(page);
  const height = await scroller(page).evaluate((area) => area.scrollHeight);
  expect(height, 'the tree is hundreds of rows tall').toBeGreaterThan(300 * PITCH);
  for (const fraction of [0.25, 0.5, 0.9, 1]) {
    await scrollTo(page, height * fraction);
    expect(await misplaced(page), `at ${fraction} of the way down`).toEqual([]);
  }
});

/** The tree is as tall as `rows` rows at the pitch, give or take a subpixel. */
async function expectTreeHeight(page: Page, rows: number) {
  const height = await pages(page)
    .getByRole('tree')
    .evaluate((tree) => tree.getBoundingClientRect().height);
  expect(height).toBeGreaterThanOrEqual(rows * PITCH - 1);
  expect(height).toBeLessThanOrEqual(rows * PITCH);
}

test('the tree is exactly as tall as its rows at a 29px pitch', async ({ page }) => {
  await openVault(page);
  await expandAll(page);
  const count = await pages(page).getByRole('tree').getAttribute('aria-rowcount');
  const rows = count === null ? Number.NaN : Number(count);
  // If aria-rowcount is not exposed, count what the model holds instead.
  await expectTreeHeight(page, Number.isNaN(rows) ? ALL_ROWS : rows);
});

test('the tree is as tall as its rows when the last folder opened is slow to list (#782)', async ({
  page,
}) => {
  // The last folder expandAll opens, held unlisted until expandAll says it is
  // waiting for its notes. Marked open before they arrive, a tree measured
  // without that wait is short by them, every time.
  let release = () => {};
  await openVault(page, undefined, (host) => {
    release = host.holdListing('Area 01/Deep');
  });
  await expandAll(page, {
    awaitingListing: (folder) => {
      if (folder === 'Area 01/Deep') release();
    },
  });
  await expectTreeHeight(page, ALL_ROWS);
});

test('rows keep their 29px pitch after folders are collapsed and expanded again', async ({
  page,
}) => {
  await openVault(page);
  await expandAll(page);
  await scrollTo(page, 100_000);
  for (const area of [9, 3, 7]) {
    const folder = treeRow(page, `Area ${pad(area)}`);
    await reveal(page, folder);
    await folder.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(folder).toHaveAttribute('aria-expanded', 'false');
    await expectPlaced(page, `after shutting Area ${area}`);
    await page.keyboard.press('ArrowRight');
    await expect(folder).toHaveAttribute('aria-expanded', 'true');
    await expectPlaced(page, `after reopening Area ${area}`);
  }
  await scrollTo(page, 0);
  await scrollTo(page, 100_000);
  await expectPlaced(page, 'at the end after the churn');
});

const LONG =
  'An extraordinarily long page name that goes on well past the sidebar edge and then some more';

test('a long page name keeps its row one line tall and ellipsises', async ({ page }) => {
  await openVault(page, (vault) => vault.write(`${LONG}.md`, `# ${LONG}\n`));
  const row = treeRow(page, LONG);
  await row.scrollIntoViewIfNeeded();
  const box = await row.evaluate((element) => {
    const name = element.querySelector('.tree__name');
    return {
      height: element.getBoundingClientRect().height,
      clipped: name !== null && name.scrollWidth > name.clientWidth,
      overflows: element.scrollWidth > element.clientWidth,
    };
  });
  expect(box).toEqual({ height: ROW, clipped: true, overflows: false });
  expect(await misplaced(page)).toEqual([]);
});

test('renaming a row to a long name keeps the pitch below it', async ({ page }) => {
  await openVault(page);
  const row = treeRow(page, 'Loose');
  await row.scrollIntoViewIfNeeded();
  await row.getByRole('button', { name: 'Options for Loose', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Rename/ }).click();
  const field = pages(page).getByRole('textbox');
  await expect(field).toBeFocused();
  await field.fill(LONG);
  const editing = await field.evaluate((input) => {
    const host = input.closest('[data-row]');
    return {
      row: host?.getBoundingClientRect().height ?? Number.NaN,
      fieldBottom: input.getBoundingClientRect().bottom,
      rowBottom: host?.getBoundingClientRect().bottom ?? Number.NaN,
    };
  });
  expect(editing.row, 'the row being renamed').toBe(ROW);
  expect(editing.fieldBottom, 'the field stays inside its row').toBeLessThanOrEqual(
    editing.rowBottom,
  );
  await page.keyboard.press('Enter');
  await expect(treeRow(page, LONG)).toBeVisible();
  expect(await misplaced(page)).toEqual([]);
});

test('walking up the tree never leaves the focused row under the sticky Pages heading', async ({
  page,
}) => {
  await openVault(page);
  await expandAll(page);
  const heading = nav(page).locator('#sidebar-userSpace-heading');
  const first = pages(page).locator('[data-row="0"]');
  await first.focus();
  await page.keyboard.press('End');
  const focused = pages(page).locator('[role="treeitem"]:focus');
  // The last row is rendered, then focused: wait for the focus to land.
  await expect(focused).not.toHaveAttribute('data-row', '0');
  let at = Number(await focused.getAttribute('data-row'));
  expect(at, 'End reached a row far down').toBeGreaterThan(200);
  const hidden: string[] = [];
  let stuckSteps = 0;
  for (let step = 0; step < 60; step += 1) {
    await page.keyboard.press('ArrowUp');
    at -= 1;
    await expect(focused).toHaveAttribute('data-row', String(at));
    const where = await focused.evaluate((row) => {
      const head = document.querySelector('#sidebar-userSpace-heading');
      const area = row.closest('.sidebar__scroll');
      const box = row.getBoundingClientRect();
      const stuck = head?.closest('.sidebar__head')?.getBoundingClientRect();
      return {
        row: row.getAttribute('data-row'),
        top: box.top,
        below: stuck === undefined ? Number.NaN : stuck.bottom,
        stuck:
          stuck !== undefined &&
          Math.abs(stuck.top - (area?.getBoundingClientRect().top ?? 0)) < 0.5,
        areaBottom: area?.getBoundingClientRect().bottom ?? Number.NaN,
        bottom: box.bottom,
      };
    });
    if (where.stuck) stuckSteps += 1;
    if (where.top < where.below - 0.5) {
      hidden.push(`row ${where.row}: top ${where.top} under the heading's foot ${where.below}`);
    }
    if (where.bottom > where.areaBottom + 0.5) hidden.push(`row ${where.row} below the scroller`);
  }
  await expect(heading).toBeVisible();
  expect(stuckSteps, 'steps on which the Pages heading was stuck').toBeGreaterThan(30);
  expect(hidden).toEqual([]);
});

test('a stuck section heading is drawn over the rows passing under it', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 560 });
  await openVault(page);
  await expandAll(page);
  const overlapped: string[] = [];
  for (const section of ['types', 'views', 'dashboards', 'userSpace'] as const) {
    const head = nav(page).locator(`#sidebar-${section}-heading`);
    if ((await head.count()) === 0) continue;
    // Scroll so the section's first row is a few pixels above the scroller's
    // top: its heading is stuck there with the row under it.
    const into = await sidebarSection(page, section).evaluate((body) => {
      const area = body.closest('.sidebar__scroll')!;
      return body.getBoundingClientRect().top - area.getBoundingClientRect().top + area.scrollTop;
    });
    await scrollTo(page, Math.max(0, into + 10));
    const hits = await head.evaluate((label) => {
      const bar = label.closest('.sidebar__head')!;
      const box = bar.getBoundingClientRect();
      const area = bar.closest('.sidebar__scroll')!.getBoundingClientRect();
      // Only a heading that is stuck to the scroller's top, and only left of
      // where the overlay scrollbar may be drawn.
      if (Math.abs(box.top - area.top) > 0.5) return [`not stuck: ${box.top - area.top}px down`];
      const foreign: string[] = [];
      for (let x = box.left + 2; x < Math.min(box.right, area.right - 17) - 2; x += 6) {
        for (const y of [box.top + 2, box.top + box.height / 2, box.bottom - 2]) {
          const under = document.elementFromPoint(x, y);
          if (under !== null && !bar.contains(under)) {
            foreign.push(
              `${Math.round(x - box.left)},${Math.round(y - box.top)} ${under.className}`,
            );
          }
        }
      }
      return foreign;
    });
    if (hits.length > 0) overlapped.push(`${section}: ${hits.slice(0, 3).join('; ')}`);
  }
  expect(overlapped).toEqual([]);
});

test('Alt+arrows move a section from its grip while the sidebar is scrolled, keeping focus in view', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1180, height: 560 });
  await openVault(page);
  await expandAll(page);
  await scrollTo(page, 100_000);
  const grip = nav(page).getByRole('button', { name: 'Move Dashboards' });
  await grip.focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(grip).toBeFocused();
  await expect(grip).toBeInViewport();
  await page.keyboard.press('Alt+ArrowUp');
  await page.keyboard.press('Alt+ArrowUp');
  await expect(grip).toBeFocused();
  await expect(grip).toBeInViewport();
});

/**
 * Every trailing control in the scroller's rendered rows, and how close its
 * right edge comes to the scroller's right edge.
 */
const trailing = (page: Page) =>
  scroller(page).evaluate((area) => {
    const edge = area.getBoundingClientRect().right;
    const selector = [
      '.sidebar__count',
      '.sidebar__badge',
      '.sidebar__heading-action',
      '.tree__more',
      '.star',
      '[aria-label^="Options for"]',
      '.sortable__handle',
    ].join(', ');
    return [...area.querySelectorAll(selector)]
      .map((element) => {
        const box = element.getBoundingClientRect();
        return {
          what: `${element.className} ${element.getAttribute('aria-label') ?? element.textContent}`,
          gap: edge - box.right,
          width: box.width,
        };
      })
      .filter((one) => one.width > 0);
  });

test('every row’s trailing control stays clear of the 17px overlay scrollbar', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 560 });
  await openVault(page);
  await expandAll(page);
  const tooClose: string[] = [];
  for (const top of [0, 400, 2000, 100_000]) {
    await scrollTo(page, top);
    for (const one of await trailing(page)) {
      if (one.gap < 17) tooClose.push(`${one.what}: ${one.gap}px from the edge`);
    }
  }
  expect(tooClose).toEqual([]);
});

test('the sidebar never scrolls sideways', async ({ page }) => {
  await openVault(page, (vault) => vault.write(`${LONG}.md`, `# ${LONG}\n`));
  await expandAll(page);
  const sideways = await nav(page).evaluate((root) =>
    [root, ...root.querySelectorAll('*')]
      .filter((element) => element.scrollWidth > element.clientWidth + 0.5)
      .filter((element) => {
        const style = getComputedStyle(element);
        // An ellipsised label is clipped on purpose; anything that can scroll is not.
        return /(auto|scroll)/.test(style.overflowX) || element === root;
      })
      .map((element) => `${element.className}: ${element.scrollWidth} > ${element.clientWidth}`),
  );
  expect(sideways).toEqual([]);
});

/** How far the focus ring (box-shadow spread) of `row` is cut off by its scroller. */
async function ringClip(row: Locator) {
  return row.evaluate((element) => {
    const area = element.closest('.sidebar__scroll')!;
    const shadow = getComputedStyle(element).boxShadow;
    const inset = /inset/.test(shadow);
    const spreads = [...shadow.matchAll(/(-?\d+(?:\.\d+)?)px(?=\s*(?:,|$|inset))/g)].map((m) =>
      Number(m[1]),
    );
    const spread = inset ? 0 : Math.max(0, ...spreads);
    const box = element.getBoundingClientRect();
    const clip = area.getBoundingClientRect();
    return {
      spread,
      left: Math.max(0, clip.left - (box.left - spread)),
      right: Math.max(0, box.right + spread - (clip.left + area.clientWidth)),
    };
  });
}

test('a focused sidebar row’s ring is not clipped at either side of the scroller', async ({
  page,
}) => {
  await openVault(page);
  const rows = [
    sidebarSection(page, 'types').getByRole('button', { name: /^Kind 01/ }),
    sidebarSection(page, 'views').getByRole('button', { name: /^View 01/ }),
    sidebarSection(page, 'dashboards').getByRole('button', { name: /^Board 01/ }),
    nav(page).getByRole('button', { name: 'Types', exact: true }),
  ];
  await page.keyboard.press('Tab');
  for (const row of rows) {
    await row.focus();
    const clip = await ringClip(row);
    expect(clip.spread, 'the ring is drawn outside the row').toBeGreaterThan(0);
    expect({ left: clip.left, right: clip.right }).toEqual({ left: 0, right: 0 });
  }
});

test('a Pages row’s icon lines up with the other sections’ row icons', async ({ page }) => {
  await openVault(page);
  const icon = (row: Locator) =>
    row
      .locator('svg')
      .first()
      .evaluate((svg) => svg.getBoundingClientRect().left);
  const typeIcon = await icon(
    sidebarSection(page, 'types').getByRole('button', { name: /^Kind 01/ }),
  );
  const quickIcon = await icon(nav(page).getByRole('button', { name: /^Search/ }));
  const pageIcon = await icon(treeRow(page, 'Area 01'));
  expect(typeIcon, 'a type row against Search').toBe(quickIcon);
  expect(pageIcon, 'a top-level page row against a type row').toBe(typeIcon);
});

// The star on a view or dashboard row is the row's last control, and it ends
// at the row's edge rather than 10px in: the pixels a press on it lands on
// must all be its own while the overlay scrollbar shows (#52, #322).
test('a view row’s star is clear of the sidebar’s scrollbar while it shows', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 560 });
  await openVault(page);
  const row = sidebarSection(page, 'views').locator('.sidebar__item').first();
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  const star = row.getByRole('button', { name: /favorites$/ });
  await expect(star).toHaveCount(1);
  const missed = await star.evaluate(async (button) => {
    const area = button.closest('.sidebar__scroll')!;
    area.scrollTop += 1;
    await new Promise((drawn) => requestAnimationFrame(drawn));
    const box = button.getBoundingClientRect();
    const across: number[] = [];
    for (let x = Math.ceil(box.left); x < box.right; x += 1) {
      const under = document.elementFromPoint(x, box.top + box.height / 2);
      if (!button.contains(under)) across.push(Math.round(x - box.left));
    }
    return { width: box.width, gap: area.getBoundingClientRect().right - box.right, across };
  });
  expect(missed.width, 'the star has a width to click').toBeGreaterThan(0);
  expect(missed.across, 'pixels across the star where a press lands elsewhere').toEqual([]);
  expect(missed.gap, 'px from the star to the scroller’s edge').toBeGreaterThanOrEqual(17);
});
