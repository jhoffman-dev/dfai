import { readFileSync } from 'node:fs';
import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, type FakeHost } from './host.ts';

/**
 * #508: Settings → Kindle and ⌘K. The host's Kindle commands are stubbed
 * (`host.ts`): Connect makes the session at once and each notebook page is
 * answered from the domain's hand-made fixtures (public-domain books,
 * invented highlights). The sign-in window, its WebKit store and the hidden
 * window are AppKit's and on the PR's manual checklist. Each sync waits the
 * real 1.5 s between fetches, so a sync here takes some seconds.
 */

test.slow();

const fixture = (name: string) =>
  readFileSync(new URL(`../packages/domain/src/kindle/fixtures/${name}`, import.meta.url), 'utf8');

const BOOK = 'Library/Pride and Prejudice.md';
const NEXT_PAGE_TOKEN = 'CgUIAhCeAg';

/** A book's one page of annotations with none on it. */
const noAnnotations = (asin: string) =>
  `<input class="kp-notebook-annotations-next-page-start" value=""><input id="kp-notebook-annotations-asin" value="${asin}"><div id="kp-notebook-annotations"></div>`;

/** The last page of the first book, with one more highlight than the fixture has. */
const lastPageWithOneMore = () =>
  fixture('annotations-page-2.html').replace(
    '    </div>\n  </div>\n</div>',
    `      <div id="QTBFWEFNUExFMTpBNzpISUdITElHSFQ" class="a-row a-spacing-base">
        <input type="hidden" value="5300" id="kp-annotation-location">
        <span id="annotationHighlightHeader">Yellow highlight | Location:&nbsp;5,300</span>
        <div class="kp-notebook-highlight kp-notebook-highlight-yellow"><span id="highlight">A lady's imagination is very rapid.</span></div>
        <div id="note-QTBFWEFNUExFMTpBNzpISUdITElHSFQ"><span id="note"></span></div>
      </div>
    </div>
  </div>
</div>`,
  );

function serveNotebook(host: FakeHost, lastPage = fixture('annotations-page-2.html')) {
  host.kindle.serveLibrary(fixture('library.html'));
  host.kindle.serveAnnotations('B0EXAMPLE1', '', fixture('annotations-page-1.html'));
  host.kindle.serveAnnotations('B0EXAMPLE1', NEXT_PAGE_TOKEN, lastPage);
  host.kindle.serveAnnotations('B0EXAMPLE2', '', noAnnotations('B0EXAMPLE2'));
  host.kindle.serveAnnotations('B0EXAMPLE3', '', noAnnotations('B0EXAMPLE3'));
}

const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings' });
const card = (page: Page) => settings(page).getByRole('region', { name: 'Kindle' });
const intoVault = (page: Page) =>
  card(page).getByRole('switch', { name: 'Sync Kindle into this vault' });

/** Turns Kindle sync on for the open vault, in Settings, and closes Settings. */
async function turnOnForThisVault(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await intoVault(page).click();
  await expect(intoVault(page)).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
}

async function openVault(page: Page) {
  const vault = await createVault();
  await vault.write('note.md', '# Note\n\nBody.\n');
  const host = await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return { vault, host };
}

async function runCommand(page: Page, label: string) {
  await page.keyboard.press('Meta+k');
  await page.getByRole('searchbox', { name: 'Search the vault' }).fill(label);
  await page.getByRole('option', { name: label }).click();
}

/** How many times `words` appear in the note. */
const count = (text: string | undefined, words: string) => (text ?? '').split(words).length - 1;

test('Connect syncs the books into literature notes, and a second sync adds only the new highlight', async ({
  page,
}) => {
  const { vault, host } = await openVault(page);
  serveNotebook(host);

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(card(page).getByTestId('kindle-sync')).toHaveText('Not connected on this Mac');
  // Off in every vault until it is turned on for this one.
  await expect(intoVault(page)).toHaveAttribute('aria-checked', 'false');
  await intoVault(page).click();
  await expect(intoVault(page)).toHaveAttribute('aria-checked', 'true');
  // Off until connected: nothing was fetched on open.
  expect(host.kindle.fetches()).toEqual([]);
  await card(page).getByRole('button', { name: 'Connect Kindle' }).click();

  await expect(card(page).getByTestId('kindle-sync')).toContainText(
    'Added 6 highlights from 1 book.',
    { timeout: 30_000 },
  );
  expect(host.kindle.connected()).toBe(true);
  await expectFile(vault, BOOK).toContain('kind: kindle');
  const first = await vault.read(BOOK);
  expect(first).toContain('asin: "B0EXAMPLE1"');
  expect(first).toContain('Till this moment I never knew myself.');
  expect(count(first, 'atlas:highlight')).toBe(5);
  // The other books had nothing to add, so no note was made for them.
  expect(await vault.exists('Library/Moby-Dick; or, The Whale.md')).toBe(false);

  serveNotebook(host, lastPageWithOneMore());
  await page.keyboard.press('Escape');
  await runCommand(page, 'Sync Kindle now');
  await expect(page.getByText('Added 1 highlight from 1 book.').first()).toBeVisible({
    timeout: 30_000,
  });
  await expectFile(vault, BOOK).toContain("A lady's imagination is very rapid.");
  const second = await vault.read(BOOK);
  expect(count(second, 'atlas:highlight')).toBe(6);
  // Once in the quote and once as Kindle's words in its marker, as after the first sync.
  expect(count(second, 'Till this moment I never knew myself.')).toBe(2);
  // What the first sync wrote is kept byte for byte, the new block after it.
  expect(second?.startsWith(first ?? '-')).toBe(true);
});

test('a lapsed Amazon session says plainly that Kindle sync needs a sign-in', async ({ page }) => {
  const { vault, host } = await openVault(page);
  serveNotebook(host);
  await turnOnForThisVault(page);
  await runCommand(page, 'Connect Kindle');
  await expect(page.getByText('Added 6 highlights from 1 book.').first()).toBeVisible({
    timeout: 30_000,
  });
  const before = await vault.read(BOOK);
  expect(before).toContain('kind: kindle');

  host.kindle.signOut();
  await runCommand(page, 'Sync Kindle now');
  await expect(page.getByText('Kindle sync needs you to sign in again.').first()).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(card(page).getByTestId('kindle-sync')).toContainText(
    'Kindle sync needs you to sign in again.',
  );
  expect(await vault.read(BOOK)).toBe(before);

  await card(page).getByRole('button', { name: 'Disconnect' }).click();
  await expect(card(page).getByRole('button', { name: 'Connect Kindle' })).toBeVisible();
  expect(host.kindle.connected()).toBe(false);
});

test('in a vault Kindle sync is not on for, Connect and Sync now write nothing and say how to turn it on', async ({
  page,
}) => {
  const { vault, host } = await openVault(page);
  serveNotebook(host);
  await runCommand(page, 'Connect Kindle');
  await expect(page.getByText(/Turn on .Sync Kindle into this vault./).first()).toBeVisible();
  expect(host.kindle.connected()).toBe(true);

  await runCommand(page, 'Sync Kindle now');
  await expect(page.getByText(/Turn on .Sync Kindle into this vault./).first()).toBeVisible();
  expect(host.kindle.fetches()).toEqual([]);
  expect(await vault.exists(BOOK)).toBe(false);
});
