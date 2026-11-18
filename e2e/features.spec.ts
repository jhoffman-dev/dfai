import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, type FakeVault } from './host.ts';
import { lanternFixturePdf } from '../tools/pdf/fixture-pdf.ts';

/*
 * Settings → Features (#901, slice 1): Reading switched off leaves the
 * sidebar and ⌘K, a PDF reached any way shows a notice in its tab rather than
 * the reader, the notice leads to the switch, and switching it on brings it
 * all back. The choice is the vault's, in `.atlas/settings.md`, so it
 * survives a reload. Nothing is deleted and no tab is closed.
 */

const PDF = 'Library/the-lantern-keepers.pdf';
const SETTINGS = '.atlas/settings.md';
const READING_COMMANDS = ['Add PDF…', 'Add EPUB…', 'Library', 'All highlights'];

async function openVault(page: Page, { readingOff = false } = {}): Promise<FakeVault> {
  const vault = await createVault();
  await vault.write('Garden.md', '# Garden\n\nBeans.\n');
  await mkdir(join(vault.root, 'Library'), { recursive: true });
  await writeFile(join(vault.root, PDF), lanternFixturePdf());
  if (readingOff) {
    await vault.mkdir('.atlas');
    await vault.write(SETTINGS, '---\nfeaturesOff: [reading]\n---\n');
  }
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return vault;
}

const sidebarRow = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Vault' }).getByRole('button', { name, exact: true });

/** The palette's options for `query`, with the palette open. */
async function paletteFor(page: Page, query: string) {
  await page.keyboard.press('Meta+k');
  await page.getByRole('searchbox', { name: 'Search the vault' }).fill(query);
  return page.getByRole('option', { name: query, exact: true });
}

async function closePalette(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('searchbox', { name: 'Search the vault' })).toBeHidden();
}

/** Each of Reading's four commands is offered, or none is. */
async function expectReadingCommands(page: Page, offered: boolean): Promise<void> {
  for (const command of READING_COMMANDS) {
    const option = await paletteFor(page, command);
    await expect(option).toHaveCount(offered ? 1 : 0);
    await closePalette(page);
  }
}

async function expectReadingRows(page: Page, shown: boolean): Promise<void> {
  for (const name of ['Library', 'All highlights']) {
    await expect(sidebarRow(page, name)).toHaveCount(shown ? 1 : 0);
  }
}

const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings' });
const readingSwitch = (page: Page) => settings(page).getByRole('switch', { name: 'Reading' });

async function switchReading(page: Page, on: boolean): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(readingSwitch(page)).toBeEnabled();
  await readingSwitch(page).click();
  await expect(readingSwitch(page)).toHaveAttribute('aria-checked', String(on));
  await page.keyboard.press('Escape');
  await expect(settings(page)).toBeHidden();
}

async function openPdfFromPages(page: Page): Promise<void> {
  const row = page.getByRole('treeitem', { name: 'the-lantern-keepers.pdf', exact: true });
  if (!(await row.isVisible())) await page.getByRole('treeitem', { name: 'Library' }).click();
  await row.click();
}

const notice = (page: Page) =>
  page.getByRole('status').filter({ hasText: 'Reading is turned off' });
const reader = (page: Page) => page.locator('.pdf-reader');
const tabs = (page: Page) => page.getByRole('tablist', { name: 'Pane 1 tabs' }).getByRole('tab');

test('Reading switched off leaves the sidebar and ⌘K, for this vault, across a reload', async ({
  page,
}) => {
  const vault = await openVault(page);
  await expectReadingRows(page, true);
  await expectReadingCommands(page, true);

  await switchReading(page, false);
  await expectReadingRows(page, false);
  await expectReadingCommands(page, false);
  await expectFile(vault, SETTINGS).toContain('featuresOff:');
  await expectFile(vault, SETTINGS).toMatch(/featuresOff:\s*\n\s*- reading/);

  // A reload stands in for quitting and relaunching.
  await page.reload();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await expectReadingRows(page, false);
  await expectReadingCommands(page, false);

  await switchReading(page, true);
  await expectReadingRows(page, true);
  await expectReadingCommands(page, true);
  await expectFile(vault, SETTINGS).toContain('featuresOff: []');
});

test('a PDF opened from Pages with Reading off shows the notice, which leads to the switch', async ({
  page,
}) => {
  await openVault(page, { readingOff: true });
  await expectReadingRows(page, false);

  await openPdfFromPages(page);
  await expect(notice(page)).toBeVisible();
  await expect(reader(page)).toHaveCount(0);

  await notice(page).getByRole('button', { name: 'Turn on in Settings' }).click();
  await expect(settings(page)).toBeVisible();
  await expect(settings(page).getByRole('heading', { name: 'Features' })).toBeFocused();
  await expect(readingSwitch(page)).toBeInViewport();
  await expect(readingSwitch(page)).toHaveAttribute('aria-checked', 'false');

  await readingSwitch(page).click();
  await expect(readingSwitch(page)).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(settings(page)).toBeHidden();

  // The tab the notice was in now holds the reader, and everything else is back.
  await expect(reader(page)).toBeVisible();
  await expect(notice(page)).toHaveCount(0);
  await expectReadingRows(page, true);
});

test('switching Reading off with a PDF open keeps its tab, showing the notice', async ({
  page,
}) => {
  await openVault(page);
  await openPdfFromPages(page);
  await expect(reader(page)).toBeVisible();
  const before = await tabs(page).count();
  expect(before).toBeGreaterThan(0);

  await switchReading(page, false);
  await expect(notice(page)).toBeVisible();
  await expect(reader(page)).toHaveCount(0);
  await expect(tabs(page)).toHaveCount(before);

  // The notice's way to Settings opens it at Features; Settings opened the
  // ordinary way after that opens at its top again.
  await notice(page).getByRole('button', { name: 'Turn on in Settings' }).click();
  const features = settings(page).getByRole('heading', { name: 'Features' });
  await expect(features).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(settings(page)).toBeHidden();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(settings(page).locator(':focus')).toHaveCount(1);
  await expect(features).not.toBeFocused();
});

type ManifestChunk = { file: string; src?: string; isEntry?: boolean; isDynamicEntry?: boolean };

/** Every chunk a reader's part is in or imports statically, besides the entry: read from the build. */
function readerChunks(): string[] {
  const manifest = JSON.parse(
    readFileSync(join('apps', 'desktop', 'dist', '.vite', 'manifest.json'), 'utf8'),
  ) as Record<string, ManifestChunk & { imports?: string[] }>;
  const parts = Object.values(manifest).filter(
    (chunk) =>
      chunk.isDynamicEntry === true && chunk.src?.includes('packages/shell/src/reader/') === true,
  );
  const imported = parts.flatMap((part) => part.imports ?? []).map((key) => manifest[key]);
  const files = [...parts, ...imported]
    .filter((chunk): chunk is ManifestChunk => chunk !== undefined && chunk.isEntry !== true)
    .map((chunk) => chunk.file);
  return [...new Set(files)];
}

test("a PDF tab kept with Reading off loads none of the reader's code as the app starts", async ({
  page,
}) => {
  const chunks = readerChunks();
  expect(chunks.length).toBeGreaterThan(0);
  const vault = await openVault(page);
  await openPdfFromPages(page);
  await expect(reader(page)).toBeVisible();
  await switchReading(page, false);
  await expect(notice(page)).toBeVisible();
  // Held in the file before the reload, or the window relaunches with Reading on.
  await expectFile(vault, SETTINGS).toMatch(/featuresOff:\s*\n\s*- reading/);

  const fetched: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (chunks.some((file) => path.endsWith(file))) fetched.push(path);
  });
  // A reload stands in for quitting and relaunching: the tab comes back on the PDF.
  await page.reload();
  await expect(notice(page)).toBeVisible();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await expect(reader(page)).toHaveCount(0);
  expect(fetched).toEqual([]);
});
