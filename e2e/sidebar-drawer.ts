import { expect, type Page } from './fixtures.ts';

/**
 * Under this width the sidebar is a drawer over the work and one pane shows
 * (#658). The number is the domain's (`COMPACT_BELOW`,
 * packages/domain/src/panes/shell-layout.ts, held there by its test): the
 * 224px sidebar beside the 720px a note is read at. A spec that wants the
 * sidebar beside the work at its narrowest uses this width; one that wants
 * the drawer goes under it.
 */
export const SIDEBAR_BESIDE_FROM = 944;

/**
 * Puts the sidebar on screen where the window is narrow enough for it to be a
 * drawer, so a spec can click a row in it; where it already sits beside the
 * work this does nothing. The drawer closes by itself once a page is opened
 * from it, so a spec calls this before each row it clicks.
 */
export async function revealSidebar(page: Page): Promise<void> {
  if (await page.getByRole('navigation', { name: 'Vault' }).isVisible()) return;
  await page.getByRole('button', { name: 'Show sidebar' }).first().click();
  await expect(page.getByRole('dialog', { name: 'Vault' })).toBeVisible();
}
