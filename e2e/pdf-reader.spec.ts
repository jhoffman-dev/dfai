import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, type FakeVault } from './host.ts';
import { lanternFixturePdf } from '../tools/pdf/fixture-pdf.ts';

/*
 * The PDF reader (#504), end to end in WebKit: a PDF added from ⌘K is copied
 * into the Library with its literature note, opens in the reader, takes a
 * highlight and a comment that land in the note, and shows them again when
 * it is opened again. The PDF is made for the test (tools/pdf/fixture-pdf.ts).
 */

const PDF = lanternFixturePdf();
const NOTE = 'Library/The Lantern Keepers.md';
const COPY = 'Library/the-lantern-keepers.pdf';

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

async function addFixturePdf(page: Page): Promise<void> {
  await page.keyboard.press('Meta+k');
  await page.getByRole('searchbox', { name: 'Search the vault' }).fill('Add PDF');
  await page.getByRole('option', { name: 'Add PDF…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add PDF to Library' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Choose PDF').setInputFiles({
    name: 'the-lantern-keepers.pdf',
    mimeType: 'application/pdf',
    buffer: PDF,
  });
  await expect(dialog).toBeHidden();
}

const reader = (page: Page) => page.locator('.pdf-reader');

/** Opens the fixture's copy from Pages, as a click on its row there does. */
async function openFromPages(page: Page): Promise<void> {
  const row = page.getByRole('treeitem', { name: 'the-lantern-keepers.pdf' });
  if (!(await row.isVisible())) await page.getByRole('treeitem', { name: 'Library' }).click();
  await row.click();
}

/** Scrolls the reader's pages until page `number` is drawn. */
async function scrollToPage(page: Page, number: number): Promise<void> {
  await expect
    .poll(async () => {
      await page.locator('.pdf-reader__pages').evaluate((pages) => pages.scrollBy(0, 400));
      return pageOf(page, number).count();
    })
    .toBeGreaterThan(0);
  await pageOf(page, number).scrollIntoViewIfNeeded();
}
const pageOf = (page: Page, number: number) => page.locator(`[data-pdf-page="${number}"]`);

/** Selects `words` where a run of page `number`'s text layer starts with them, as a drag would. */
async function selectWords(page: Page, number: number, words: string): Promise<void> {
  // Marks are offered once the reader knows the PDF's literature note, which its bar then opens.
  await expect(page.getByRole('button', { name: 'Open note' })).toBeVisible();
  const run = pageOf(page, number).locator('.pdf-text__run', { hasText: words }).first();
  await expect(run).toBeVisible();
  await run.evaluate((span, picked) => {
    const text = span.firstChild as Text;
    const start = (text.textContent ?? '').indexOf(picked);
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, start + picked.length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    span.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }, words);
}

test('a PDF added from ⌘K is copied into the Library with its literature note, and opens', async ({
  page,
}) => {
  const vault = await openVault(page);
  await addFixturePdf(page);

  await expect.poll(async () => (await readFile(join(vault.root, COPY))).equals(PDF)).toBe(true);
  await expectFile(vault, NOTE).toContain('type: literature');
  const note = await vault.read(NOTE);
  expect(note).toContain('kind: pdf');
  expect(note).toContain('title: "The Lantern Keepers"');
  expect(note).toContain('author: "Mara Quill"');
  expect(note).toContain(`file: "[[${COPY}]]"`);

  await expect(reader(page)).toBeVisible();
  await expect(page.getByText('4 pages')).toBeVisible();
  await expect(pageOf(page, 1).locator('.pdf-text__run').first()).toHaveText(
    'Chapter One. The keepers of Brightwater lit the lamps at dusk.',
  );
});

test('words highlighted and commented in the reader land in the note, and show again on reopening', async ({
  page,
}) => {
  const vault = await openVault(page);
  await addFixturePdf(page);

  await selectWords(page, 1, 'A light kept is a promise kept');
  await page
    .getByRole('toolbar', { name: 'Mark the selection' })
    .getByRole('button', { name: 'Highlight Green' })
    .click();
  await expectFile(vault, NOTE).toContain(
    '> A light kept is a promise kept\n> <!-- atlas:highlight ',
  );
  expect(await vault.read(NOTE)).toContain('"color":"green"');
  const panel = page.getByRole('complementary', { name: 'Highlights' });
  await expect(panel.getByText('A light kept is a promise kept')).toBeVisible();
  await expect(pageOf(page, 1).locator('.pdf-mark--green')).toHaveCount(1);

  await panel.getByRole('button', { name: 'Add comment' }).click();
  await panel.getByRole('textbox', { name: 'Comment' }).fill('Said again in chapter two.');
  await panel.getByRole('button', { name: 'Save' }).click();
  await expectFile(vault, NOTE).toMatch(
    /-->\n>\n> Said again in chapter two\.\n\n\^[a-z0-9]{6}\n$/,
  );

  // Opened again from Pages after a reload: the highlight is found again by its words.
  await page.reload();
  await openFromPages(page);
  await expect(reader(page)).toBeVisible();
  const again = page.getByRole('complementary', { name: 'Highlights' });
  await expect(again.getByText('Said again in chapter two.')).toBeVisible();
  await expect(again.getByText("Couldn't find the exact spot")).toHaveCount(0);
  await expect(pageOf(page, 1).locator('.pdf-mark--green')).toHaveCount(1);
});

test('a comment made from the selection, and a highlight deleted after asking, leave the note right', async ({
  page,
}) => {
  const vault = await openVault(page);
  await addFixturePdf(page);
  const before = await vault.read(NOTE);

  await selectWords(page, 2, 'Fog came in from the north channel');
  const toolbar = page.getByRole('toolbar', { name: 'Mark the selection' });
  await toolbar.getByRole('button', { name: 'Comment' }).click();
  await toolbar.getByRole('textbox', { name: 'Comment' }).fill('Spring fog.');
  await toolbar.getByRole('button', { name: 'Save comment' }).click();
  await expectFile(vault, NOTE).toContain('> Spring fog.\n');

  const panel = page.getByRole('complementary', { name: 'Highlights' });
  await panel.getByRole('button', { name: 'Delete…' }).click();
  await panel
    .getByRole('group', { name: 'Delete this highlight?' })
    .getByRole('button', { name: 'Delete' })
    .click();
  await expectFile(vault, NOTE).toBe(before);
});

test('a box dragged on a scanned page becomes an area highlight with its picture', async ({
  page,
}) => {
  const vault = await openVault(page);
  await addFixturePdf(page);

  await scrollToPage(page, 4);
  const scan = pageOf(page, 4);
  const area = scan.locator('.pdf-area');
  await expect(area).toBeVisible();
  const box = await area.boundingBox();
  if (box === null) throw new Error('the scanned page is not on screen');
  await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.45, { steps: 4 });
  await page.mouse.up();
  await page
    .getByRole('toolbar', { name: 'Mark the selection' })
    .getByRole('button', { name: 'Highlight Yellow' })
    .click();

  await expectFile(vault, NOTE).toContain('> ![[attachments/the-lantern-keepers p4 area.png]]');
  const picture = await readFile(join(vault.root, 'attachments/the-lantern-keepers p4 area.png'));
  expect(picture.subarray(1, 4).toString('latin1')).toBe('PNG');
  expect((await stat(join(vault.root, COPY))).size).toBe(PDF.length);
  await expect(
    page.getByRole('complementary', { name: 'Highlights' }).getByText('Area of the page'),
  ).toBeVisible();
});

test('a highlight whose words are not in the file is listed as not found', async ({ page }) => {
  const marker = JSON.stringify({
    v: 1,
    mark: 'highlight',
    color: 'blue',
    kind: 'pdf',
    page: 9,
    exact: 'A sentence this book never had.',
    prefix: '',
    suffix: '',
    rects: [[0.1, 0.1, 0.5, 0.02]],
  });
  await openVault(page, {
    [COPY]: PDF,
    [NOTE]:
      `---\ntype: literature\nkind: pdf\ntitle: "The Lantern Keepers"\nfile: "[[${COPY}]]"\n---\n` +
      `> A sentence this book never had.\n> <!-- atlas:highlight ${marker} -->\n\n^lost01\n`,
  });
  await openFromPages(page);
  const panel = page.getByRole('complementary', { name: 'Highlights' });
  await expect(panel.getByText('A sentence this book never had.')).toBeVisible();
  await expect(panel.getByText("Couldn't find the exact spot in this file.")).toBeVisible();
});

test('find in the document counts every copy and steps through them', async ({ page }) => {
  await openVault(page);
  await addFixturePdf(page);
  await page.locator('.pdf-reader__pages').click({ position: { x: 4, y: 4 } });
  await page.keyboard.press('Meta+f');
  const find = page.getByRole('searchbox', { name: 'Find in document' });
  await find.fill('a light kept');
  await expect(page.getByText('1 of 2')).toBeVisible();
  await find.press('Enter');
  await expect(page.getByText('2 of 2')).toBeVisible();
  await expect(pageOf(page, 2).locator('.pdf-find--current')).toHaveCount(1);
});
