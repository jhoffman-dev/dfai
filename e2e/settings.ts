import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Opens Settings and waits until the dialog holds the focus. Its fields draw
 * before it takes the focus: Base UI moves it in on a later animation frame,
 * and WebKit's click leaves it on the body until then. A Tab pressed in that
 * gap walks the app behind the modal instead (#822: an Option+Tab walk spent
 * all 40 presses there and in the section list).
 */
export async function openSettings(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog.locator('.field').first()).toBeVisible();
  await expect(dialog.locator(':focus')).toHaveCount(1);
  return dialog;
}
