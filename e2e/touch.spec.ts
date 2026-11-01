import { expect, test, type Page } from './fixtures.ts';
import { dragWithTouch, swipeFrom } from './drag.ts';
import { createVault, expectFile, installHost, sidebarSection, type FakeVault } from './host.ts';

/**
 * Touch (#659), on an iPad on its side — the one screen James's wife reads
 * on: a finger has no hover and no right button, so every control that
 * waited for the pointer is there, each at least 44px to the finger, a hold
 * picks up what a mouse drags and opens what a right-click would, and a
 * swipe still scrolls. `hasTouch` is what makes WebKit a touch screen: it
 * answers `(pointer: coarse)` and raises touch events. The hold itself is
 * the domain's (`LONG_PRESS`, packages/domain/src/touch/long-press.ts): no
 * test here waits it out by the clock; each waits for the state it ends in.
 */

test.use({ viewport: { width: 1180, height: 820 }, hasTouch: true });

/**
 * The hold, as the domain sets it (`LONG_PRESS.holdMs`, held there by its
 * test). Written here only to know when a clock is well past it.
 */
const HOLD_MS = 300;

const TASK_TYPE = [
  '---',
  'name: task',
  'label: Task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [backlog, doing, done]',
  '---',
  '',
].join('\n');

const BOARD = [
  '---',
  'atlas: view',
  'type: task',
  'layout: board',
  'groupBy: status',
  '---',
  '',
  '# Board',
  '',
].join('\n');

const task = (title: string, status: string) =>
  ['---', 'type: task', `status: ${status}`, '---', '', `# ${title}`, ''].join('\n');

const PLAN = ['# Garden plan', '', 'First line.', '', 'Second line.', '', 'Third line.', ''].join(
  '\n',
);

async function openVault(page: Page): Promise<FakeVault> {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/views');
  await vault.mkdir('Notes');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write('.atlas/views/Board.md', BOARD);
  await vault.write('first.md', task('First', 'backlog'));
  await vault.write('second.md', task('Second', 'doing'));
  await vault.write('Notes/Garden plan.md', PLAN);

  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return vault;
}

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Vault' });
const headings = (page: Page) => sidebar(page).getByRole('heading', { level: 2 });
const heading = (page: Page, name: string) =>
  sidebar(page).getByRole('button', { name, exact: true });
const grip = (page: Page, name: string) =>
  sidebar(page).getByRole('button', { name: `Move ${name}` });

async function openBoard(page: Page) {
  await sidebarSection(page, 'views').getByRole('button', { name: 'Board', exact: true }).click();
  await page.locator('[data-path="first.md"]').waitFor();
}

test('a card held by a finger, then moved, lands in another column and its file says so', async ({
  page,
}) => {
  const vault = await openVault(page);
  await openBoard(page);

  await dragWithTouch(page, {
    from: page.locator('.board__card[data-path="first.md"]'),
    to: page.locator('.board').getByRole('region', { name: 'Done', exact: true }),
    overText: 'is over Done.',
  });

  await expectFile(vault, 'first.md').toContain('status: done');
});

test('a finger that swipes off a card at once is scrolling: the card is not picked up', async ({
  page,
}) => {
  await openVault(page);
  await openBoard(page);
  // A held card says so on its title (`aria-pressed`); one at rest says nothing.
  const title = page.getByRole('button', { name: 'second', exact: true });
  await expect(title).toBeVisible();

  const startedAt = await page.evaluate(() => performance.now());
  await swipeFrom(page.locator('.board__card[data-path="second.md"]'), { x: 0, y: 40 });
  // Not a wait by the clock for its own sake: the sensor's hold runs on the
  // page's clock, so once that clock is well past it, the pick-up it would
  // have made has either happened or never will.
  await expect
    .poll(() => page.evaluate(() => performance.now()))
    .toBeGreaterThan(startedAt + 2 * HOLD_MS);
  await expect(title).not.toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[id^="DndLiveRegion"]').filter({ hasText: /Picked up/ })).toHaveCount(
    0,
  );
});

test('the sidebar’s grips are there for a finger, 44px square, and a section held by one moves', async ({
  page,
}) => {
  const vault = await openVault(page);
  await expect(headings(page)).toHaveText(['Favorites', 'Types', 'Views', 'Dashboards', 'Pages']);

  // No hover needed: the grip is drawn, and the heading has grown to make it 44px.
  await expect(grip(page, 'Favorites')).toHaveCSS('opacity', '1');
  const box = await grip(page, 'Favorites').boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(44);
  expect(box?.height).toBeGreaterThanOrEqual(44);
  const label = await heading(page, 'Favorites').boundingBox();
  expect(label?.height).toBeGreaterThanOrEqual(44);

  await dragWithTouch(page, {
    from: grip(page, 'Favorites'),
    to: heading(page, 'Dashboards'),
    overText: 'over droppable area dashboards',
  });

  await expect(headings(page)).toHaveText(['Types', 'Views', 'Dashboards', 'Favorites', 'Pages']);
  await expectFile(vault, '.atlas/settings.md').toContain('dashboards');
});

test('a page row’s “…” is there for a finger, 44px wide, and a tap on it opens the row’s menu', async ({
  page,
}) => {
  await openVault(page);
  const tree = sidebarSection(page, 'userSpace');
  await tree.getByRole('treeitem', { name: 'Notes' }).click();
  const more = tree.getByRole('button', { name: 'Options for Garden plan' });
  await expect(more).toHaveCSS('opacity', '1');
  const box = await more.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(44);

  await more.tap();
  await expect(page.getByRole('menu', { name: 'Page' })).toBeVisible();
});

test('a type’s row held by a finger opens its menu; a tap on it opens the type', async ({
  page,
}) => {
  await openVault(page);
  const row = sidebarSection(page, 'types').getByRole('button', { name: /^Task/ });
  const box = await row.boundingBox();
  if (box === null) throw new Error('The row is not on screen.');
  const finger = {
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    clientX: box.x + 30,
    clientY: box.y + box.height / 2,
    bubbles: true,
  };

  await row.dispatchEvent('pointerdown', finger);
  // The menu comes once the hold has passed on the page's clock; this waits for the menu.
  const menu = page.getByRole('menu', { name: 'Task' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Edit type' })).toBeVisible();
  await row.dispatchEvent('pointerup', finger);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  await row.tap();
  await expect(page.getByRole('navigation', { name: 'Views' })).toBeVisible();
});

test('a tap on a block puts its handle beside it, with 44px to the finger, and the handle’s menu moves the block', async ({
  page,
}) => {
  const vault = await openVault(page);
  const tree = sidebarSection(page, 'userSpace');
  await tree.getByRole('treeitem', { name: 'Notes' }).click();
  // By its name: the star and the "…" at the row's end are controls of their own.
  await tree
    .getByRole('treeitem', { name: 'Garden plan', exact: true })
    .getByText('Garden plan')
    .click();
  const editor = page
    .getByRole('article', { name: 'Garden plan' })
    .getByLabel('Note', { exact: true });
  const second = editor.locator('p', { hasText: 'Second line.' });
  await expect(second).toBeVisible();
  const handle = page.locator('[data-block-handle]');
  await expect(handle).toBeHidden();

  await second.tap();
  await expect(handle).toBeVisible();
  const [handleBox, lineBox] = await Promise.all([handle.boundingBox(), second.boundingBox()]);
  if (handleBox === null || lineBox === null) throw new Error('Not drawn.');
  expect(handleBox.x + handleBox.width).toBeLessThanOrEqual(lineBox.x);
  expect(handleBox.y).toBeGreaterThanOrEqual(lineBox.y - 2);

  // A finger well off the drawn ⋮⋮ — 12px left of it and 10px below its middle, in
  // the 44px round it — still opens the menu.
  await page.touchscreen.tap(handleBox.x - 12, handleBox.y + handleBox.height / 2 + 10);
  const menu = page.getByRole('menu', { name: 'Block' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: /Move down/ }).tap();

  await expect(editor.locator('p')).toHaveText(['First line.', 'Third line.', 'Second line.']);
  await expectFile(vault, 'Notes/Garden plan.md').toContain('Third line.\n\nSecond line.');
});
