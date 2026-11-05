import type { BrowserContext } from '@playwright/test';
import { test } from './fixtures.ts';
import { seenAsMac } from './platform.ts';
import { makeTempFolder } from './temp-folders.ts';
import { ownWebServer } from './web-server.ts';

/**
 * The `test` for a web spec that needs the browser's index (#666), which
 * keeps its SQLite files in the origin's private file system (OPFS).
 *
 * A test's usual context is ephemeral, and WebKit refuses OPFS's file
 * handles there ("an unknown transient reason"), so the index never comes
 * up. So the page opens in a profile on disk, as Safari's is. But WebKit on
 * macOS keeps OPFS in one place for every profile, by origin, not in the
 * profile's folder: two tests on one origin share the index file, and one
 * signing out throws away the other's (`no such table: props`). So each test
 * also gets a web server of its own, `webUrl`, whose port makes its origin
 * its own; and what it kept there is removed once it ends.
 */
export const webTest = test.extend<{ webUrl: string }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from this pattern; it has none.
  webUrl: async ({}, use) => {
    const server = await ownWebServer();
    await use(server.url);
    await server.stop();
  },
  context: async (
    {
      playwright,
      browserName,
      headless,
      viewport,
      hasTouch,
      userAgent,
      deviceScaleFactor,
      launchOptions,
      webUrl,
    },
    use,
  ) => {
    const context = await playwright[browserName].launchPersistentContext(
      await makeTempFolder('dfai-web-profile-'),
      {
        ...launchOptions,
        headless,
        viewport,
        hasTouch,
        deviceScaleFactor,
        ...(userAgent !== undefined && { userAgent }),
        // Routes never reach a page the web build's worker controls (playwright.config.ts).
        serviceWorkers: 'block',
      },
    );
    await seenAsMac(context);
    await use(context);
    await removeWhatTheOriginKept(context, webUrl);
    await context.close();
  },
});

/**
 * Empties the origin's private file system, which outlives the profile.
 * The app's pages leave first, so the index worker lets its files go; the
 * page that empties it is the manifest, which starts no app.
 */
async function removeWhatTheOriginKept(context: BrowserContext, webUrl: string) {
  for (const page of context.pages()) await page.goto('about:blank');
  const page = await context.newPage();
  await page.goto(`${webUrl}/manifest.webmanifest`);
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    for await (const name of root.keys()) await root.removeEntry(name, { recursive: true });
  });
}
