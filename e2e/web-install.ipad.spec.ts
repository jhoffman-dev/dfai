import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from './fixtures.ts';
import { WEB_URL } from './web-github.ts';

/**
 * #668: the web build installs to an iPad's Home Screen. The page links a
 * manifest and registers a service worker that keeps the app shell, so the
 * shell opens with the network gone; a newer build is offered as "Update
 * ready", and Reload opens under it with the old shell's cache gone.
 */

// The one project that lets a worker register (playwright.config.ts): nothing here is routed,
// as WebKit's routes never reach a page the worker controls. The sign-in function is not there,
// so the page shows its sign-in screen — the shell, which is what the worker keeps.
test.use({ serviceWorkers: 'allow' });
// One after the other: the second test serves another worker version, which the first must not meet.
test.describe.configure({ mode: 'serial' });

/** The built worker the web server serves; the update test serves another version in its place. */
const BUILT_WORKER = 'apps/web/dist/sw.js';

/**
 * A web server of the test's own, on a free port, that the test can stop:
 * WebKit's offline emulation (`setOffline`) fails every load before any
 * worker sees it, so "offline" here is the server gone — which is what the
 * worker meets on an iPad with no connection.
 */
async function ownWebServer(): Promise<{ url: string; stop: () => Promise<void> }> {
  const server = spawn('node', ['tools/serve-dist.mjs'], {
    env: { ...process.env, PORT: '0', DIST_APP: 'web' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const url = await new Promise<string>((resolve, reject) => {
    server.stdout.on('data', (chunk: Buffer) => {
      const port = /http:\/\/localhost:(\d+)/.exec(chunk.toString())?.[1];
      if (port !== undefined) resolve(`http://localhost:${port}`);
    });
    server.on('exit', (code) => reject(new Error(`The web server exited with ${String(code)}.`)));
  });
  return {
    url,
    stop: () =>
      new Promise((resolve) => {
        server.once('exit', () => resolve());
        server.kill();
      }),
  };
}

/** The shell caches the worker holds, by name. */
const shellCaches = (page: Page) =>
  page.evaluate(async () => (await caches.keys()).filter((name) => name.startsWith('dfai-shell-')));

/** Waits for the worker to control the page with the shell precached. */
async function workerReady(page: Page, url = WEB_URL) {
  await page.goto(url);
  await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.ready.then((r) => r.active?.state)))
    .toBe('activated');
  await expect
    .poll(() => page.evaluate(async () => (await caches.match('/index.html')) !== undefined))
    .toBe(true);
}

test('on the web, the page is installable: a manifest, and a worker that opens the shell offline', async ({
  page,
}) => {
  const server = await ownWebServer();
  await test.step('the manifest says DFAI, standalone, at the site root', async () => {
    await workerReady(page, server.url);
    const manifest = await page.evaluate(async () => {
      const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
      if (link === null) throw new Error('no manifest link');
      const answer = await fetch(link.href);
      return { type: answer.headers.get('content-type'), body: await answer.json() };
    });
    expect(manifest.type).toContain('application/manifest+json');
    expect(manifest.body).toMatchObject({ name: 'DFAI', display: 'standalone', scope: '/' });
  });

  await test.step('the worker installed with the shell precached', async () => {
    expect(await shellCaches(page)).toHaveLength(1);
  });

  await test.step('with the server gone, the shell loads from the worker', async () => {
    await server.stop();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible();
    expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  });
});

test('on the web, a newer build is offered as Update ready, and Reload opens under it', async ({
  page,
}) => {
  await workerReady(page);
  const [before] = await shellCaches(page);
  const offer = page.getByRole('status').filter({ hasText: 'Update ready' });
  await expect(offer).toHaveCount(0);

  // The next load finds a worker of a newer build: the same code under another version. The
  // script is swapped on disk, as a route never reaches a worker's own fetch of it.
  const built = readFileSync(BUILT_WORKER, 'utf8');
  const match = /([`"'])([0-9a-f]{16})\1/.exec(built);
  if (match === null) throw new Error('The built worker carries no version.');
  writeFileSync(BUILT_WORKER, built.replace(match[0], `${match[1]}ffffffffffffffff${match[1]}`));
  try {
    await page.reload();
    await expect(offer).toBeVisible();
    await offer.getByRole('button', { name: 'Reload' }).tap();

    await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible();
    await expect.poll(() => shellCaches(page)).toEqual(['dfai-shell-ffffffffffffffff']);
    expect(before).not.toBe('dfai-shell-ffffffffffffffff');
    await expect(offer).toHaveCount(0);
  } finally {
    writeFileSync(BUILT_WORKER, built);
  }
});
