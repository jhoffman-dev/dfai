import type { BrowserContext } from '@playwright/test';

/**
 * The suite drives the app as it ships, on a Mac, wherever WebKit runs: in CI
 * the gate runs it in WebKit on Linux (gate.yml). Two things differ there.
 *
 * The app reads `navigator.platform` to choose ⌘ or Ctrl as its command key
 * (`runsOnMac` in app-shortcuts.ts, ProseMirror's `Mod`), and many handlers
 * read ⌘ (`metaKey`) alone. So off macOS the page is told it runs on a Mac,
 * and the tests press ⌘ everywhere, as on a Mac.
 *
 * WebKit's own editing keys are the platform's, not the page's: on macOS End
 * and Home scroll and leave the caret where it was (#448), and ⌘→ and ⌘← move
 * it to the line's end and start; on Linux End and Home do. Tests of what only
 * macOS's text system does (⌃T transposing two letters) are tagged `@mac`.
 */
export const onMac = process.platform === 'darwin';

export const LINE_END = onMac ? 'Meta+ArrowRight' : 'End';
export const LINE_START = onMac ? 'Meta+ArrowLeft' : 'Home';

/** Makes every page `context` opens report a Mac, when it does not run on one. */
export async function seenAsMac(context: BrowserContext): Promise<void> {
  if (onMac) return;
  await context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'platform', {
      get: () => 'MacIntel',
      configurable: true,
    });
  });
}
