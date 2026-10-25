import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Frame } from '@playwright/test';
import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, sidebarSection, type FakeVault } from './host.ts';
import { fablesFixtureEpub, protectedFixtureEpub } from '../tools/epub/fixture-epub.ts';

/*
 * The EPUB reader (#505), end to end in WebKit: an EPUB added from ⌘K is
 * copied into the Library with a literature note titled from its package,
 * opens in the reader, takes a highlight and a comment that land in the note
 * with a CFI and its words, and shows them again when it is opened again. A
 * transcluded EPUB highlight, and a link to one, open the reader at it —
 * found by its words when its CFI misses. A book locked with DRM is refused,
 * said plainly. The books are made for the test (tools/epub/fixture-epub.ts).
 */

const EPUB = fablesFixtureEpub();
const NOTE = 'Library/Fables of Brightwater.md';
const COPY = 'Library/fables-of-brightwater.epub';

async function openVault(
  page: Page,
  files: Record<string, string | Buffer> = {},
): Promise<FakeVault> {
  const vault = await createVault();
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(vault.root, path, '..'), { recursive: true });
    await writeFile(join(vault.root, path), contents);
  }
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  return vault;
}

async function addEpub(page: Page, { name, bytes }: { name: string; bytes: Buffer }) {
  await page.keyboard.press('Meta+k');
  await page.getByRole('searchbox', { name: 'Search the vault' }).fill('Add EPUB');
  await page.getByRole('option', { name: 'Add EPUB…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add EPUB to Library' });
  await expect(dialog).toBeVisible();
  await dialog
    .getByLabel('Choose EPUB')
    .setInputFiles({ name, mimeType: 'application/epub+zip', buffer: bytes });
  return dialog;
}

const reader = (page: Page) => page.locator('.epub-reader');
const text = (page: Page) => page.frameLocator('iframe.epub-frame').locator('body');
const panel = (page: Page) => page.getByRole('complementary', { name: 'Highlights' });

/** The chapter's frame, to run a script in as a test (the book's own never run). */
async function frameOf(page: Page): Promise<Frame> {
  const frame = await (await page.locator('iframe.epub-frame').elementHandle())?.contentFrame();
  if (frame === null || frame === undefined) throw new Error('the reader shows no chapter');
  return frame;
}

/** The chapter's frame, once it shows `words`. */
async function chapterFrame(page: Page, words: string): Promise<Frame> {
  await expect(text(page)).toContainText(words);
  return frameOf(page);
}

/** Selects `words` in the chapter on screen, as a drag would, and lets the press go. */
async function selectWords(page: Page, words: string): Promise<void> {
  // Marks are offered once the reader knows the book's literature note, which its bar then opens.
  await expect(page.getByRole('button', { name: 'Open note' })).toBeVisible();
  await expect(page.locator('.epub-reader__page[data-shown-section]')).toHaveCount(1);
  const frame = await chapterFrame(page, words);
  await frame.evaluate((picked) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const at = (node.textContent ?? '').indexOf(picked);
      if (at === -1) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + picked.length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      node.parentElement?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return;
    }
    throw new Error(`"${picked}" is not in the chapter`);
  }, words);
}

/** The words each highlight of the frame's registry under `name` covers. */
async function painted(page: Page, name: string): Promise<string[]> {
  const frame = await frameOf(page);
  return frame.evaluate((wanted) => {
    const highlight = CSS.highlights.get(wanted);
    return highlight === undefined ? [] : [...highlight].map((range) => range.toString());
  }, name);
}

/** Opens the copy from Pages, as a click on its row there does. */
async function openFromPages(page: Page): Promise<void> {
  const row = page.getByRole('treeitem', { name: 'fables-of-brightwater.epub' });
  if (!(await row.isVisible())) await page.getByRole('treeitem', { name: 'Library' }).click();
  await row.click();
}

test('an EPUB added from ⌘K is copied into the Library with its literature note, and opens', async ({
  page,
}) => {
  const vault = await openVault(page);
  const dialog = await addEpub(page, { name: 'fables-of-brightwater.epub', bytes: EPUB });
  await expect(dialog).toBeHidden();

  await expect.poll(async () => (await readFile(join(vault.root, COPY))).equals(EPUB)).toBe(true);
  await expectFile(vault, NOTE).toContain('type: literature');
  const note = await vault.read(NOTE);
  expect(note).toContain('kind: epub');
  expect(note).toContain('title: "Fables of Brightwater"');
  expect(note).toContain('author: "Mara Quill"');
  expect(note).toContain(`file: "[[${COPY}]]"`);

  await expect(reader(page)).toBeVisible();
  await expect(text(page)).toContainText('A Hare one day ridiculed the short feet');
  await expect(page.getByText('1 of 2')).toBeVisible();
});

test('words highlighted and commented in the book land in the note, and show again on reopening', async ({
  page,
}) => {
  const vault = await openVault(page);
  await addEpub(page, { name: 'fables-of-brightwater.epub', bytes: EPUB });

  await selectWords(page, 'Slow but steady wins the race.');
  await page
    .getByRole('toolbar', { name: 'Mark the selection' })
    .getByRole('button', { name: 'Highlight Green' })
    .click();
  await expectFile(vault, NOTE).toContain(
    '> Slow but steady wins the race.\n> <!-- atlas:highlight ',
  );
  const marked = await vault.read(NOTE);
  expect(marked).toContain('"kind":"epub"');
  expect(marked).toContain('"color":"green"');
  expect(marked).toMatch(/"cfi":"epubcfi\(\/6\/2[^"]*!\/4\/[^"]+\)"/);
  await expect(panel(page).getByText('Slow but steady wins the race.')).toBeVisible();
  await expect
    .poll(() => painted(page, 'dfai-highlight-green'))
    .toEqual(['Slow but steady wins the race.']);

  await panel(page).getByRole('button', { name: 'Add comment' }).click();
  await panel(page).getByRole('textbox', { name: 'Comment' }).fill('The moral, again.');
  await panel(page).getByRole('button', { name: 'Save' }).click();
  await expectFile(vault, NOTE).toMatch(/-->\n>\n> The moral, again\.\n\n\^[a-z0-9]{6}\n$/);

  // Opened again from Pages after a reload: the highlight is found again where its CFI points.
  await page.reload();
  await openFromPages(page);
  await expect(reader(page)).toBeVisible();
  await expect(panel(page).getByText('The moral, again.')).toBeVisible();
  await expect(panel(page).getByText("Couldn't find this passage")).toHaveCount(0);
  await expect
    .poll(() => painted(page, 'dfai-highlight-green'))
    .toEqual(['Slow but steady wins the race.']);
});

test('an underline and a comment made from the selection, and a highlight deleted after asking', async ({
  page,
}) => {
  const vault = await openVault(page);
  await addEpub(page, { name: 'fables-of-brightwater.epub', bytes: EPUB });
  await expectFile(vault, NOTE).toContain('kind: epub');
  const before = await vault.read(NOTE);

  await selectWords(page, 'fell fast asleep');
  const toolbar = page.getByRole('toolbar', { name: 'Mark the selection' });
  await toolbar.getByRole('button', { name: 'Comment' }).click();
  await toolbar.getByRole('textbox', { name: 'Comment' }).fill('The nap that lost it.');
  await toolbar.getByRole('button', { name: 'Save comment' }).click();
  await expectFile(vault, NOTE).toContain('> The nap that lost it.\n');

  await selectWords(page, 'slow but steady pace');
  await toolbar.getByRole('button', { name: 'Underline' }).click();
  await expectFile(vault, NOTE).toContain('"mark":"underline"');
  await expect.poll(() => painted(page, 'dfai-underline-yellow')).toEqual(['slow but steady pace']);

  for (let left = 2; left > 0; left -= 1) {
    await expect(panel(page).getByRole('button', { name: 'Delete…' })).toHaveCount(left);
    await panel(page).getByRole('button', { name: 'Delete…' }).first().click();
    await panel(page)
      .getByRole('group', { name: 'Delete this highlight?' })
      .getByRole('button', { name: 'Delete' })
      .click();
  }
  await expectFile(vault, NOTE).toBe(before);
});

test('the contents, the chapter turns, find in the book and the text size', async ({ page }) => {
  await openVault(page);
  await addEpub(page, { name: 'fables-of-brightwater.epub', bytes: EPUB });
  await expect(text(page)).toContainText('A Hare one day');

  await page.getByRole('button', { name: 'Contents' }).click();
  await page
    .getByRole('navigation', { name: 'Contents' })
    .getByRole('button', { name: 'The Ant and the Grasshopper' })
    .click();
  await expect(text(page)).toContainText('In a field one summer');
  await expect(page.getByText('2 of 2')).toBeVisible();
  await page.getByRole('button', { name: 'Previous chapter' }).click();
  await expect(text(page)).toContainText('A Hare one day');

  await page.getByRole('button', { name: 'Find', exact: true }).click();
  const find = page.getByRole('searchbox', { name: 'Find in document' });
  await find.fill('grasshopper');
  const found = page.getByRole('search');
  await expect(found.getByText('1 of 3')).toBeVisible();
  await expect(text(page)).toContainText('In a field one summer');
  await expect.poll(() => painted(page, 'dfai-found-current')).toEqual(['Grasshopper']);
  await expect.poll(async () => (await painted(page, 'dfai-found')).length).toBe(2);
  await find.press('Enter');
  await expect(found.getByText('2 of 3')).toBeVisible();

  await page.getByRole('button', { name: 'Larger text' }).click();
  await expect(page.getByText('110%')).toBeVisible();
  const frame = await frameOf(page);
  await expect
    .poll(() => frame.evaluate(() => getComputedStyle(document.documentElement).fontSize))
    .not.toBe('16px');
});

test('a book locked with DRM is refused, said plainly, and nothing is added', async ({ page }) => {
  const vault = await openVault(page);
  const dialog = await addEpub(page, { name: 'locked.epub', bytes: protectedFixtureEpub() });
  await expect(dialog.getByRole('alert')).toHaveText(
    "“locked.epub” is protected with DRM, so DFAI can't open it. Books from the Kindle store, Apple Books and Kobo usually are; a DRM-free copy of the book opens.",
  );
  expect(existsSync(join(vault.root, 'Library/locked.epub'))).toBe(false);
  expect(existsSync(join(vault.root, 'Library/A Locked Book.md'))).toBe(false);
});

/** A highlight of the fables' second chapter whose CFI names no place the book has: found by its words, in another chapter. */
const STALE = JSON.stringify({
  v: 1,
  mark: 'highlight',
  color: 'blue',
  kind: 'epub',
  // Names a place in the first fable the book does not have; the words are in the second.
  cfi: 'epubcfi(/6/2!/4/99/1:0)',
  exact: 'When the winter came the Grasshopper had no food',
  prefix: 'to do the same.” ',
  suffix: ' and found itself',
});
const LITERATURE =
  `---\ntype: literature\nkind: epub\ntitle: "Fables of Brightwater"\nauthor: "Mara Quill"\nfile: "[[${COPY}]]"\n---\n` +
  `> When the winter came the Grasshopper had no food\n> <!-- atlas:highlight ${STALE} -->\n\n^wint01\n`;
const READING =
  '# Reading notes\n\n![[Fables of Brightwater#^wint01]]\n\nSee [[fables-of-brightwater.epub#^wint01]].\n';

async function openReadingNotes(page: Page): Promise<FakeVault> {
  const vault = await openVault(page, {
    [COPY]: EPUB,
    [NOTE]: LITERATURE,
    'Reading notes.md': READING,
  });
  await sidebarSection(page, 'userSpace')
    .getByRole('treeitem', { name: 'Reading notes', exact: true })
    .click();
  await expect(page.getByRole('article', { name: 'Reading notes' })).toBeVisible();
  return vault;
}

test("a transcluded EPUB highlight's chip opens the reader at it, found by its words", async ({
  page,
}) => {
  await openReadingNotes(page);
  const chip = page.getByRole('link', { name: 'Open Fables of Brightwater in the reader' });
  await expect(chip).toHaveAttribute('data-hue', 'green');
  await chip.click();
  await expect(reader(page)).toBeVisible();
  await expect(text(page)).toContainText('In a field one summer');
  await expect(page.getByText('2 of 2')).toBeVisible();
  await expect
    .poll(() => painted(page, 'dfai-highlight-blue'))
    .toEqual(['When the winter came the Grasshopper had no food']);
  await expect(panel(page).getByText('When the winter came')).toBeVisible();
  await expect(panel(page).getByText("Couldn't find this passage")).toHaveCount(0);
});

test('a link to the EPUB at a highlight opens the reader at it', async ({ page }) => {
  await openReadingNotes(page);
  await page
    .getByRole('article', { name: 'Reading notes' })
    .locator('.editor [data-wikilink="fables-of-brightwater.epub"]')
    .click();
  await expect(reader(page)).toBeVisible();
  await expect(page.getByText('2 of 2')).toBeVisible();
  await expect.poll(() => painted(page, 'dfai-highlight-blue')).toHaveLength(1);
});
