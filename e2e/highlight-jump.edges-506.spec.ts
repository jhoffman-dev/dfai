import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost, saveStatus, sidebarSection } from './host.ts';
import { lanternFixturePdf } from '../tools/pdf/fixture-pdf.ts';

/*
 * Regression (#506), end to end in WebKit: the chip from the keyboard,
 * a literature note whose `file:` is no PDF, `[[name.pdf]]` when two
 * literature notes' PDFs share the name, and an aliased link to a highlight
 * in a list item. (A table is still a raw block, so its links are not live:
 * not this PR's.)
 */

const PDF = 'Library/the-lantern-keepers.pdf';

const marker = (anchor: Record<string, unknown>) =>
  `<!-- atlas:highlight ${JSON.stringify({ v: 1, mark: 'highlight', color: 'yellow', ...anchor })} -->`;

const highlight = (id: string, quote: string) =>
  `> ${quote}\n> ${marker({
    kind: 'pdf',
    page: 3,
    exact: quote,
    prefix: 'Chapter Three. ',
    suffix: ' in the year',
    rects: [[0.2, 0.1, 0.3, 0.02]],
  })}\n\n^${id}\n`;

const literature = (title: string, file: string, id: string) =>
  `---\ntype: literature\nkind: pdf\ntitle: "${title}"\nfile: "[[${file}]]"\n---\n` +
  highlight(id, 'The last lamp was lit');

const LITERATURE = 'Library/The Lantern Keepers.md';

const READING =
  '# Reading notes\n\n![[The Lantern Keepers#^lamp03]]\n\n![[Lantern Summary Source#^sum001]]\n\n' +
  '- In a list: [[The Lantern Keepers#^lamp03|the last lamp]]\n\n' +
  'Shared name: [[reading.pdf]]\n\n' +
  'No literature note: [[loose.pdf]]\n\n' +
  'A note named like a PDF: [[Budget review.pdf]]\n\n' +
  'At a page: [[the-lantern-keepers.pdf#page=4]]\n\n' +
  'Missing: [[Nowhere.pdf]]\n\n' +
  'A spot its note does not have: [[the-lantern-keepers.pdf#^gone99]]\n';

async function openVault(page: Page) {
  const vault = await createVault();
  const files: Record<string, string | Buffer> = {
    [PDF]: lanternFixturePdf(),
    'Courses/Spring/reading.pdf': lanternFixturePdf(),
    'Courses/Autumn/reading.pdf': lanternFixturePdf(),
    [LITERATURE]: literature('The Lantern Keepers', PDF, 'lamp03'),
    // kind: pdf, but the file: it names is a Markdown note.
    'Library/Lantern Summary Source.md': literature(
      'Lantern Summary Source',
      'Library/Lantern summary.md',
      'sum001',
    ),
    'Library/Lantern summary.md': '# Lantern summary\n\nA fictional summary.\n',
    'Courses/Spring Reading.md': literature(
      'Spring Reading',
      'Courses/Spring/reading.pdf',
      'spr001',
    ),
    'Courses/Autumn Reading.md': literature(
      'Autumn Reading',
      'Courses/Autumn/reading.pdf',
      'aut001',
    ),
    'Loose/loose.pdf': lanternFixturePdf(),
    'Budget review.pdf.md': '# Budget review.pdf\n\nA fictional meeting about a document.\n',
    'Reading notes.md': READING,
  };
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(vault.root, path, '..'), { recursive: true });
    await writeFile(join(vault.root, path), contents);
  }
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await sidebarSection(page, 'userSpace')
    .getByRole('treeitem', { name: 'Reading notes', exact: true })
    .click();
  await expect(page.getByRole('article', { name: 'Reading notes' })).toBeVisible();
  return vault;
}

const reader = (page: Page) => page.locator('.pdf-reader');
const pageOf = (page: Page, number: number) => page.locator(`[data-pdf-page="${number}"]`);

test('the chip, reached with the keyboard, opens the reader on Enter', async ({ page }) => {
  await openVault(page);
  const lamp = page.getByRole('link', { name: 'Open The Lantern Keepers, p. 3 in the reader' });
  await expect(lamp).toBeVisible();
  await lamp.focus();
  await expect(lamp).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(reader(page)).toBeVisible();
});

test('a PDF literature note whose file: is a Markdown note opens its note at the highlight', async ({
  page,
}) => {
  await openVault(page);
  const chip = page.getByRole('link', { name: /^Open Lantern Summary Source, p\. 3/ });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page.getByRole('article', { name: 'Lantern Summary Source' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('[[reading.pdf]], a name two literature notes’ PDFs share, opens one of them', async ({
  page,
}) => {
  await openVault(page);
  await page.locator('.editor [data-wikilink="reading.pdf"]').click();
  await expect(reader(page)).toBeVisible();
  await expect(page.getByText('4 pages')).toBeVisible();
});

test('an aliased link to a highlight in a list item opens the reader at it', async ({ page }) => {
  await openVault(page);
  const note = page.getByRole('article', { name: 'Reading notes' });
  await note.locator('.editor li [data-wikilink="The Lantern Keepers"]').click();
  await expect(pageOf(page, 3).locator('.pdf-mark')).toBeInViewport();
});

test('[[loose.pdf]], a PDF no literature note names, opens it', async ({ page }) => {
  await openVault(page);
  await page.locator('.editor [data-wikilink="loose.pdf"]').click();
  await expect(reader(page)).toBeVisible();
  await expect(page.getByText('4 pages')).toBeVisible();
});

test('[[Budget review.pdf]] opens the note so named when the vault holds no such PDF', async ({
  page,
}) => {
  await openVault(page);
  await page.locator('.editor [data-wikilink="Budget review.pdf"]').click();
  await expect(page.getByRole('article', { name: 'Budget review.pdf' })).toBeVisible();
});

test('[[the-lantern-keepers.pdf#page=4]] opens the reader at page 4', async ({ page }) => {
  await openVault(page);
  await page
    .locator('.editor [data-wikilink="the-lantern-keepers.pdf"][data-heading="#page=4"]')
    .click();
  await expect(pageOf(page, 4)).toBeInViewport();
});

test('[[Nowhere.pdf]] says no PDF or note is called so', async ({ page }) => {
  await openVault(page);
  await page.locator('.editor [data-wikilink="Nowhere.pdf"]').click();
  await expect(page.getByRole('alert')).toContainText('No PDF or note called "Nowhere.pdf"');
});

test('[[the-lantern-keepers.pdf#^gone99]], a spot its note does not have, opens the reader and says so', async ({
  page,
}) => {
  await openVault(page);
  await page
    .locator('.editor [data-wikilink="the-lantern-keepers.pdf"][data-heading="#^gone99"]')
    .click();
  await expect(reader(page)).toBeVisible();
  await expect(page.getByRole('alert')).toContainText("Couldn't find the highlight ^gone99");
});

/*
 * Verification (#506, PR #522 after 54f53fc3): "Open in PDF" followed from
 * the keyboard with a modifier opens where it is asked and leaves the note
 * as it was. Found red: with the highlight's block selected (as it is when
 * the note opens on it), ⌘↩ and ⇧↩ reach the editor's hard-break keys,
 * which replace the block, and the note is saved without its highlight.
 */

const tabs = (page: Page) => page.getByRole('tablist', { name: 'Pane 1 tabs' }).getByRole('tab');
async function openLiteratureNote(page: Page) {
  const vault = await openVault(page);
  await sidebarSection(page, 'userSpace').getByRole('treeitem', { name: 'Library' }).click();
  await sidebarSection(page, 'userSpace')
    .getByRole('treeitem', { name: 'The Lantern Keepers', exact: true })
    .click();
  const offer = page.getByRole('link', { name: 'Open in PDF' });
  await expect(offer).toBeVisible();
  return { vault, note: page.getByRole('article', { name: 'The Lantern Keepers' }), offer };
}

/** The literature note opened again from the sidebar, as it now is. */
async function reopenLiteratureNote(page: Page) {
  await sidebarSection(page, 'userSpace')
    .getByRole('treeitem', { name: 'The Lantern Keepers', exact: true })
    .click();
  const note = page.getByRole('article', { name: 'The Lantern Keepers' });
  await expect(note).toBeVisible();
  return note;
}

// The note opens with its highlight block selected, as a note whose first block is one does.
// The keys follow the link — ⇧↩ here, ⌘↩ in a new tab — so the note is opened again to look.
for (const keys of ['Meta+Enter', 'Shift+Enter']) {
  test(`${keys} on "Open in PDF" leaves the highlight in its note`, async ({ page }) => {
    const { vault, offer } = await openLiteratureNote(page);
    const before = await vault.read(LITERATURE);
    await offer.focus();
    await page.keyboard.press(keys);
    await expect(reader(page)).toBeVisible();
    const note = await reopenLiteratureNote(page);
    await expect(note.getByText('The last lamp was lit', { exact: false })).toHaveCount(1);
    await expect(saveStatus(page)).toHaveText('Saved');
    expect(await vault.read(LITERATURE)).toBe(before);
  });
}

test('Meta+Enter on "Open in PDF" opens the reader in a new tab', async ({ page }) => {
  const { offer } = await openLiteratureNote(page);
  await offer.focus();
  await page.keyboard.press('Meta+Enter');
  await expect(tabs(page)).toHaveCount(2);
  await expect(page.locator('.pdf-reader')).toBeVisible();
});

test('keys that edit text, pressed on "Open in PDF", leave the note as it is on disk', async ({
  page,
}) => {
  const { vault, note, offer } = await openLiteratureNote(page);
  const before = await vault.read(LITERATURE);
  await offer.focus();
  for (const key of ['x', 'Backspace', 'Delete', 'Space']) await page.keyboard.press(key);
  await expect(offer).toBeFocused();
  await expect(note.getByText('The last lamp was lit', { exact: false })).toHaveCount(1);
  await expect(saveStatus(page)).toHaveText('Saved');
  expect(await vault.read(LITERATURE)).toBe(before);
});
