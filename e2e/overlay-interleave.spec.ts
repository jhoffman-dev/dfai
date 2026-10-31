// Adversarial: two overlays, or an overlay and a shortcut, at once. Each palette
// is modal on its own; these ask what happens when a second one is asked for
// while the first is still up, and when what opened an overlay is gone by the
// time it closes.
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from './fixtures.ts';
import { createVault, emitVaultChanged, installHost, sidebarSection } from './host.ts';

async function openVault(page: Page) {
  const vault = await createVault();
  await vault.write('recipes.md', '# Recipes\n\nSourdough needs a long cold proof.\n');
  await vault.write('shopping.md', '# Shopping\n\nFlour.\n');
  await vault.write('plan.md', '# Plan\n\nBuy from [[shopping]] first.\n');
  await installHost(page, vault);

  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return vault;
}

async function chord(page: Page, key: string, { shift = false } = {}) {
  await page.keyboard.down('Meta');
  if (shift) await page.keyboard.down('Shift');
  await page.keyboard.press(key);
  if (shift) await page.keyboard.up('Shift');
  await page.keyboard.up('Meta');
}

/** What the browser says has focus, as a tag and class. */
function focused(page: Page) {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (active === null) return 'none';
    return `${active.tagName.toLowerCase()}.${String(active.className) || '(no class)'}`;
  });
}

test('a search asked for while capture is open does not appear after capture closes', async ({
  page,
}) => {
  await openVault(page);
  const row = page.getByRole('treeitem', { name: 'recipes', exact: true });
  await row.click();
  const opener = await focused(page);
  expect(opener).toContain('tree__row');

  const capture = page.getByRole('dialog', { name: 'Capture a task' });
  const search = page.getByRole('dialog', { name: 'Search notes' });
  await chord(page, 'N', { shift: true });
  await expect(capture).toBeVisible();

  // Cmd+K while capture holds the screen: nothing visible happens.
  await chord(page, 'k');
  await expect(capture).toBeVisible();
  await expect(search).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(capture).toHaveCount(0);
  // The search palette mounts in the same render that unmounts capture, so by
  // now it is either there or never will be; toHaveCount retries for the full
  // timeout, so a palette that stays up fails here rather than slipping past.
  await expect(search).toHaveCount(0);
});

test('Cmd+K with the new-note menu open leaves one overlay, not two', async ({ page }) => {
  await openVault(page);
  await page.getByRole('button', { name: 'New note' }).click();
  // By CSS, not by role: once a modal dialog is up, everything outside it is
  // hidden from the accessibility tree, so `getByRole('menu')` would count zero
  // for a menu that is still on screen and pass for the wrong reason.
  const menu = page.locator('[role="menu"]');
  await expect(menu).toBeVisible();

  await chord(page, 'k');

  // Settled: the palette is up and has taken focus into its input.
  await expect(page.getByRole('dialog', { name: 'Search notes' })).toBeVisible();
  await expect.poll(() => focused(page)).toBe('input.palette__input');
  // The menu should have closed as the palette opened. Two modal overlays, each
  // with its own focus trap, are on screen at once instead.
  await expect(menu).toHaveCount(0);
});

test('focus lands inside the app when what opened the palette was deleted meanwhile', async ({
  page,
}) => {
  const vault = await openVault(page);
  const row = page.getByRole('treeitem', { name: 'recipes', exact: true });
  await row.click();
  expect(await focused(page)).toContain('tree__row');

  await chord(page, 'k');
  const search = page.getByRole('dialog', { name: 'Search notes' });
  await expect(search).toBeVisible();

  await unlink(join(vault.root, 'recipes.md'));
  await emitVaultChanged(page, ['recipes.md']);
  // Guard: the opener is gone from the DOM before the palette closes. By CSS,
  // since the modal hides the tree from role queries while it is open.
  await expect(page.locator('.tree__row', { hasText: 'recipes' })).toHaveCount(0);
  await expect(page.locator('.tree__row', { hasText: 'shopping' })).toHaveCount(1);

  await page.keyboard.press('Escape');
  await expect(search).toHaveCount(0);
  await expect.poll(() => focused(page)).not.toBe('body.(no class)');
});

const TASK_TYPE = ['---', 'name: task', 'properties:', '  phase: number', '---', ''].join('\n');
const VIEW = ['---', 'atlas: view', 'type: task', 'columns: [phase]', '---', ''].join('\n');
const DASHBOARD = [
  '---',
  'atlas: dashboard',
  'widgets:',
  '  - title: Tasks',
  '    kind: number',
  '    type: task',
  '---',
  '',
].join('\n');

async function openQueryVault(page: Page) {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/views');
  await vault.mkdir('.atlas/dashboards');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write('.atlas/views/Tasks.md', VIEW);
  await vault.write('.atlas/dashboards/Progress.md', DASHBOARD);
  await vault.write('one.md', '---\ntype: task\nphase: 1\n---\n\n# One\n');
  await installHost(page, vault);

  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
}

/**
 * Cmd+K while `popup` is up: the palette takes the screen and the popup goes.
 * By CSS, not by role: under a modal the rest of the page leaves the
 * accessibility tree, so a role query would count zero for a popup still drawn.
 */
async function expectGivesWayToSearch(page: Page, popup: string) {
  await expect(page.locator(popup)).toBeVisible();
  await chord(page, 'k');
  await expect(page.getByRole('dialog', { name: 'Search notes' })).toBeVisible();
  await expect.poll(() => focused(page)).toBe('input.palette__input');
  await expect(page.locator(popup)).toHaveCount(0);
}

test('Cmd+K with a widget menu open leaves one overlay, not two', async ({ page }) => {
  await openQueryVault(page);
  await sidebarSection(page, 'dashboards')
    .getByRole('button', { name: 'Progress', exact: true })
    .click();
  // By role: a label match also finds the sidebar's "Add Tasks to favorites" star.
  const tile = page.getByRole('region', { name: 'Tasks', exact: true });
  await tile.hover();
  await tile.getByRole('button', { name: 'Widget options' }).click();
  await expectGivesWayToSearch(page, '[role="menu"]');
});

for (const control of ['Filter', 'Sort']) {
  test(`Cmd+K with the ${control} popover open leaves one overlay, not two`, async ({ page }) => {
    await openQueryVault(page);
    await sidebarSection(page, 'views').getByRole('button', { name: 'Tasks', exact: true }).click();
    await page.getByRole('button', { name: control, exact: true }).click();
    await expectGivesWayToSearch(page, '.view-popover');
  });
}

// A14-08: Cmd+N is not an overlay, so the one-overlay rule used to let it
// through — making a note behind the palette, out of sight.
for (const [palette, name, key, shift] of [
  ['search', 'Search notes', 'k', false],
  ['capture', 'Capture a task', 'N', true],
] as const) {
  test(`Cmd+N with the ${palette} palette open makes no note`, async ({ page }) => {
    const vault = await openVault(page);
    const dialog = page.getByRole('dialog', { name });
    await chord(page, key, { shift });
    await expect(dialog).toBeVisible();

    await chord(page, 'n');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // Control, and the clock for the check: Cmd+N now makes "Untitled". Had the
    // press behind the palette made one, this one would be "Untitled 2".
    await chord(page, 'n');
    await expect(page.getByRole('article', { name: 'Untitled', exact: true })).toBeVisible();
    await expect.poll(() => vault.exists('Untitled.md')).toBe(true);
    expect(await vault.exists('Untitled 2.md')).toBe(false);
  });
}

// #266 attack: ⌘K's state moved into a store, read at the key press. Shortcuts
// that change the window — split, sidebar, back — still act behind the palette.
test('Shift+Cmd+\\ with the search palette open does not split the window behind it', async ({
  page,
}) => {
  await openVault(page);
  await page.getByRole('treeitem', { name: 'recipes' }).click();
  await expect(page.getByRole('article', { name: 'recipes' })).toBeVisible();
  const dialog = page.getByRole('dialog', { name: 'Search notes' });
  await chord(page, 'k');
  await expect(dialog).toBeVisible();

  await chord(page, '\\', { shift: true });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  await expect(page.getByRole('region', { name: 'Pane 1' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Pane 2' })).toHaveCount(0);
});

test('Cmd+K opened again after a note was picked from it starts empty', async ({ page }) => {
  await openVault(page);
  const dialog = page.getByRole('dialog', { name: 'Search notes' });
  await chord(page, 'k');
  await page.getByLabel('Search the vault').fill('sourdough');
  await page.getByRole('option', { name: /Recipes/ }).click();
  await expect(page.getByRole('article', { name: 'recipes' })).toBeVisible();
  await expect(dialog).toHaveCount(0);

  await chord(page, 'k');
  await expect(dialog).toBeVisible();
  await expect(page.getByLabel('Search the vault')).toHaveValue('');
  await expect(page.getByRole('option')).toHaveCount(0);
});

test('Esc closes one layer at a time: the palette over the peek, then the peek (slice 6b)', async ({
  page,
}) => {
  await openVault(page);
  await page.getByRole('treeitem', { name: 'plan', exact: true }).click();
  await page.locator('.editor [data-wikilink="shopping"]').click();
  const peek = page.locator('.peek');
  await expect(page.getByRole('dialog', { name: 'shopping' })).toBeVisible();

  // Capture is asked for over the peek, and opens above it.
  await chord(page, 'N', { shift: true });
  const capture = page.getByRole('dialog', { name: 'Capture a task' });
  await expect(capture).toBeVisible();
  await expect.poll(() => focused(page)).toContain('input');

  await page.keyboard.press('Escape');
  await expect(capture).toHaveCount(0);
  await expect(peek).toBeVisible();
  // Focus is back in the peek, not lost behind it.
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.closest('.peek') !== null))
    .toBe(true);

  await page.keyboard.press('Escape');
  await expect(peek).toHaveCount(0);
  await expect(page.getByRole('article', { name: 'plan' })).toBeVisible();
});

test('a peek is never opened above a menu: the press on a link closes the menu instead', async ({
  page,
}) => {
  await openVault(page);
  await page.getByRole('treeitem', { name: 'plan', exact: true }).click();
  const link = page.locator('.editor [data-wikilink="shopping"]');
  const box = await link.boundingBox();
  if (box === null) throw new Error('the link was not on screen');
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.getByRole('button', { name: 'New note' }).click();
  const menu = page.locator('[role="menu"]');
  await expect(menu).toBeVisible();

  // A raw press at the link's own place, so nothing skips the menu on the test's behalf.
  await page.mouse.click(centre.x, centre.y);
  await expect(menu).toHaveCount(0);
  await expect(page.locator('.peek')).toHaveCount(0);
  // With nothing up, the same press peeks: the absence above is the menu's doing.
  await page.mouse.click(centre.x, centre.y);
  await expect(page.getByRole('dialog', { name: 'shopping' })).toBeVisible();
});
