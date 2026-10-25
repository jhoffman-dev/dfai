import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Frame } from '@playwright/test';
import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost, type FakeHost } from './host.ts';
import {
  hostileFixtureEpub,
  HOSTILE_IPC_COMMAND,
  HOSTILE_ORIGIN,
} from '../tools/epub/fixture-epub.ts';

/*
 * A hostile EPUB in the reader (#505, ADR-0045), end to end in WebKit: a
 * book that tries scripts in every form, handlers, pictures, fonts,
 * stylesheets and frames on another site, a refresh, a form, links out,
 * `javascript:` links, links hidden in MathML and SVG to a picture of its
 * own that holds a script, and reaching for `window.parent`, runs nothing
 * as the app, asks for nothing outside it, never leads its frame anywhere
 * and never reaches the host — and its one link inside the book still goes
 * where it says.
 */

const BOOK = 'Library/hostile.epub';

/** What a test of the hostile book watches: every request that left the app, every hit on the book's site, and the host. */
interface Watched {
  readonly outside: string[];
  readonly hits: string[];
  readonly host: FakeHost;
}

async function openHostileBook(page: Page): Promise<Watched> {
  const outside: string[] = [];
  const hits: string[] = [];
  page.on('request', (request) => {
    if (!isOwn(request.url())) outside.push(request.url());
  });
  // The book's site, as a server that keeps every hit and answers none, so one that slipped through could not load.
  await page.route(`${HOSTILE_ORIGIN}/**`, (route) => {
    hits.push(route.request().url());
    return route.abort();
  });
  const vault = await createVault();
  await mkdir(join(vault.root, 'Library'), { recursive: true });
  await writeFile(join(vault.root, BOOK), hostileFixtureEpub());
  const host = await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await page.getByRole('treeitem', { name: 'Library' }).click();
  await page.getByRole('treeitem', { name: 'hostile.epub' }).click();
  return { outside, hits, host };
}

/** A request is the app's own when it goes to the page's own server, or never leaves the page (`blob:`, `data:`, `about:`). */
function isOwn(url: string): boolean {
  if (/^(blob|data|about):/.test(url)) return true;
  const { hostname } = new URL(url);
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

const text = (page: Page) => page.frameLocator('iframe.epub-frame').locator('body');

async function frameOf(page: Page): Promise<Frame> {
  const frame = await (await page.locator('iframe.epub-frame').elementHandle())?.contentFrame();
  if (frame === null || frame === undefined) throw new Error('the reader shows no chapter');
  return frame;
}

/** What any of the book's scripts would have left behind, in the app's window or the frame's. */
async function traces(page: Page): Promise<unknown[]> {
  const frame = await frameOf(page);
  return [
    await page.evaluate(() => (window as { __hostileRan?: unknown }).__hostileRan ?? null),
    await frame.evaluate(() => (window as { __hostileRan?: unknown }).__hostileRan ?? null),
  ].filter((trace) => trace !== null);
}

/** Nothing of the book ran as the app or at all, its frame is still DFAI's document, the host was never asked, nothing left. */
async function expectNothingEscaped(page: Page, { outside, hits, host }: Watched): Promise<void> {
  const frame = await frameOf(page);
  expect(frame.url()).toBe('about:srcdoc');
  expect(
    await page.evaluate(() => (window as { __hostileRan?: unknown }).__hostileRan ?? null),
  ).toBeNull();
  expect(await traces(page)).toEqual([]);
  expect(host.callsTo(HOSTILE_IPC_COMMAND)).toBe(0);
  expect(hits).toEqual([]);
  expect(outside).toEqual([]);
}

/** Every picture in the frame has had its chance to load (or to fail). */
async function picturesSettled(frame: Frame): Promise<void> {
  await expect
    .poll(() => frame.evaluate(() => [...document.images].every((image) => image.complete)))
    .toBe(true);
}

test('a hostile book runs no script and asks for nothing outside the app', async ({ page }) => {
  const watched = await openHostileBook(page);
  await expect(text(page)).toContainText('A Hare one day ridiculed the short feet');
  const frame = await frameOf(page);

  // The frame holds none of the book's scripts, frames or plug-ins, under the reader's policy.
  expect(
    await frame.evaluate(() => document.querySelectorAll('script, iframe, object, embed').length),
  ).toBe(0);
  // An opaque origin (ADR-0045): nothing in the frame is of the app's.
  expect(await page.locator('iframe.epub-frame').getAttribute('sandbox')).toBe('allow-scripts');
  // The pictures have had their chance to load: the book's own SVG is written in, nothing else was asked for.
  await picturesSettled(frame);
  expect(
    await frame.evaluate(() =>
      [...document.images]
        .filter((image) => image.hasAttribute('src'))
        .map((image) => image.src.slice(0, 5)),
    ),
  ).toEqual(['data:']);

  await frame.locator('p', { hasText: 'Click this line.' }).click();
  await frame.locator('#send').click();
  await frame.locator('#out').click();
  await frame.locator('#js').click();
  await expect(text(page)).toContainText('A Hare one day ridiculed');
  expect(page.url()).not.toContain('beacon');
  await expectNothingEscaped(page, watched);
});

test("a hostile book's link inside the book goes to its chapter", async ({ page }) => {
  const watched = await openHostileBook(page);
  const frame = await frameOf(page);
  await expect(text(page)).toContainText('Go to the calm chapter');
  await frame.locator('#inside').click();
  await expect(text(page)).toContainText('Slow but steady wins the race.');
  await expect(page.getByText('2 of 2')).toBeVisible();
  await expectNothingEscaped(page, watched);
});

test("a link the book hides in MathML or SVG leads nowhere, and the book's own SVG never runs as the app", async ({
  page,
}) => {
  const watched = await openHostileBook(page);
  await expect(text(page)).toContainText('Follow the math');
  const frame = await frameOf(page);
  // A MathML element with an `href` is a link to WebKit: once it pointed at the book's
  // SVG, given the app's origin, and a click ran that SVG's script as the app (#505).
  for (const target of ['#mathlink', '#forged', '#svglink']) {
    await frame.locator(target).click();
    await expect(text(page)).toContainText('Follow the math');
    expect(frame.url(), `after clicking ${target}`).toBe('about:srcdoc');
  }
  await picturesSettled(frame);
  await expectNothingEscaped(page, watched);
});

test("the chapter's frame refuses a script, a picture on another site and a link out even were one to get in", async ({
  page,
}) => {
  const watched = await openHostileBook(page);
  await expect(text(page)).toContainText('A Hare one day ridiculed');
  const frame = await frameOf(page);
  // Put in by the test, past the reader's cleaning and the frame's own builder: only the
  // frame's policy, its opaque origin and its stopping of every click stand in their way.
  await frame.evaluate((origin) => {
    const script = document.createElement('script');
    script.textContent =
      "window.__hostileRan = 'slipped in'; window.parent.__hostileRan = 'slipped in';";
    document.body.append(script);
    const image = document.createElement('img');
    image.src = `${origin}/slipped-in.png`;
    document.body.append(image);
    const evil =
      "<svg xmlns='http://www.w3.org/2000/svg'><script>window.parent.__hostileRan = 'data svg';</script></svg>";
    const math = document.createElementNS('http://www.w3.org/1998/Math/MathML', 'math');
    const link = document.createElementNS('http://www.w3.org/1998/Math/MathML', 'mtext');
    link.id = 'slipped';
    link.textContent = 'A link that slipped in';
    link.setAttribute('href', `data:image/svg+xml,${encodeURIComponent(evil)}`);
    math.append(link);
    document.body.prepend(math);
    const away = document.createElement('a');
    away.id = 'away';
    away.href = `${origin}/away`;
    away.textContent = 'A link out that slipped in';
    document.body.prepend(away);
  }, HOSTILE_ORIGIN);
  await frame.locator('#slipped').click();
  await frame.locator('#away').click();
  await picturesSettled(frame);
  await expect(text(page)).toContainText('A Hare one day ridiculed');
  await expectNothingEscaped(page, watched);
});
