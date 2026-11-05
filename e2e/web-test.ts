import type { BrowserContext } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { seenAsMac } from './platform.ts';
import { makeTempFolder } from './temp-folders.ts';
import { ownWebServer } from './web-server.ts';

/**
 * Whether these specs stay off this machine: on macOS, WebKit keeps a
 * persistent profile's origin storage under ~/Library/WebKit, outside the
 * profile's folder, and a test never writes there. The Linux gate runs them;
 * `DFAI_WEB_E2E_ON_MAC=1` runs them on a Mac anyway, knowing it does.
 */
const KEPT_OFF_THIS_MAC = process.platform === 'darwin' && !process.env.DFAI_WEB_E2E_ON_MAC;

/**
 * The `test` for a web spec that needs the browser's index (#666), which
 * keeps its SQLite files in the origin's private file system (OPFS).
 *
 * A test's usual context is ephemeral, and WebKit refuses OPFS's file
 * handles there ("an unknown transient reason"), so the index never comes
 * up. So the page opens in a profile on disk, as Safari's is. But WebKit on
 * macOS keeps origin storage in one place for every profile, by origin, not
 * in the profile's folder: two tests on one origin shared the index file,
 * and one signing out threw away the other's (`no such table: props`). So
 * each test also gets a web server of its own, `webUrl`, whose port makes
 * its origin its own; and everything the origin kept is removed once it ends.
 */
export const webTest = test.extend<{ webUrl: string }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from this pattern; it has none.
  webUrl: async ({}, use, testInfo) => {
    testInfo.skip(KEPT_OFF_THIS_MAC, 'writes to ~/Library/WebKit on macOS; runs in the Linux gate');
    const server = await ownWebServer();
    try {
      await use(server.url);
    } finally {
      await server.stop();
    }
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
    try {
      await seenAsMac(context);
      await use(context);
      await removeWhatTheOriginKept(context, webUrl);
    } finally {
      await context.close();
    }
  },
});

/**
 * Empties everything the origin kept, which may outlive the profile: its
 * private file system, IndexedDB, Cache Storage and web storage. The app's
 * pages leave first, which ends the index worker and lets its file handles
 * go; the page that empties it is the manifest, which starts no app. Tried
 * again until it holds, as the worker's handles close a moment after it ends.
 */
async function removeWhatTheOriginKept(context: BrowserContext, webUrl: string) {
  for (const page of context.pages()) await page.goto('about:blank');
  const page = await context.newPage();
  await page.goto(`${webUrl}/manifest.webmanifest`);
  await expect(async () => {
    await page.evaluate(emptyTheOrigin);
    expect(await page.evaluate(whatTheOriginKeeps)).toEqual([]);
  }).toPass({ timeout: 10_000 });
}

/** Runs in the page: removes each kind of storage the origin has. */
async function emptyTheOrigin(): Promise<void> {
  const root = await navigator.storage.getDirectory();
  for await (const name of root.keys()) await root.removeEntry(name, { recursive: true });
  for (const { name } of await indexedDB.databases()) {
    if (name === undefined) continue;
    await new Promise<void>((resolve, reject) => {
      const deleting = indexedDB.deleteDatabase(name);
      deleting.onsuccess = () => resolve();
      deleting.onerror = () => reject(deleting.error ?? new Error(`${name} was not deleted`));
      deleting.onblocked = () => reject(new Error(`${name} is still open`));
    });
  }
  for (const name of await caches.keys()) await caches.delete(name);
  localStorage.clear();
  sessionStorage.clear();
}

/** Runs in the page: what is left, by kind and name, to show none is. */
async function whatTheOriginKeeps(): Promise<string[]> {
  const root = await navigator.storage.getDirectory();
  const left: string[] = [];
  for await (const name of root.keys()) left.push(`file system: ${name}`);
  for (const { name } of await indexedDB.databases()) left.push(`IndexedDB: ${String(name)}`);
  for (const name of await caches.keys()) left.push(`cache: ${name}`);
  if (localStorage.length > 0) left.push(`localStorage: ${localStorage.length} keys`);
  if (sessionStorage.length > 0) left.push(`sessionStorage: ${sessionStorage.length} keys`);
  return left;
}
