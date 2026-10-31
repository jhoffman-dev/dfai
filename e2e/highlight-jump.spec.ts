import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost, sidebarSection, type FakeVault } from './host.ts';
import { lanternFixturePdf } from '../tools/pdf/fixture-pdf.ts';

/*
 * A highlight used anywhere leads back to its place (#506), end to end in
 * WebKit: a note shows a PDF's highlight and a Kindle book's; the PDF's chip
 * opens the reader at its page with the highlight drawn there (⌘-click in a
 * new tab), the Kindle one opens its note at the block, and a highlight
 * whose words are gone still opens its own page and says so.
 */

const PDF = 'Library/the-lantern-keepers.pdf';

const marker = (anchor: Record<string, unknown>) =>
  `<!-- atlas:highlight ${JSON.stringify({ v: 1, mark: 'highlight', color: 'yellow', ...anchor })} -->`;

const highlight = (id: string, quote: string, anchor: Record<string, unknown>) =>
  `> ${quote}\n> ${marker(anchor)}\n\n^${id}\n`;

const LANTERN =
  `---\ntype: literature\nkind: pdf\ntitle: "The Lantern Keepers"\nfile: "[[${PDF}]]"\n---\n` +
  highlight('lamp03', 'The last lamp was lit', {
    kind: 'pdf',
    page: 3,
    exact: 'The last lamp was lit',
    prefix: 'Chapter Three. ',
    suffix: ' in the year',
    rects: [[0.2, 0.1, 0.3, 0.02]],
  }) +
  '\n' +
  highlight('gone02', 'Words this book never had.', {
    kind: 'pdf',
    page: 2,
    exact: 'Words this book never had.',
    prefix: '',
    suffix: '',
    rects: [[0.1, 0.4, 0.5, 0.02]],
  });

const BRIGHTWATER =
  '---\ntype: literature\nkind: kindle\ntitle: "Brightwater"\nauthor: "Tobias Fenn"\n---\n' +
  `${'Filler.\n\n'.repeat(40)}` +
  highlight('kd0041', 'The tide keeps its own hours.', {
    kind: 'kindle',
    location: 41,
    locationEnd: 44,
  });

const READING =
  '# Reading notes\n\n![[The Lantern Keepers#^lamp03]]\n\n![[Brightwater#^kd0041]]\n\n' +
  '![[The Lantern Keepers#^gone02]]\n\nSee [[The Lantern Keepers#^lamp03]] and [[the-lantern-keepers.pdf]].\n';

async function openVault(page: Page): Promise<FakeVault> {
  const vault = await createVault();
  const files: Record<string, string | Buffer> = {
    [PDF]: lanternFixturePdf(),
    'Library/The Lantern Keepers.md': LANTERN,
    'Library/Brightwater.md': BRIGHTWATER,
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
const tabs = (page: Page) => page.getByRole('tablist', { name: 'Pane 1 tabs' }).getByRole('tab');
const chip = (page: Page, name: string) => page.getByRole('link', { name });

test("a transcluded PDF highlight's chip opens the reader at its page, the highlight drawn there", async ({
  page,
}) => {
  await openVault(page);
  const lamp = chip(page, 'Open The Lantern Keepers, p. 3 in the reader');
  await expect(lamp).toBeVisible();
  await expect(lamp).toHaveAttribute('data-hue', 'red');
  await lamp.click();

  await expect(reader(page)).toBeVisible();
  await expect(tabs(page)).toHaveCount(1);
  const mark = pageOf(page, 3).locator('.pdf-mark');
  await expect(mark).toHaveCount(1);
  await expect(mark).toBeInViewport();
  const panel = page.getByRole('complementary', { name: 'Highlights' });
  await expect(panel.getByText('The last lamp was lit')).toBeVisible();
});

test('⌘-click on the chip opens the reader in a new tab, leaving the note open', async ({
  page,
}) => {
  await openVault(page);
  await chip(page, 'Open The Lantern Keepers, p. 3 in the reader').click({ modifiers: ['Meta'] });
  await expect(tabs(page)).toHaveCount(2);
  await expect(reader(page)).toBeVisible();
  await expect(pageOf(page, 3).locator('.pdf-mark')).toBeInViewport();
  await tabs(page).first().click();
  await expect(page.getByRole('article', { name: 'Reading notes' })).toBeVisible();
});

test('a Kindle highlight opens its note at the block: there is no reader for it', async ({
  page,
}) => {
  await openVault(page);
  const tide = chip(page, 'Open Brightwater, loc. 41 in its note');
  await expect(tide).toHaveAttribute('data-hue', 'orange');
  await tide.click();
  await expect(page.getByRole('article', { name: 'Brightwater' })).toBeVisible();
  await expect(reader(page)).toHaveCount(0);
  const revealed = page.locator('.editor .is-revealed');
  await expect(revealed).toContainText('The tide keeps its own hours.');
  await expect(revealed).toBeInViewport();
});

test('a link to a highlight, and a link to the PDF itself, open the reader', async ({ page }) => {
  await openVault(page);
  const note = page.getByRole('article', { name: 'Reading notes' });
  await note
    .locator('.editor [data-wikilink="The Lantern Keepers"][data-heading="#^lamp03"]')
    .last()
    .click();
  await expect(pageOf(page, 3).locator('.pdf-mark')).toBeInViewport();

  await sidebarSection(page, 'userSpace')
    .getByRole('treeitem', { name: 'Reading notes', exact: true })
    .click();
  await expect(page.getByRole('article', { name: 'Reading notes' })).toBeVisible();
  await page.locator('.editor [data-wikilink="the-lantern-keepers.pdf"]').click();
  await expect(reader(page)).toBeVisible();
  await expect(page.getByText('4 pages')).toBeVisible();
});

test("a highlight whose words are gone opens at its own page, and says it couldn't find the spot", async ({
  page,
}) => {
  await openVault(page);
  await chip(page, 'Open The Lantern Keepers, p. 2 in the reader').click();
  await expect(reader(page)).toBeVisible();
  const mark = pageOf(page, 2).locator('.pdf-mark');
  await expect(mark).toBeInViewport();
  const panel = page.getByRole('complementary', { name: 'Highlights' });
  await expect(
    panel.getByText("Couldn't find the exact spot: shown where it was when it was made."),
  ).toBeVisible();
});

test('a highlight in its own note offers "Open in PDF", which opens the reader at it', async ({
  page,
}) => {
  await openVault(page);
  await sidebarSection(page, 'userSpace').getByRole('treeitem', { name: 'Library' }).click();
  await sidebarSection(page, 'userSpace')
    .getByRole('treeitem', { name: 'The Lantern Keepers', exact: true })
    .click();
  await expect(page.getByRole('article', { name: 'The Lantern Keepers' })).toBeVisible();
  const offers = page.getByRole('link', { name: 'Open in PDF' });
  await expect(offers).toHaveCount(2);
  await offers.first().click();
  await expect(pageOf(page, 3).locator('.pdf-mark')).toBeInViewport();
});
