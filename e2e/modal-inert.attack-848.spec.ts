import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost } from './host.ts';

/**
 * Attack on #848 (#827): the app is inert behind every modal over it. The
 * peek is one: Tab from the body must not walk the app behind it.
 */
async function openVault(page: Page) {
  const vault = await createVault();
  await vault.write('Hub.md', '# Hub\n\nThe centre links [[Far]].\n');
  await vault.write('Far.md', '# Far\n\nThe edge.\n');
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return vault;
}

const openNote = (page: Page, name: string) =>
  page.getByRole('treeitem', { name, exact: true }).click();

test('with a peek open and the focus on the body, Tab stays in the peek', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openVault(page);
  await openNote(page, 'Hub');
  await page.getByRole('article', { name: 'Hub' }).locator('[data-wikilink="Far"]').click();
  const peek = page.getByRole('dialog', { name: 'Far' });
  await expect(peek).toBeVisible();
  const inDialog = () =>
    page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null);
  await expect.poll(inDialog).toBe(true);
  // #848 leaves the peek out as "a portal inside its pane", but the app's peek
  // passes no container: it is portalled to the body, a modal over the whole app.
  await expect.poll(() => peek.evaluate((node) => node.closest('.shell') === null)).toBe(true);

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let press = 0; press < 4; press += 1) {
    await page.keyboard.press('Tab');
    await expect.poll(inDialog).toBe(true);
  }
});
