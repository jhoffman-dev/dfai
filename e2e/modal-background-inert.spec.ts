import { expect, test } from './fixtures.ts';
import { createVault, installHost } from './host.ts';
import { modalFocus, tabWithin } from './modal-focus.ts';

/**
 * The app behind an open modal is out of the keyboard's reach (#827). Base UI
 * hides it from assistive tech but left it tabbable, and the dialog takes its
 * first focus a frame after it opens: with the focus still on the body, Tab
 * walked the sidebar, the tab strip and the page bar behind Settings. Here the
 * focus is put back on the body with the dialog open, and Tab must stay in it.
 */
test('with Settings open and the focus on the body, Tab stays in the dialog', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const vault = await createVault();
  await vault.write('today.md', '# Today\n\nFirst paragraph.\n');
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await expect.poll(() => modalFocus(page, 'Settings')).toBe('dialog');

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  expect(await modalFocus(page, 'Settings')).toBe('body');
  for (let press = 0; press < 4; press += 1) {
    expect(await tabWithin(page, { dialog: 'Settings' })).toBe('dialog');
  }
});
