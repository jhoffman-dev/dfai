import type { Frame } from '@playwright/test';
import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost } from './host.ts';
import { fixtureEpub, HARE_AND_TORTOISE, HOSTILE_ORIGIN } from '../tools/epub/fixture-epub.ts';

/*
 * From the third verification of PR #536 (#505, ADR-0045), end to end in
 * WebKit. A chapter's SVG presentation attributes are read by WebKit as CSS,
 * and the reader's cleaning of them misses spellings WebKit fetches. And the
 * cleaning of a book's CSS runs in the app's own window, before the chapter
 * shows: CSS the browser's parser or the cleaning reads in more than linear
 * time freezes the app for minutes, well inside the 2 MiB a sheet may be.
 */

/** How long a chapter, however its CSS is written, may take to show; it takes well under a second. */
const SHOWN_WITHIN = 15_000;

async function openBook(page: Page, bytes: Buffer): Promise<{ hits: string[] }> {
  const hits: string[] = [];
  await page.route(`${HOSTILE_ORIGIN}/**`, (route) => {
    hits.push(route.request().url());
    return route.abort();
  });
  const vault = await createVault();
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await page.keyboard.press('Meta+k');
  await page.getByRole('searchbox', { name: 'Search the vault' }).fill('Add EPUB');
  await page.getByRole('option', { name: 'Add EPUB…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add EPUB to Library' });
  await dialog
    .getByLabel('Choose EPUB')
    .setInputFiles({ name: 'styled.epub', mimeType: 'application/epub+zip', buffer: bytes });
  await expect(dialog).toBeHidden({ timeout: SHOWN_WITHIN });
  await expect(page.locator('.epub-reader__page[data-shown-section]')).toHaveCount(1, {
    timeout: SHOWN_WITHIN,
  });
  return { hits };
}

const text = (page: Page) => page.frameLocator('iframe.epub-frame').locator('body');

async function frameOf(page: Page): Promise<Frame> {
  const frame = await (await page.locator('iframe.epub-frame').elementHandle())?.contentFrame();
  if (frame === null || frame === undefined) throw new Error('the reader shows no chapter');
  return frame;
}

test("an SVG presentation attribute keeps no other site's address, however CSS spells it", async ({
  page,
}) => {
  const book = fixtureEpub({
    chapters: [
      {
        ...HARE_AND_TORTOISE,
        body: `${HARE_AND_TORTOISE.body}
<svg xmlns="http://www.w3.org/2000/svg" width="60" height="80">
<rect class="probe" width="60" height="20" mask="u\\72l(${HOSTILE_ORIGIN}/escaped-mask.png)"/>
<rect class="probe" y="20" width="60" height="20" mask='image-set("${HOSTILE_ORIGIN}/set-mask.png" 1x)'/>
<rect class="probe" y="40" width="60" height="20" cursor='image-set("${HOSTILE_ORIGIN}/cursor.png" 1x), auto'/>
<rect class="probe" y="60" width="60" height="20" mask="url(${HOSTILE_ORIGIN}/unclosed-mask.png"/>
</svg>`,
      },
    ],
  });
  const { hits } = await openBook(page, book);
  const frame = await frameOf(page);
  await expect(text(page)).toContainText('Slow but steady wins the race.');
  const attributes = await frame.evaluate(() =>
    [...document.querySelectorAll('.probe')].map((rect) =>
      [...rect.attributes].map((a) => `${a.name}=${a.value}`).join(' '),
    ),
  );
  expect(attributes).toHaveLength(4);
  expect(attributes.join('\n')).not.toContain('beacon.example.com');
  await frame.locator('.probe').nth(2).hover();
  await page.waitForLoadState('networkidle');
  expect(hits).toEqual([]);
});

test('a stylesheet nesting 400,000 brackets in one value does not keep the chapter from showing', async ({
  page,
}) => {
  test.setTimeout(120_000);
  // WebKit's parser reads nested blocks in a value in quadratic time: 100,000 take 4.5 s.
  const book = fixtureEpub({
    chapters: [HARE_AND_TORTOISE],
    stylesheet: `p { background: ${'('.repeat(400_000)} }\n`,
  });
  await openBook(page, book);
  await expect(text(page)).toContainText('Slow but steady wins the race.');
});

test('a rule of 50,000 custom properties does not keep the chapter from showing', async ({
  page,
}) => {
  test.setTimeout(120_000);
  // Reading each declaration by getPropertyValue walks the rule's list in WebKit: 8,000 take 1.3 s.
  const declarations = Array.from({ length: 50_000 }, (_, at) => `--v${at}: 1;`).join(' ');
  const book = fixtureEpub({
    chapters: [HARE_AND_TORTOISE],
    stylesheet: `p { ${declarations} }\n`,
  });
  await openBook(page, book);
  await expect(text(page)).toContainText('Slow but steady wins the race.');
});

test('a stylesheet of 20,000 rules setting all: var() does not keep the chapter from showing', async ({
  page,
}) => {
  test.setTimeout(120_000);
  // `all` is 445 longhands, each read on its own: 5,000 such rules take 9 s.
  const book = fixtureEpub({
    chapters: [HARE_AND_TORTOISE],
    stylesheet: 'h1 { all: var(--unset) inherit }\n'.repeat(20_000),
  });
  await openBook(page, book);
  await expect(text(page)).toContainText('Slow but steady wins the race.');
});
