import { expect, test } from '@playwright/test';

test('the app loads with its sidebar', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Sidebar' })).toBeVisible();
  await expect(page.getByRole('main')).toBeAttached();
});
