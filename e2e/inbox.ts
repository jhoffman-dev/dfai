import { expect, type Page } from './fixtures.ts';

/**
 * Waits for the Inbox's rows to be within reach. Until its offers are read
 * the page holds them back (#130): drawn at opacity 0, which `toBeVisible`
 * passes, but inert, so a script's focus() or a Tab passes them by (#819).
 * Held, they are out of the accessibility tree too, so a row found by its
 * role is one that can take the focus.
 */
export async function inboxRowsInReach(page: Page): Promise<void> {
  const rows = page.getByRole('article', { name: 'Inbox' }).getByRole('row');
  await expect(rows.and(page.locator('.inbox__row')).first()).toBeVisible();
}
