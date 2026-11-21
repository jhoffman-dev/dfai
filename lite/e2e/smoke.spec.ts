import { expect, test } from '@playwright/test';

/** The core loop on the sample vault: write, link, follow, favourite, find, tag, graph. */
test('the core loop: new note, link, favourite, search, tags, graph', async ({ page }) => {
  await page.goto('/');
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
  await expect(sidebar).toBeVisible();
  await expect(
    page.getByText('Sample vault — connect a GitHub repository in Settings.'),
  ).toBeVisible();

  // One click, and the caret is already in a new note.
  await sidebar.getByRole('button', { name: /New note/ }).click();
  const title = page.getByRole('textbox', { name: 'Note title' });
  await expect(title).toHaveValue('Untitled');
  const editor = page.getByRole('textbox', { name: 'Note text' });
  await expect(editor).toBeFocused();
  await page.keyboard.type('Payday checklist with [[New Linked Note]] and #ideas/lite ');
  await expect(page.locator('.cm-tag-pill', { hasText: '#ideas/lite' })).toBeVisible();

  // Following a link to a note that does not exist makes it and opens it.
  await page
    .locator('.cm-link-pill', { hasText: 'New Linked Note' })
    .click({ modifiers: ['ControlOrMeta'] });
  await expect(title).toHaveValue('New Linked Note');
  await expect(page).toHaveURL(/#\/note\/Inbox%2FNew%20Linked%20Note\.md$/);
  await expect(page.getByRole('region', { name: 'Linked from' })).toContainText('Untitled');

  // Back returns to the first note, its text saved.
  await page.goBack();
  await expect(title).toHaveValue('Untitled');
  await expect(editor).toContainText('Payday checklist');

  // Favourite it: it joins the favourites above the tree.
  await page.getByRole('button', { name: 'Add to favourites' }).click();
  await expect(sidebar.getByRole('list', { name: 'Favourites' })).toContainText('Untitled');

  // Search finds the typed text.
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('combobox').fill('payday');
  const hit = page.getByRole('option').first();
  await expect(hit).toContainText('Untitled');
  await expect(hit.locator('mark')).toHaveText(/payday/i);
  await page.keyboard.press('Escape');

  // The tags view lists the tag and the note carrying it.
  await sidebar.getByRole('link', { name: 'Tags' }).click();
  const tags = page.getByRole('navigation', { name: 'Tags' });
  await tags
    .getByRole('link', { name: /#ideas/ })
    .first()
    .click();
  await expect(page.getByRole('list', { name: 'Notes tagged ideas' })).toContainText('Untitled');

  // The graph draws the vault's notes.
  await sidebar.getByRole('link', { name: 'Graph' }).click();
  await expect(page.getByRole('region', { name: 'Graph' })).toBeVisible();
  await expect(page.locator('.graph__dot').first()).toBeVisible();
  expect(await page.locator('.graph__dot').count()).toBeGreaterThan(10);
  // Drawn where it can be seen: the surface fits the window, not its own content.
  await expect(page.locator('.graph__dot').first()).toBeInViewport();
  const surface = await page.locator('.graph__surface').boundingBox();
  expect(surface?.height ?? Infinity).toBeLessThanOrEqual(page.viewportSize()?.height ?? 0);
});

test('#/new opens straight into a blank note', async ({ page }) => {
  await page.goto('/#/new');
  await expect(page.getByRole('textbox', { name: 'Note title' })).toHaveValue('Untitled');
  await expect(page.getByRole('textbox', { name: 'Note text' })).toBeFocused();
  await expect(page).toHaveURL(/#\/note\/Inbox%2FUntitled\.md$/);
});
