// The behaviours ADR-0015 adopted Base UI for, driven in a real engine: focus
// going in and coming back, Tab staying inside, and the page behind an open
// overlay being out of reach. jsdom can judge none of them — it has no layout,
// its tab order ignores what a browser would skip, and it has no hit testing —
// so they are asserted here rather than in the component tests.
import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost } from './host.ts';

async function openVault(page: Page) {
  const vault = await createVault();
  await vault.write('recipes.md', '# Recipes\n\nSourdough needs a long cold proof.\n');
  await vault.write('plan.md', '# Plan\n\nBake from [[recipes]] on Sunday.\n');
  await vault.mkdir('.atlas/templates');
  await vault.write('.atlas/templates/Person.md', '# Person\n');
  await installHost(page, vault);

  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return vault;
}

async function openSearch(page: Page) {
  await page.keyboard.down('Meta');
  await page.keyboard.press('k');
  await page.keyboard.up('Meta');
  await expect(page.getByRole('dialog', { name: 'Search notes' })).toBeVisible();
}

/**
 * Waits for focus to land where it should, rather than reading it once.
 *
 * Base UI moves focus a frame after the event that caused it, so a single read
 * races the restore — which passed alone and failed about one run in three
 * under parallel workers. A flaky test is a bug, so this waits for the
 * condition instead of assuming a frame has gone by.
 */
async function expectFocus(page: Page, selector: string): Promise<void> {
  await expect.poll(() => focused(page)).toBe(selector);
}

/** What the browser says has focus, as a tag and class we can compare. */
function focused(page: Page) {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (active === null) return 'none';
    return `${active.tagName.toLowerCase()}.${String(active.className) || '(no class)'}`;
  });
}

test('the search palette hands focus back to what opened it', async ({ page }) => {
  await openVault(page);

  const row = page.getByRole('treeitem', { name: 'recipes', exact: true });
  await row.click();
  await expect(page.getByRole('article', { name: 'recipes' })).toBeVisible();
  // Guard the guard: if the click left focus on the body, the assertion at the
  // end would pass without the palette restoring anything.
  await expect(row).toBeFocused();
  // The element itself, not its tag and classes: focus handed to another row
  // that happens to share them is not focus handed back.
  const opener = await page.evaluateHandle(() => document.activeElement);

  await openSearch(page);
  await expectFocus(page, 'input.palette__input');

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Search notes' })).toHaveCount(0);
  await expect
    .poll(() => opener.evaluate((element) => element === document.activeElement))
    .toBe(true);
});

test('Tab cannot walk out of the search palette', async ({ page }) => {
  await openVault(page);
  await page.getByRole('treeitem', { name: 'recipes', exact: true }).click();
  await openSearch(page);

  await page.getByRole('searchbox', { name: 'Search the vault' }).fill('sourdough');
  await expect(page.getByRole('option', { name: /Recipes/ })).toBeVisible();

  // Tab may land on a focus guard for a frame; what matters is where it comes
  // to rest, so each press is given the frame the bounce needs.
  const insidePalette = () =>
    page.evaluate(() => document.activeElement?.closest('.palette') !== null);

  for (let press = 0; press < 5; press += 1) {
    await page.keyboard.press('Tab');
    await expect
      .poll(insidePalette, { message: `focus left the palette after ${press + 1} tabs` })
      .toBe(true);
  }
});

test('the page behind the search palette is out of reach', async ({ page }) => {
  await openVault(page);
  const row = page.getByRole('treeitem', { name: 'recipes', exact: true });
  const box = await row.boundingBox();
  if (box === null) throw new Error('the note row was not on screen');
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  await expect(row).toBeVisible();
  // A press that reaches the row selects it in the same render as the click:
  // opening a note writes the pane layout synchronously, and selection is read
  // from it. The note's article only follows an async read, so its absence
  // straight after a press proves nothing — selection is what is asserted.
  await expect(row).toHaveAttribute('aria-selected', 'false');
  await openSearch(page);

  // Out of reach for a screen reader too: while the palette is open the rest
  // of the app is hidden from the accessibility tree, so nothing behind the
  // scrim can be found by its role.
  await expect(page.getByRole('treeitem')).toHaveCount(0);

  // A raw press at the row's own coordinates, so nothing skips the scrim on
  // the test's behalf. It dismisses the palette instead of reaching the note.
  await page.mouse.click(centre.x, centre.y);
  await expect(page.getByRole('dialog', { name: 'Search notes' })).toHaveCount(0);
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('aria-selected', 'false');

  // The same press with nothing over it does open the note: the assertion above
  // is about the palette, not about coordinates that never worked.
  await page.mouse.click(centre.x, centre.y);
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('article', { name: 'recipes' })).toBeVisible();
});

test('the new-note menu is usable from the keyboard alone', async ({ page }) => {
  await openVault(page);

  const button = page.getByRole('button', { name: 'New note' });
  await button.click();
  await expect(page.getByRole('menuitem', { name: 'Blank note' })).toBeVisible();

  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Blank note' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: "Today's note" })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(button).toBeFocused();
});

/** Opens plan.md and peeks the note its link names (slice 6b). */
async function peekRecipes(page: Page) {
  await page.getByRole('treeitem', { name: 'plan', exact: true }).click();
  await page.locator('.editor [data-wikilink="recipes"]').click();
  await expect(page.getByRole('dialog', { name: 'recipes' })).toBeVisible();
}

test('Tab cannot walk out of the peek', async ({ page }) => {
  await openVault(page);
  await peekRecipes(page);
  const insidePeek = () => page.evaluate(() => document.activeElement?.closest('.peek') !== null);
  for (let press = 0; press < 8; press += 1) {
    await page.keyboard.press('Tab');
    await expect
      .poll(insidePeek, { message: `focus left the peek after ${press + 1} tabs` })
      .toBe(true);
  }
});

test('the page behind the peek is out of reach, and a press on it closes the peek', async ({
  page,
}) => {
  await openVault(page);
  const row = page.getByRole('treeitem', { name: 'recipes', exact: true });
  const box = await row.boundingBox();
  if (box === null) throw new Error('the note row was not on screen');
  await peekRecipes(page);
  // Hidden from a screen reader while the peek is up, as behind a palette.
  await expect(page.getByRole('treeitem')).toHaveCount(0);

  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByRole('dialog', { name: 'recipes' })).toHaveCount(0);
  // The press closed the peek and reached nothing behind it: plan is still the page.
  await expect(page.getByRole('article', { name: 'plan' })).toBeVisible();
  await expect(row).toHaveAttribute('aria-selected', 'false');
});

/** A vault whose one view is a table of tasks with a status to pick (#300). */
async function openTaskTable(page: Page) {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/views');
  await vault.write(
    '.atlas/types/task.md',
    '---\nname: task\nproperties:\n  status:\n    kind: select\n    options: [backlog, doing, done]\n---\n',
  );
  await vault.write(
    '.atlas/views/Tasks.md',
    '---\natlas: view\ntype: task\ncolumns: [status]\n---\n',
  );
  await vault.write('one.md', '---\ntype: task\nstatus: doing\n---\n\n# One\n');
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Vault' })
    .getByRole('button', { name: 'Tasks', exact: true })
    .click();
  const cell = page.locator('.table [data-cell-stop="status"]').first();
  await expect(cell).toBeVisible();
  return { vault, cell };
}

test('a cell’s picker hands focus back to its cell on Esc', async ({ page }) => {
  const { cell } = await openTaskTable(page);
  await cell.click();
  const picker = page.getByRole('dialog', { name: 'Set Status' });
  await expect(picker).toBeVisible();
  // Guard the guard: the focus went into the picker, so its coming back is the picker's doing.
  await expect(picker.getByRole('combobox')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  await expect(cell).toBeFocused();
});

test('Cmd+K over a cell’s picker closes the picker first, writing nothing', async ({ page }) => {
  const { vault, cell } = await openTaskTable(page);
  await cell.click();
  // By CSS, not by role: under the palette the page leaves the accessibility tree.
  const picker = page.locator('.cell-picker');
  await expect(picker).toBeVisible();
  await openSearch(page);
  await expect.poll(() => focused(page)).toBe('input.palette__input');
  await expect(picker).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Search notes' })).toHaveCount(0);
  expect(await vault.read('one.md')).toContain('status: doing');
});
