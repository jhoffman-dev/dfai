import { expect, test, type Locator, type Page } from './fixtures.ts';
import { createVault, installHost } from './host.ts';

// More than the palette's LIMIT (20), so the list holds a full page of hits and scrolls.
const NOTES = 24;

async function openPaletteOverManyHits(page: Page): Promise<Locator> {
  await page.setViewportSize({ width: 1280, height: 720 });
  const vault = await createVault();
  for (let n = 1; n <= NOTES; n += 1) {
    const name = `garden-${String(n).padStart(2, '0')}`;
    await vault.write(`${name}.md`, `# ${name}\n\nTomatoes along the south fence.\n`);
  }
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();

  await page.keyboard.down('Meta');
  await page.keyboard.press('k');
  await page.keyboard.up('Meta');
  const palette = page.getByRole('dialog', { name: 'Search notes' });
  await page.getByRole('searchbox', { name: 'Search the vault' }).fill('tomatoes');
  await expect(palette.getByRole('option')).toHaveCount(20);
  return palette;
}

/** Whether the selected row lies wholly inside the list's visible box. */
async function selectedIsInView(palette: Locator): Promise<boolean> {
  const list = await palette.getByRole('listbox', { name: 'Results' }).boundingBox();
  const row = await palette.locator('[aria-selected="true"]').boundingBox();
  if (list === null || row === null) return false;
  return row.y >= list.y - 0.5 && row.y + row.height <= list.y + list.height + 0.5;
}

test('arrowing through the results keeps the selected one in view (#372)', async ({ page }) => {
  const palette = await openPaletteOverManyHits(page);
  const options = palette.getByRole('option');
  const searchbox = page.getByRole('searchbox', { name: 'Search the vault' });

  // The list must actually overflow, or the test proves nothing.
  const overflows = await palette
    .getByRole('listbox', { name: 'Results' })
    .evaluate((list) => list.scrollHeight > list.clientHeight);
  expect(overflows).toBe(true);

  for (let step = 0; step < 19; step += 1) await searchbox.press('ArrowDown');
  await expect(options.nth(19)).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => selectedIsInView(palette)).toBe(true);

  for (let step = 0; step < 19; step += 1) await searchbox.press('ArrowUp');
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => selectedIsInView(palette)).toBe(true);

  // Up from the first wraps to the last, and the list follows it down.
  await searchbox.press('ArrowUp');
  await expect(options.nth(19)).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => selectedIsInView(palette)).toBe(true);
});
