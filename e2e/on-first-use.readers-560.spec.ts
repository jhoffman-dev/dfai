import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page, type Route } from './fixtures.ts';
import { createVault, installHost } from './host.ts';
import { lanternFixturePdf } from '../tools/pdf/fixture-pdf.ts';
import { fablesFixtureEpub } from '../tools/epub/fixture-epub.ts';

/*
 * The readers' chunks failing during the background preload (#552, #560), in
 * the style of `on-first-use.attack-271.spec.ts`: every chunk the PDF and EPUB
 * readers are drawn from fails until the test lets it through, and then both
 * readers must open, with or without a Reload. A chunk a reader's part
 * imports statically is not fetched again under the part's fresh address, so
 * one that failed would keep the reader broken.
 */

const PDF = 'Library/the-lantern-keepers.pdf';
const EPUB = 'Library/fables-of-brightwater.epub';

type ManifestChunk = { file: string; src?: string; isEntry?: boolean; isDynamicEntry?: boolean };

/** Every chunk a reader's part is in or imports statically, besides the entry: read from the build. */
function readerChunks(): string[] {
  const manifest = JSON.parse(
    readFileSync(join('apps', 'desktop', 'dist', '.vite', 'manifest.json'), 'utf8'),
  ) as Record<string, ManifestChunk & { imports?: string[] }>;
  const parts = Object.values(manifest).filter(
    (chunk) => chunk.isDynamicEntry === true && chunk.src?.startsWith('src/reader/') === true,
  );
  const imported = parts.flatMap((part) => part.imports ?? []).map((key) => manifest[key]);
  const files = [...parts, ...imported]
    .filter((chunk): chunk is ManifestChunk => chunk !== undefined && chunk.isEntry !== true)
    .map((chunk) => chunk.file);
  return [...new Set(files)];
}

const READER_CHUNKS = readerChunks();
const isReaderChunk = (url: string | URL) =>
  READER_CHUNKS.some((file) => new URL(url).pathname.endsWith(file));

async function openVault(page: Page) {
  const vault = await createVault();
  await mkdir(join(vault.root, 'Library'), { recursive: true });
  await writeFile(join(vault.root, PDF), lanternFixturePdf());
  await writeFile(join(vault.root, EPUB), fablesFixtureEpub());
  await installHost(page, vault);
}

type Failure = 'abort' | 'truncate';

/** Fails every reader chunk, as `failure` says, until the returned `restore` is called. */
async function failReaderChunks(page: Page, failure: Failure): Promise<() => void> {
  let failing = true;
  await page.route(isReaderChunk, async (route: Route) => {
    if (!failing) return route.continue();
    if (failure === 'abort') return route.abort();
    const response = await route.fetch();
    const body = await response.text();
    // A download interrupted halfway: the module fails to parse.
    return route.fulfill({ response, body: body.slice(0, Math.floor(body.length / 2)) });
  });
  return () => {
    failing = false;
  };
}

const warnings = new WeakMap<Page, number>();
function countUnloadedWarnings(page: Page) {
  page.on('console', (message) => {
    if (message.text().startsWith('A part of DFAI could not')) {
      warnings.set(page, (warnings.get(page) ?? 0) + 1);
    }
  });
}

/** Opens the vault, waiting for the background preload of the readers to have failed. */
async function start(page: Page) {
  const asked = page.waitForRequest((request) => isReaderChunk(request.url()));
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await asked;
  await expect.poll(() => warnings.get(page) ?? 0).toBeGreaterThan(0);
}

const unloaded = (page: Page) => page.getByRole('alert').filter({ hasText: 'couldn’t load' });
const pdfText = (page: Page) =>
  page.locator('.pane__tab:not([hidden]) [data-pdf-page="1"] .pdf-text__run').first();
const bookText = (page: Page) =>
  page.frameLocator('.pane__tab:not([hidden]) iframe.epub-frame').locator('body');

async function openFromPages(page: Page, name: string) {
  const row = page.getByRole('treeitem', { name, exact: true });
  if (!(await row.isVisible())) await page.getByRole('treeitem', { name: 'Library' }).click();
  await row.click();
}

/** Opens the PDF, then the EPUB, pressing a failed reader's Reload if `reload` says to. */
async function expectBothReadersOpen(page: Page, { reload }: { reload: boolean }) {
  await openFromPages(page, 'the-lantern-keepers.pdf');
  if (reload) await unloaded(page).getByRole('button', { name: 'Reload' }).click();
  await expect(pdfText(page)).toContainText('Brightwater');
  await openFromPages(page, 'fables-of-brightwater.epub');
  await expect(bookText(page)).toContainText('Hare');
  await expect(unloaded(page)).toHaveCount(0);
}

test.beforeEach(({ page }) => countUnloadedWarnings(page));

test('the build has reader chunks to fail', () => {
  expect(READER_CHUNKS.length).toBeGreaterThan(0);
});

test('readers whose chunks failed only during the background preload open once the network is back', async ({
  page,
}) => {
  await openVault(page);
  const restore = await failReaderChunks(page, 'abort');
  await start(page);
  restore();

  await expectBothReadersOpen(page, { reload: false });
});

test('after Reload brings the PDF reader back, the PDF and the EPUB both open', async ({
  page,
}) => {
  await openVault(page);
  const restore = await failReaderChunks(page, 'abort');
  await start(page);
  // Still failing when the PDF first opens: its reader says so where it would be.
  await openFromPages(page, 'the-lantern-keepers.pdf');
  await expect(unloaded(page)).toHaveCount(1);
  restore();

  await expectBothReadersOpen(page, { reload: true });
});

test('Reload recovers the readers whose chunks arrived cut short, once a whole copy can be fetched', async ({
  page,
}) => {
  await openVault(page);
  const restore = await failReaderChunks(page, 'truncate');
  await start(page);
  restore();

  // The browser keeps a module that failed to parse failed under its address: only a fresh one recovers.
  await expectBothReadersOpen(page, { reload: true });
});
