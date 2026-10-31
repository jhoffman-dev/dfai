import { expect, test, type Locator, type Page } from './fixtures.ts';
import { dragAnnouncement } from './drag.ts';
import { createVault, installHost, sidebarSection, type FakeVault } from './host.ts';

// Issue #17: in a short window every section squeezed into a scrollbar of its
// own. The sections now share one scroller between the fixed quick rows and
// the fixed footer, each at its natural height, and Pages' virtualised tree
// scrolls in it too.

const EACH = 6;
const NOTES = 60;
const pad = (at: number) => String(at).padStart(2, '0');

const typeFile = (at: number) =>
  ['---', `name: kind${pad(at)}`, `label: Kind ${pad(at)}`, 'properties: {}', '---', ''].join('\n');
const viewFile = (at: number) =>
  ['---', 'atlas: view', `type: kind${pad(at)}`, 'layout: table', '---', ''].join('\n');
const dashboardFile = (at: number) =>
  ['---', 'atlas: dashboard', 'widgets: []', '---', ''].join('\n') + `# Board ${pad(at)}\n`;
const noteFile = (at: number) =>
  at <= EACH ? `---\nfavorite: true\n---\n\n# Note ${pad(at)}\n` : `# Note ${pad(at)}\n`;

async function openVault(page: Page): Promise<FakeVault> {
  const vault = await createVault();
  for (const folder of ['.atlas/types', '.atlas/views', '.atlas/dashboards', 'Projects']) {
    await vault.mkdir(folder);
  }
  for (let at = 1; at <= EACH; at += 1) {
    await vault.write(`.atlas/types/kind${pad(at)}.md`, typeFile(at));
    await vault.write(`.atlas/views/View ${pad(at)}.md`, viewFile(at));
    await vault.write(`.atlas/dashboards/Board ${pad(at)}.md`, dashboardFile(at));
  }
  for (let at = 1; at <= NOTES; at += 1) await vault.write(`Note ${pad(at)}.md`, noteFile(at));
  await vault.write('Zebra.md', '# Zebra\n');

  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await expect(
    sidebarSection(page, 'favorites').getByRole('button', { name: 'Note 06', exact: true }),
  ).toHaveCount(1);
  return vault;
}

const nav = (page: Page) => page.getByRole('navigation', { name: 'Vault' });
const scroller = (page: Page) => nav(page).locator('.sidebar__scroll');
const treeRow = (page: Page, name: string) =>
  sidebarSection(page, 'userSpace').getByRole('treeitem', { name, exact: true });

/** Every element in the sidebar that is allowed to scroll, and how far each can. */
const scrollers = (page: Page) =>
  nav(page).evaluate((root) =>
    [root, ...root.querySelectorAll('*')]
      .filter((element) => /(auto|scroll)/.test(getComputedStyle(element).overflowY))
      .map((element) => ({
        className: element.className,
        overflows: element.scrollHeight > element.clientHeight + 1,
      })),
  );

/** Wheels the sidebar until `target` is on screen. */
async function wheelTo(page: Page, target: Locator, deltaY: number) {
  const box = await scroller(page).boundingBox();
  if (box === null) throw new Error('the sidebar scroller is not on screen');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(async () => {
    await page.mouse.wheel(0, deltaY);
    await expect(target).toBeInViewport({ timeout: 100 });
  }).toPass({ timeout: 10_000 });
  await scrolledStill(page);
}

/**
 * The sidebar has stopped scrolling: the same scrollTop over three frames.
 * WebKit on Linux animates a wheel's scroll, so the rows go on moving after
 * the last wheel event, and a row measured then is not the one under the
 * pointer a moment later (a drag picked up the row below it, run 41205345639).
 */
async function scrolledStill(page: Page) {
  await expect
    .poll(() =>
      scroller(page).evaluate(async (element) => {
        const seen: number[] = [];
        for (let frame = 0; frame < 3; frame += 1) {
          seen.push(element.scrollTop);
          await new Promise((done) => requestAnimationFrame(done));
        }
        return seen.every((top) => top === seen[0]);
      }),
    )
    .toBe(true);
}

const top = async (locator: Locator) => (await locator.boundingBox())?.y ?? Number.NaN;

for (const size of [
  { width: 1180, height: 800 },
  { width: 720, height: 480 },
]) {
  test(`one scroller holds every section at ${size.width}×${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    await openVault(page);

    // Exactly one element below the quick rows scrolls, and it has to here.
    const all = await scrollers(page);
    expect(all).toEqual([{ className: 'sidebar__scroll', overflows: true }]);

    // Every expanded section stands at its natural height: no body is
    // clipped, and each of its rows is as tall as a row is.
    for (const section of ['favorites', 'types', 'views', 'dashboards'] as const) {
      const body = sidebarSection(page, section);
      const rows = body.locator('.sidebar__item');
      await expect(rows).toHaveCount(EACH);
      const clipped = await body.evaluate((element) => element.scrollHeight - element.clientHeight);
      expect(clipped, `${section} is clipped`).toBe(0);
      const heights = await rows.evaluateAll((items) =>
        items.map((item) => item.getBoundingClientRect().height),
      );
      expect(heights, `${section}'s rows`).toEqual(Array.from({ length: EACH }, () => 28));
    }

    // The quick rows and the footer stay put while the sections scroll.
    const search = nav(page).getByRole('button', { name: /^Search/ });
    const settings = nav(page).getByRole('button', { name: /Settings/ });
    const before = { search: await top(search), settings: await top(settings) };

    // The tree's last note is reached by scrolling the one scroller, and opens.
    await wheelTo(page, treeRow(page, `Note ${NOTES}`), 400);
    expect(await top(search)).toBe(before.search);
    expect(await top(settings)).toBe(before.settings);
    await expect(search).toBeInViewport();
    await expect(settings).toBeInViewport();
    await treeRow(page, `Note ${NOTES}`).click();
    await expect(page.locator('.page-head__title')).toHaveText(`Note ${NOTES}`);
  });
}

// WebKit's own scrollbar is drawn over the edge of what it scrolls, for as
// long as it shows (after a scroll, then a move of the pointer), and takes
// every press there. A row's "…" sat in those pixels: "Options for <name>" was
// pressed on the scrollbar instead whenever the sidebar had just scrolled, and
// its menu did not open (#52; folders.spec.ts:260, navigation.spec.ts:94).
test('a row’s Options button is clear of the sidebar’s scrollbar while it shows', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1180, height: 800 });
  await openVault(page);
  const row = treeRow(page, 'Note 30');
  await wheelTo(page, row, 400);
  await expect(row).toBeInViewport({ ratio: 1 });
  const options = row.getByRole('button', { name: 'Options for Note 30', exact: true });

  // Every pixel across the button, with the scrollbar just drawn, is the button's.
  const missed = await options.evaluate(async (button) => {
    // A scroll is what shows the scrollbar; the next frame has drawn it.
    const area = button.closest('.sidebar__scroll');
    if (area === null) throw new Error('the row is not in the sidebar scroller');
    area.scrollTop -= 1;
    await new Promise((drawn) => requestAnimationFrame(drawn));
    const box = button.getBoundingClientRect();
    const across: number[] = [];
    for (let x = Math.ceil(box.left); x < box.right; x += 1) {
      const under = document.elementFromPoint(x, box.top + box.height / 2);
      if (!button.contains(under)) across.push(Math.round(x - box.left));
    }
    return { width: box.width, across };
  });
  expect(missed.width, 'the button has a width to click').toBeGreaterThan(0);
  expect(missed.across, 'pixels across the button where a press lands elsewhere').toEqual([]);

  // And a real press: scroll, move onto the "…" (which shows the scrollbar),
  // press and release. The menu opens.
  await page.mouse.wheel(0, -1);
  await expect(row).toBeInViewport({ ratio: 1 });
  const box = await options.boundingBox();
  if (box === null) throw new Error('the Options button is not on screen');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.getByRole('menuitem', { name: /^Rename/ })).toBeVisible();
});

// A list row's star sits beside the row's button rather than inside it, so it
// is the row's last control and the one nearest the scrollbar's pixels.
test('a favourite’s star is clear of the sidebar’s scrollbar while it shows', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 800 });
  await openVault(page);
  const row = sidebarSection(page, 'favorites').locator('.sidebar__item', { hasText: 'Note 03' });
  await row.hover();
  const star = row.getByRole('button', { name: 'Remove Note 03 from favorites', exact: true });
  await expect(star).toBeVisible();
  // A wheel is what first shows the scrollbar; a scroll from script alone
  // leaves it undrawn, and the pixels under it are then the star's own.
  await wheelTo(page, row, 1);
  await row.hover();

  // Every pixel across the star, with the scrollbar just drawn, is the star's.
  const missed = await star.evaluate(async (button) => {
    const area = button.closest('.sidebar__scroll');
    if (area === null) throw new Error('the row is not in the sidebar scroller');
    area.scrollTop += 1;
    await new Promise((drawn) => requestAnimationFrame(drawn));
    const box = button.getBoundingClientRect();
    const across: number[] = [];
    for (let x = Math.ceil(box.left); x < box.right; x += 1) {
      const under = document.elementFromPoint(x, box.top + box.height / 2);
      if (!button.contains(under)) across.push(Math.round(x - box.left));
    }
    return { width: box.width, across };
  });
  expect(missed.width, 'the star has a width to click').toBeGreaterThan(0);
  expect(missed.across, 'pixels across the star where a press lands elsewhere').toEqual([]);

  // And a real press: move onto the star (which shows the scrollbar), press
  // and release. The note leaves the favourites.
  await page.mouse.wheel(0, -1);
  const box = await star.boundingBox();
  if (box === null) throw new Error('the star is not on screen');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
  await page.mouse.down();
  await page.mouse.up();
  await expect(
    sidebarSection(page, 'favorites').getByRole('button', { name: 'Note 03', exact: true }),
  ).toHaveCount(0);
});

test('the keyboard brings a tree row into view through the shared scroller', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 800 });
  await openVault(page);
  const pages = sidebarSection(page, 'userSpace');
  const focused = pages.locator('[role="treeitem"]:focus');
  const heading = nav(page).locator('#sidebar-userSpace-heading');

  // Pages sits below four full sections, so its last row starts far out of view.
  const first = pages.locator('[data-row="0"]');
  await first.focus();
  await page.keyboard.press('End');
  await expect(focused).toHaveCount(1);
  await expect(focused).toBeInViewport();
  const lastRow = Number(await focused.getAttribute('data-row'));
  expect(lastRow).toBeGreaterThan(NOTES - 1);

  // Home goes back up, to a first row that is wholly on screen.
  await page.keyboard.press('Home');
  await expect(first).toBeFocused();
  await expect(first).toBeInViewport({ ratio: 1 });

  // A type-ahead jump to a row the virtualiser had not rendered lands on it.
  // (A space would pick the row up, so the name has none.)
  await page.keyboard.type('zeb');
  await expect(treeRow(page, 'Zebra')).toBeFocused();
  await expect(treeRow(page, 'Zebra')).toBeInViewport({ ratio: 1 });

  // Walking back up, the row the arrows reach is never left under the Pages
  // heading, which sticks to the top of the scroller while its rows pass.
  for (let step = 0; step < 20; step += 1) await page.keyboard.press('ArrowUp');
  await expect(treeRow(page, 'Note 41')).toBeFocused();
  const stuck = await heading.boundingBox();
  const area = await scroller(page).boundingBox();
  expect(stuck?.y, 'the Pages heading sticks to the top').toBe(area?.y);
  await expect
    .poll(async () => (await top(focused)) - ((stuck?.y ?? 0) + (stuck?.height ?? 0)))
    .toBeGreaterThanOrEqual(0);
});

test('a note dragged to the edge scrolls the sidebar and drops into a folder', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 800 });
  const vault = await openVault(page);

  const held = treeRow(page, `Note ${NOTES}`);
  await wheelTo(page, held, 400);
  await page.evaluate(() => {
    const said: string[] = [];
    Object.assign(window, { dragSaid: said });
    new MutationObserver(() => {
      const now = [...document.querySelectorAll('[id^="DndLiveRegion"]')]
        .map((region) => region.textContent ?? '')
        .join('');
      if (now !== '' && said.at(-1) !== now) said.push(now);
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  const box = await held.boundingBox();
  const area = await scroller(page).boundingBox();
  if (box === null || area === null) throw new Error('nothing to drag');
  const scrolled = await scroller(page).evaluate((element) => element.scrollTop);
  expect(scrolled).toBeGreaterThan(0);

  // Held at the scroller's top edge, the sidebar scrolls up under the pointer.
  await page.mouse.move(box.x + 40, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 48, box.y + box.height / 2 + 8, { steps: 4 });
  // The row pressed is the one measured.
  await expect(dragAnnouncement(page)).toContainText(`Picked up Note ${NOTES}.`);
  await page.mouse.move(area.x + 60, area.y + 6, { steps: 20 });
  await expect
    .poll(() => scroller(page).evaluate((element) => element.scrollTop), { timeout: 10_000 })
    .toBe(0);

  // Projects, the tree's first row, now lies below the scroller's bottom edge:
  // held near that edge, the sidebar scrolls back down until it shows. Only a
  // row the scroller shows is a drop target — aimed at where it is laid out
  // but hidden, the pointer is over nothing (and may be off the page).
  // It is dropped on only once it is clear of the scroll zones at either edge
  // (dnd-kit's: a fifth of the scroller), or the sidebar would go on
  // scrolling it out from under the pointer before the button is let go.
  const folder = treeRow(page, 'Projects');
  const zone = area.height / 5;
  const shownTop = area.y + zone;
  const shownBottom = area.y + area.height - zone;
  await expect(async () => {
    const aim = await folder.boundingBox();
    const above = aim === null || aim.y < shownTop;
    const below = aim !== null && aim.y + aim.height > shownBottom;
    if (above || below) {
      // Inside the edge's scroll zone, but not at its edge, so the scroll is slow.
      const edge = below ? area.y + area.height - 60 : area.y + 60;
      await page.mouse.move(area.x + 60, edge, { steps: 2 });
      throw new Error(`Projects is not shown yet (${aim === null ? 'unrendered' : aim.y})`);
    }
    await page.mouse.move(aim.x + aim.width / 2, aim.y + aim.height / 2, { steps: 2 });
    await expect(dragAnnouncement(page)).toContainText('is over Projects.', { timeout: 250 });
  }).toPass({ intervals: [50], timeout: 15_000 });
  await page.mouse.up();

  // Says what the drag said, and where things were, should this miss.
  try {
    await expect.poll(() => vault.exists(`Projects/Note ${NOTES}.md`)).toBe(true);
  } catch (cause) {
    const seen = await page.evaluate(() => ({
      said: (window as unknown as { dragSaid?: string[] }).dragSaid ?? [],
      scrollTop: document.querySelector('.sidebar__scroll')?.scrollTop,
    }));
    throw new Error(
      [
        String(cause),
        `said: ${seen.said.join(' | ')}`,
        `scrollTop: ${seen.scrollTop}; Projects: ${JSON.stringify(await folder.boundingBox())}`,
      ].join('\n'),
      { cause },
    );
  }
});

test('a carried row is drawn over the work panel, not under it', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 800 });
  await openVault(page);
  const held = treeRow(page, 'Note 30');
  await wheelTo(page, held, 400);
  // Picked up from the middle of the sidebar, clear of the scroll zones at its
  // edges: where the wheel leaves the row is the engine's (on Linux, in the
  // bottom zone), and a drag begun there scrolls the sidebar under it.
  await held.evaluate((row) => row.scrollIntoView({ block: 'center' }));
  await scrolledStill(page);
  const box = await held.boundingBox();
  const sidebar = await nav(page).boundingBox();
  if (box === null || sidebar === null) throw new Error('nothing to drag');

  await page.mouse.move(box.x + 40, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 48, box.y + box.height / 2 + 8, { steps: 4 });
  await expect(dragAnnouncement(page)).toContainText('Picked up Note 30.');
  // Past the sidebar's edge, over the work panel.
  const past = { x: sidebar.x + sidebar.width + 40, y: box.y + box.height / 2 };
  await page.mouse.move(past.x, past.y, { steps: 10 });
  const lifted = page.locator('.tree__row--lifted');
  await expect(lifted).toBeVisible();

  // What the pointer is on is the picture of the row it carries.
  // Says what is there instead, should this miss.
  await expect
    .poll(() =>
      page.evaluate(({ x, y }) => {
        const at = document.elementFromPoint(x, y);
        if (at?.closest('.tree__row--lifted') !== null && at !== null) return 'the lifted row';
        const lifted = document.querySelector('.tree__row--lifted')?.getBoundingClientRect();
        return `${at?.tagName}.${at?.className} at ${x},${y}; lifted ${JSON.stringify(lifted)}`;
      }, past),
    )
    .toBe('the lifted row');
  await page.keyboard.press('Escape');
  await page.mouse.up();
});

test('shutting the sections above Pages leaves a tree row under every point of it', async ({
  page,
}) => {
  // Tall, so that more rows show than the virtualiser keeps either side:
  // counted from a stale start, the rows near the bottom would be missing.
  await page.setViewportSize({ width: 1180, height: 1400 });
  await openVault(page);
  for (const name of ['Favorites', 'Types', 'Views', 'Dashboards']) {
    await nav(page).getByRole('button', { name, exact: true }).click();
    await expect(nav(page).getByRole('button', { name, exact: true })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  }

  // From just under the Pages heading to the bottom of the scroller, a row a
  // pitch (29px) at a time: each point is on a row, and on the row after the
  // one above it.
  const heading = await nav(page).locator('#sidebar-userSpace-heading').boundingBox();
  const area = await scroller(page).boundingBox();
  if (heading === null || area === null) throw new Error('Pages is not on screen');
  const under = (y: number) =>
    page.evaluate(
      ({ x, y }) =>
        Number(
          document.elementFromPoint(x, y)?.closest('[role="treeitem"]')?.getAttribute('data-row') ??
            -1,
        ),
      { x: area.x + 60, y },
    );
  const rows: number[] = [];
  for (let y = heading.y + heading.height + 15; y < area.y + area.height - 4; y += 29) {
    rows.push(await under(y));
  }
  expect(rows.length).toBeGreaterThan(5);
  expect(rows).toEqual(rows.map((_, at) => (rows[0] ?? 0) + at));
  expect(rows[0]).toBe(0);
});
