import { expect, test, type Page } from './fixtures.ts';
import { sep } from 'node:path';
import {
  createVault,
  emitVaultChanged,
  installHost,
  type FakeHost,
  type FakeVault,
} from './host.ts';
import { toastSaying } from './toasts.ts';

/**
 * Second attack on #130 (PR #283), in WebKit: the Inbox's manual scroll
 * anchor (`useListAnchor`). Content above the list comes and goes — here the
 * "settings note can't be read" warning, toggled by rewriting the settings
 * note, and a proposals section — while the person scrolls, tabs, resizes
 * and uses "New above". The invariants under attack: a row on screen never
 * moves unless the person moved it, "New above" means something new is
 * above and takes them to it, and the room given below is never left over.
 */

const BROKEN_SETTINGS = ['---', 'name: [Mara Quill', 'quickAdd: [task', '---', ''].join('\n');
const GOOD_SETTINGS = ['---', 'name: Mara Quill', '---', ''].join('\n');
const PROPOSAL = [
  '---',
  'type: proposal',
  'kind: task',
  'state: open',
  'confidence: high',
  'made_by: after-meeting · run 1',
  'payload:',
  '  title: Send Tobias the file',
  '---',
  '',
  'Mara Quill asked for it.',
  '',
].join('\n');

const inbox = (page: Page) => page.getByRole('article', { name: 'Inbox' });
const warning = (page: Page) => inbox(page).locator('.inbox__offer--warning');
const newAbove = (page: Page) => page.getByRole('button', { name: /New above/ });
const tidy = (page: Page) => page.getByRole('region', { name: 'Tidy the vault' });
const gtd = (page: Page) => page.getByRole('region', { name: 'Move tasks to GTD statuses' });
const typesOffer = (page: Page) =>
  page.getByRole('complementary', { name: 'Set your types up for the Inbox' });

/** A task outside the Inbox and the tidy's folders, whose read lets the move to GTD's offer be held. */
const LATE_TASK = 'Projects/Ship it.md';

/**
 * Opens a vault with `rows` Inbox notes (past "Show more" when many), plus a
 * loose note for the tidy, and waits for every offer this vault has before
 * scrolling: one read after the Inbox's short hold lands above the rows, and
 * landing once "Show more" has taken the list to its end it is rightly "New
 * above" (#378). With `lateTasks`, the move to GTD's read of the vault's one
 * task is held until the Inbox shows, so its offer always lands late, as it
 * does on a loaded machine.
 */
async function openInbox(
  page: Page,
  rows: number,
  { lateTasks = false }: { readonly lateTasks?: boolean } = {},
): Promise<FakeVault> {
  const vault = await createVault();
  await vault.mkdir('Inbox');
  await Promise.all(
    Array.from({ length: rows }, (_, n) =>
      vault.write(`Inbox/Item ${String(n + 1).padStart(3, '0')}.md`, `Captured line ${n + 1}.\n`),
    ),
  );
  await vault.write('Loose idea.md', 'A thought.\n');
  await vault.mkdir('.atlas');
  await vault.write('.atlas/settings.md', GOOD_SETTINGS);
  if (lateTasks) {
    await vault.mkdir('Projects');
    await vault.write(
      LATE_TASK,
      ['---', 'type: task', 'status: todo', '---', '', 'Ship it.', ''].join('\n'),
    );
  }
  const host = await installHost(page, vault);
  const releaseTasks = lateTasks ? host.holdReads(LATE_TASK, { alone: true }) : () => {};
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: /^Inbox/ }).click();
  await expect(inbox(page).locator('.inbox__grid tbody button').first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(tidy(page)).toBeVisible({ timeout: 30_000 });
  if (lateTasks) {
    // Held, it is not there yet: the Inbox stopped waiting for it.
    await expect(gtd(page)).toHaveCount(0);
    releaseTasks();
  }
  await expect(typesOffer(page)).toBeVisible();
  await expect(gtd(page)).toBeVisible({ timeout: 30_000 });
  if (rows > 500) await inbox(page).getByRole('button', { name: 'Show more' }).click();
  await settle(page);
  return vault;
}

/** Makes the settings warning arrive (`broken`) or go, as an edit on disk would. */
async function settings(page: Page, vault: FakeVault, broken: boolean): Promise<void> {
  await vault.write('.atlas/settings.md', broken ? BROKEN_SETTINGS : GOOD_SETTINGS);
  await emitVaultChanged(page, ['.atlas/settings.md']);
}

function settle(page: Page, frames = 10): Promise<void> {
  return page.evaluate(async (frames) => {
    for (let n = 0; n < frames; n++) await new Promise((done) => requestAnimationFrame(done));
  }, frames);
}

function scrollTo(page: Page, top: number): Promise<void> {
  return page.evaluate(async (top) => {
    document.querySelector('.panel__body--rows')!.scrollTop = top;
    for (let n = 0; n < 5; n++) await new Promise((done) => requestAnimationFrame(done));
  }, top);
}

const scrollTop = (page: Page) =>
  page.evaluate(() => document.querySelector('.panel__body--rows')!.scrollTop);

/** The Inbox row title at the middle of the scroller, and where it is on screen. */
/** Where the Inbox row titled `title` is on screen, or null when it is not drawn. */
function rowTop(page: Page, title: string): Promise<number | null> {
  return page.evaluate((title) => {
    const button = [...document.querySelectorAll('.inbox__grid tbody button')].find(
      (each) => each.textContent?.trim() === title,
    );
    return button?.closest('tr')?.getBoundingClientRect().top ?? null;
  }, title);
}

function rowAtMiddle(page: Page): Promise<{ title: string; top: number }> {
  return page.evaluate(() => {
    const area = document.querySelector('.panel__body--rows')!.getBoundingClientRect();
    const x = area.left + area.width / 3;
    const y = area.top + area.height / 2;
    const rowEl = document.elementFromPoint(x, y)?.closest('tr');
    const button = rowEl?.querySelector('button');
    return {
      title: button?.textContent?.trim() ?? '',
      top: rowEl?.getBoundingClientRect().top ?? Number.NaN,
    };
  });
}

test('"New above", clicked while scrolled deep into the list, brings what arrived into view (#130 attack)', async ({
  page,
}) => {
  const vault = await openInbox(page, 600);
  await scrollTo(page, 3000);
  await settings(page, vault, true);
  await expect(newAbove(page)).toBeVisible();
  await expect(warning(page)).not.toBeInViewport();

  await newAbove(page).click();
  await expect(warning(page)).toBeInViewport();
});

test('"New above" stays until what arrived above is scrolled back into view (#130 attack)', async ({
  page,
}) => {
  const vault = await openInbox(page, 600);
  await scrollTo(page, 3000);
  await settings(page, vault, true);
  await expect(newAbove(page)).toBeVisible();
  const before = await scrollTop(page);
  // Back up past the arrival's height, but nowhere near the top of the page.
  await scrollTo(page, before - 300);
  await expect(warning(page)).not.toBeInViewport();
  await expect(newAbove(page)).toBeVisible();
});

test('resizing the window, at the top of the Inbox, says nothing is "New above" and keeps the top in view (#130 attack)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openInbox(page, 4);
  expect(await scrollTop(page)).toBe(0);
  await page.mouse.move(5, 5);
  // Narrower: the offers above the rows wrap and grow; nothing new arrived.
  await page.setViewportSize({ width: 760, height: 720 });
  await settle(page, 20);
  await expect(newAbove(page)).toHaveCount(0);
  // UI slice 3b moved the page's heading into its bar, out of the scroller: the top
  // of the page is now its first block, kept in view by the scroller staying at 0.
  expect(await scrollTop(page)).toBe(0);
  await expect(inbox(page).locator('.inbox__offer').first()).toBeInViewport();
});

test('content arriving and going above at ten moments of a 2 s wheel scroll never moves the rows against the wheel (#130 attack)', async ({
  page,
}) => {
  const vault = await openInbox(page, 600);
  await scrollTo(page, 0);
  const box = (await page.locator('.panel__body--rows').boundingBox())!;
  await page.mouse.move(box.x + box.width / 3, box.y + box.height / 2);
  // Every frame, where the table stands on screen: scrolling down, it only goes up.
  await page.evaluate(() => {
    const record: number[] = [];
    (window as unknown as { __tops: number[] }).__tops = record;
    const table = document.querySelector('table.inbox__grid')!;
    const tick = () => {
      record.push(table.getBoundingClientRect().top);
      if (record.length < 100_000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  for (let step = 0; step < 20; step++) {
    await page.mouse.wheel(0, 80);
    if (step % 2 === 1) await settings(page, vault, step % 4 === 1);
    // Frames, not a time: the wheel's steps are a few frames apart however busy the machine.
    await settle(page, 6);
  }
  await settle(page, 20);
  const tops = await page.evaluate(() => (window as unknown as { __tops: number[] }).__tops);
  const against = tops.slice(1).map((top, at) => top - tops[at]!);
  // Half a pixel of rounding either way; anything more is the rows jumping back.
  expect(Math.max(...against)).toBeLessThanOrEqual(1);
  expect(tops[0]! - tops.at(-1)!).toBeGreaterThan(800);
});

test('after the wheel takes the pointer off an offer onto the rows, a proposal arriving does not move the row under it (#130 attack)', async ({
  page,
}) => {
  const vault = await openInbox(page, 600);
  await scrollTo(page, 0);
  const offer = (await tidy(page).boundingBox())!;
  const pointer = { x: offer.x + offer.width / 3, y: offer.y + offer.height / 2 };
  await page.mouse.move(pointer.x, pointer.y);
  await page.mouse.wheel(0, 600);
  await settle(page, 30);
  const under = await page.evaluate(
    ({ x, y }) =>
      document
        .elementFromPoint(x, y)
        ?.closest('tr')
        ?.querySelector('button')
        ?.textContent?.trim() ?? '',
    pointer,
  );
  expect(under).toMatch(/^Item /);
  const before = await rowTop(page, under);

  await vault.mkdir('Inbox/Proposals');
  await vault.write('Inbox/Proposals/Send Tobias the file.md', PROPOSAL);
  await emitVaultChanged(page, ['Inbox/Proposals/Send Tobias the file.md']);
  await expect(inbox(page).getByText('Send Tobias the file')).toBeAttached();
  await settle(page, 10);
  expect(Math.abs((await rowTop(page, under))! - before!)).toBeLessThanOrEqual(1);
});

/*
 * This WebKit anchors scrolling itself: `overflow-anchor` is supported and
 * computes to `auto` on the Inbox's scroller. When content above shrinks or
 * reflows, its correction and `useListAnchor`'s add up, and the rows move by
 * the whole change, the other way. With `overflow-anchor: none` injected, the
 * two tests below hold to within a pixel.
 */
test('a warning above that goes while the list is scrolled does not move the rows (#130 attack)', async ({
  page,
}) => {
  const vault = await openInbox(page, 600);
  await settings(page, vault, true);
  await expect(warning(page)).toBeVisible();
  await scrollTo(page, 1500);
  await settle(page, 30);
  const { title } = await rowAtMiddle(page);
  const before = await rowTop(page, title);
  await settings(page, vault, false);
  await expect(warning(page)).toHaveCount(0);
  await settle(page, 30);
  expect(Math.abs((await rowTop(page, title))! - before!)).toBeLessThanOrEqual(1);
});

test('a warning above that goes at the top of the page says nothing is "New above" (#130 attack)', async ({
  page,
}) => {
  const vault = await openInbox(page, 600);
  await settings(page, vault, true);
  await expect(warning(page)).toBeVisible();
  await scrollTo(page, 0);
  await settings(page, vault, false);
  await expect(warning(page)).toHaveCount(0);
  await settle(page);
  await expect(newAbove(page)).toHaveCount(0);
});

test('the room given below a short Inbox leaves nothing to scroll into once the person scrolls up and back down (#130 attack)', async ({
  page,
}) => {
  // Tall enough that the page fits, so holding the rows needs room below.
  await page.setViewportSize({ width: 1280, height: 1200 });
  const vault = await openInbox(page, 4);
  const area = (await page.locator('.panel__body--rows').boundingBox())!;
  await page.mouse.move(area.x + area.width / 3, area.y + area.height / 2);
  await settings(page, vault, true);
  await expect(warning(page)).toBeAttached();
  await settle(page);
  const room = () =>
    page.evaluate(
      () =>
        Number.parseFloat(
          document.querySelector<HTMLElement>('.panel__body--rows > [aria-hidden="true"]')!.style
            .height,
        ) || 0,
    );
  // The arrival needed room to be held still: otherwise this test holds nothing.
  expect(await room()).toBeGreaterThan(0);
  await page.mouse.wheel(0, -2000);
  await settle(page, 20);
  await page.mouse.wheel(0, 2000);
  await settle(page, 20);
  // What is left only fills the view below a page shorter than it: nothing to scroll into.
  const overflow = await page.evaluate(() => {
    const scroller = document.querySelector('.panel__body--rows')!;
    const article = scroller.querySelector('article')!.getBoundingClientRect().height;
    return scroller.scrollHeight - Math.max(scroller.clientHeight, Math.ceil(article));
  });
  expect(overflow).toBeLessThanOrEqual(0);
});

test('content arriving above during an Option+Tab and Option+Shift+Tab sweep keeps the focus in view, never lost (#130 attack)', async ({
  page,
}) => {
  const vault = await openInbox(page, 600);
  await scrollTo(page, 2000);
  const middle = await rowAtMiddle(page);
  await inbox(page).getByRole('button', { name: middle.title, exact: true }).focus();
  for (let press = 0; press < 24; press++) {
    // Option: WebKit's Tab alone skips buttons, as Safari does by default.
    await page.keyboard.press(press % 12 < 6 ? 'Alt+Tab' : 'Alt+Shift+Tab');
    if (press % 3 === 2) await settings(page, vault, press % 6 === 2);
    const where = await page.evaluate(async () => {
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      const at = document.activeElement;
      if (at === null || at === document.body) return 'lost';
      const box = at.getBoundingClientRect();
      const area = document.querySelector('.panel__body--rows')!.getBoundingClientRect();
      return box.top >= area.top - 1 && box.bottom <= area.bottom + 1 ? 'in view' : 'off screen';
    });
    expect(where, `focus after press ${press}`).toBe('in view');
  }
});

test('content arriving above in the frame after a fast scroll, as the list is measured, does not move the row in the middle (#130 attack)', async ({
  page,
}) => {
  const vault = await openInbox(page, 600);
  await vault.write('.atlas/settings.md', BROKEN_SETTINGS);
  const moved = await page.evaluate(async () => {
    const frame = () => new Promise((done) => requestAnimationFrame(done));
    const area = document.querySelector('.panel__body--rows')!;
    area.scrollTop = 9000;
    await frame();
    const box = area.getBoundingClientRect();
    const row = document.elementFromPoint(box.left + box.width / 3, box.top + box.height / 2)!;
    const title = row.closest('tr')!.querySelector('button')!.textContent!.trim();
    const top = row.closest('tr')!.getBoundingClientRect().top;
    (window as unknown as { __atlasEmit: (e: string, p: unknown) => void }).__atlasEmit(
      'vault-changed',
      ['.atlas/settings.md'],
    );
    for (let n = 0; n < 60; n++) await frame();
    const again = [...document.querySelectorAll('.inbox__grid tbody button')].find(
      (each) => each.textContent?.trim() === title,
    );
    return (again?.closest('tr')?.getBoundingClientRect().top ?? Number.NaN) - top;
  });
  await expect(warning(page)).toBeAttached();
  expect(Math.abs(moved)).toBeLessThanOrEqual(1);
});

test('"Preview the tidy" opened under the pointer grows downwards, and the rows stay still when the pointer leaves (#130 attack)', async ({
  page,
}) => {
  await openInbox(page, 600);
  await scrollTo(page, 0);
  const offerAt = (await tidy(page).boundingBox())!.y;
  await tidy(page).getByRole('button', { name: 'Preview the tidy' }).click();
  await expect(tidy(page).getByRole('table', { name: 'Notes that move' })).toBeVisible();
  await settle(page);
  await expect
    .poll(async () => Math.abs((await tidy(page).boundingBox())!.y - offerAt))
    .toBeLessThanOrEqual(1);
  const { title } = await rowAtMiddle(page);
  const before = await rowTop(page, title);
  await page.mouse.move(2, 400);
  await settle(page, 20);
  expect(Math.abs((await rowTop(page, title))! - before!)).toBeLessThanOrEqual(1);
});

test('resizing the window while scrolled down the list keeps the row in the middle where it was (#130 attack)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openInbox(page, 600, { lateTasks: true });
  await scrollTo(page, 3000);
  await settle(page, 30);
  const { title } = await rowAtMiddle(page);
  const before = await rowTop(page, title);
  await page.setViewportSize({ width: 760, height: 720 });
  await settle(page, 30);
  expect(Math.abs((await rowTop(page, title))! - before!)).toBeLessThanOrEqual(1);
  // A reflow is held but is not news (added in the last fix round, #130).
  await expect(newAbove(page)).toHaveCount(0);
});

const GTD_TASK_TYPE = [
  '---',
  'name: task',
  'label: Task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [inbox, backlog, next-action, in-progress, waiting, someday, longterm, archive]',
  '    done: archive',
  '---',
  '',
  '# Task',
  '',
].join('\n');

const TASKS = 40;
const taskTitle = (n: number) => `Task ${String(n).padStart(2, '0')}`;

/** A vault of Inbox tasks to clarify, its Inbox open; the window's clock is Playwright's. */
async function openTasks(page: Page): Promise<{ vault: FakeVault; host: FakeHost }> {
  const vault = await createVault();
  for (const folder of ['.atlas/types', 'Inbox', 'Tasks']) await vault.mkdir(folder);
  await vault.write('.atlas/types/task.md', GTD_TASK_TYPE);
  await vault.write('.atlas/settings.md', GOOD_SETTINGS);
  await vault.write('Loose idea.md', 'A thought.\n');
  for (let n = 1; n <= TASKS; n++) {
    await vault.write(
      `Inbox/${taskTitle(n)}.md`,
      ['---', 'type: task', 'status: inbox', '---', '', `Step ${n}.`, ''].join('\n'),
    );
  }
  await page.clock.install();
  const host = await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: /^Inbox/ }).click();
  await expect(inbox(page).locator('.inbox__grid tbody button').first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(tidy(page)).toBeVisible({ timeout: 30_000 });
  await settle(page);
  return { vault, host };
}

/** Clarifies the task titled `title` as a Next Action, with Return on Done. */
async function clarify(page: Page, title: string): Promise<void> {
  await inbox(page)
    .getByRole('combobox', { name: `Status of ${title}` })
    .selectOption({ label: 'Next Action' });
  await inbox(page)
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name: title, exact: true }) })
    .getByRole('button', { name: 'Save', exact: true })
    .press('Enter');
  await expect(toastSaying(page, `Clarified “${title}”.`)).toBeVisible();
}

test('a row clarified as the settings warning arrives above: the list stays where it was (#130 attack)', async ({
  page,
}) => {
  const { vault } = await openTasks(page);
  await scrollTo(page, 600);
  await settle(page, 20);
  // A first clarification is said in a toast, over the page; the second takes its place.
  await clarify(page, (await rowAtMiddle(page)).title);
  await settle(page, 20);
  const { title } = await rowAtMiddle(page);
  const tableAt = () =>
    page.evaluate(() => document.querySelector('table.inbox__grid')!.getBoundingClientRect().top);
  const before = await tableAt();
  await vault.write('.atlas/settings.md', BROKEN_SETTINGS);
  await inbox(page)
    .getByRole('combobox', { name: `Status of ${title}` })
    .selectOption({ label: 'Next Action' });
  await Promise.all([
    inbox(page)
      .getByRole('row')
      .filter({ has: page.getByRole('button', { name: title, exact: true }) })
      .getByRole('button', { name: 'Save', exact: true })
      .press('Enter'),
    emitVaultChanged(page, ['.atlas/settings.md']),
  ]);
  await expect(warning(page)).toBeAttached();
  await expect(toastSaying(page, `Clarified “${title}”.`)).toBeVisible();
  await settle(page, 20);
  expect(Math.abs((await tableAt()) - before)).toBeLessThanOrEqual(1);
});

test('switching vaults with the Inbox open: the new vault\'s offers land above its rows before they show, so it opens at its top with nothing "New above" (#130 attack)', async ({
  page,
}) => {
  const a = await createVault();
  await a.mkdir('Inbox');
  await a.mkdir('.atlas');
  await a.write('.atlas/settings.md', GOOD_SETTINGS);
  for (let n = 1; n <= 200; n++) {
    await a.write(`Inbox/Item ${String(n).padStart(3, '0')}.md`, `Captured line ${n}.\n`);
  }
  const b = await createVault();
  await b.mkdir('Inbox');
  for (let n = 1; n <= 4; n++) await b.write(`Inbox/Other ${n}.md`, `Other ${n}.\n`);
  const host = await installHost(page, a);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: /^Inbox/ }).click();
  await expect(inbox(page).locator('.inbox__grid tbody button').first()).toBeVisible();
  await scrollTo(page, 3000);
  await settings(page, a, true);
  await expect(newAbove(page)).toBeVisible();

  const nameOf = (vault: FakeVault) => vault.root.split(sep).at(-1) ?? '';
  host.offer(b);
  await page.getByRole('button', { name: nameOf(a), exact: true }).click();
  await page.getByRole('menuitem', { name: 'Open another folder…' }).click();
  await expect(page.getByRole('button', { name: nameOf(b), exact: true })).toBeVisible();
  // Since the workspace store (#346) each vault has its own tabs, so B opens on a
  // new tab rather than on A's Inbox; its Inbox is opened there, while B is indexed.
  await page.getByRole('button', { name: /^Inbox/ }).click();
  await expect(inbox(page).getByRole('button', { name: 'Other 1', exact: true })).toBeVisible();
  await expect(
    inbox(page).getByRole('complementary', { name: 'Set your types up for the Inbox' }),
  ).toBeAttached();
  await expect(
    inbox(page).getByRole('region', { name: 'Move tasks to GTD statuses' }),
  ).toBeAttached();
  await settle(page, 20);
  await expect(newAbove(page)).toHaveCount(0);
  expect(await scrollTop(page)).toBe(0);
});
