import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost, sidebarSection } from './host.ts';

// P13-10: the tree is navigable by arrow key, from a keyboard alone.

const focusedRow = (page: Page) => page.locator('[role="treeitem"]:focus');

/**
 * Presses Tab until the tree has the focus, with no row clicked.
 *
 * WebKit starts tabbing only once something in the page has taken the focus —
 * in the real window that has happened before the user touches anything — so
 * a click on the bare ground beside the panel stands in for it: it is not a
 * control, and clicking it neither opens anything nor moves the focus off the
 * body. The loop's count is not the assertion; that the tree is reached at all
 * is.
 */
async function tabToTree(page: Page): Promise<void> {
  await page.locator('.shell__main').click({ position: { x: 2, y: 2 } });
  for (let press = 0; press < 40 && (await focusedRow(page).count()) === 0; press += 1) {
    await page.keyboard.press('Tab');
  }
}

test('is driven by the keyboard from a standing start', async ({ page }) => {
  const vault = await createVault();
  await vault.write('alpha.md', '# Alpha\n');
  await vault.write('beta.md', '# Beta\n');
  await installHost(page, vault);

  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  const userSpace = sidebarSection(page, 'userSpace');
  await expect(userSpace.getByRole('treeitem', { name: 'alpha', exact: true })).toBeVisible();

  // No row is clicked: Tab has to find its way into the tree on its own, and
  // land on the first row rather than on every row's star in turn.
  await tabToTree(page);
  await expect(focusedRow(page)).toHaveAttribute('aria-label', 'alpha');

  await page.keyboard.press('ArrowDown');
  await expect(focusedRow(page)).toHaveAttribute('aria-label', 'beta');

  // The star of the focused row is the next stop after it, so taking the rows
  // out of the tab order has not put the stars out of reach.
  await page.keyboard.press('Tab');
  await expect(page.locator('button:focus')).toHaveAttribute('aria-label', 'Add beta to favorites');
  await page.keyboard.press('Shift+Tab');
  await expect(focusedRow(page)).toHaveAttribute('aria-label', 'beta');

  await page.keyboard.press('Enter');
  await expect(page.getByRole('article', { name: 'beta' })).toBeVisible();
});

test('reaches a row the virtualiser is not holding, and holds no more for it', async ({ page }) => {
  const vault = await createVault();
  await Promise.all(
    Array.from({ length: 600 }, (_, index) =>
      vault.write(`note-${String(index).padStart(4, '0')}.md`, `# Note ${index}\n`),
    ),
  );
  await installHost(page, vault);

  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByRole('treeitem', { name: 'note-0000', exact: true })).toBeVisible();

  await tabToTree(page);
  await expect(focusedRow(page)).toHaveAttribute('aria-label', 'note-0000');

  // The last row is six hundred deep and has never been rendered: it has to be
  // scrolled to before there is anything to focus.
  await page.keyboard.press('End');
  await expect(focusedRow(page)).toHaveAttribute('aria-label', 'note-0599');

  // And still only a screenful of rows in the DOM. Focusing a row is not a
  // reason to render the six hundred.
  await expect(async () => {
    const rendered = await page.getByRole('treeitem').count();
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(100);
  }).toPass();

  await page.keyboard.press('Enter');
  await expect(page.getByRole('article', { name: 'note-0599' })).toBeVisible();
});

test('opens a row’s menu from its "…" on the first item, and Escape comes back (#250)', async ({
  page,
}) => {
  const vault = await createVault();
  await vault.write('alpha.md', '# Alpha\n');
  await installHost(page, vault);

  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByRole('treeitem', { name: 'alpha', exact: true })).toBeVisible();

  await tabToTree(page);
  await expect(focusedRow(page)).toHaveAttribute('aria-label', 'alpha');
  // The row, then its star, then its "…".
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const more = page.getByRole('button', { name: 'Options for alpha', exact: true });
  await expect(more).toBeFocused();

  for (const key of ['Enter', 'Space']) {
    await page.keyboard.press(key);
    const menu = page.getByRole('menu', { name: 'Page' });
    await expect(menu.getByRole('menuitem').first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem').nth(1)).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(more).toBeFocused();
  }
});
