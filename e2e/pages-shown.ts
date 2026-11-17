import type { Page } from '@playwright/test';

/**
 * Starts the page with the sidebar's Pages section shown, as it was before it
 * was hidden by default (#902), so the specs and the work budgets written
 * against the tree find it there. Only a machine that has kept no choice is
 * seeded: a spec that hides Pages and reloads finds it still hidden. The key
 * is the shell's `atlas.sidebar.hidden` (browser-hidden-section-store.ts).
 */
export async function startWithPagesShown(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      if (window.localStorage.getItem('atlas.sidebar.hidden') === null) {
        window.localStorage.setItem('atlas.sidebar.hidden', '[]');
      }
    } catch {
      // Safe to ignore: a frame with no storage of its own (an artifact's
      // sandboxed copy) draws no sidebar.
    }
  });
}
