import { expect, test, type Page } from './fixtures.ts';
import {
  createVault,
  expectFile,
  installHost,
  saveNow,
  sidebarSection,
  splitWindow,
  type FakeVault,
} from './host.ts';
import { caretAtLineEnd } from './caret.ts';
import { literatureNote } from './research-notes.ts';

/**
 * The research area's views (#507): the Library lists every literature note
 * and filters it by kind; All highlights lists every highlight, filters them,
 * opens a row at its block, and a row dragged into a note becomes the embed
 * `![[Source#^id]]` there; ⌘K finds a highlight by its comment and opens it.
 */

const ART = literatureNote({
  title: 'The Art of War',
  author: 'Sun Tzu',
  kind: 'pdf',
  tags: ['strategy'],
  highlights: [
    {
      id: 'k3x9q2',
      quote: 'All warfare is based on deception.',
      comment: 'Compare the Larkspur pitch.',
      color: 'green',
      at: 3,
    },
    { id: 'b7c8d9', quote: 'Know the enemy and know yourself.', at: 9 },
  ],
});

const MEDITATIONS = literatureNote({
  title: 'Meditations',
  author: 'Marcus Aurelius',
  kind: 'kindle',
  highlights: [
    { id: 'm1n2o3', quote: 'The impediment to action advances action.', color: 'blue', at: 77 },
  ],
});

const PRINCE = literatureNote({
  title: 'The Little Prince',
  kind: 'epub',
  highlights: [],
});

async function openVault(page: Page): Promise<FakeVault> {
  const vault = await createVault();
  await vault.mkdir('Library');
  await vault.write('Library/The Art of War.md', ART);
  await vault.write('Library/Meditations.md', MEDITATIONS);
  await vault.write('Library/The Little Prince.md', PRINCE);
  // The same quote pasted into a plain note is no source and no highlight.
  await vault.write('Journal.md', '# Journal\n\nToday.\n\n> All warfare is based on deception.\n');
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return vault;
}

const sidebarRow = (page: Page, name: string) =>
  page.getByRole('list', { name: 'Go to' }).getByRole('button', { name, exact: true });

const library = (page: Page) => page.getByRole('article', { name: 'Library' });
const highlights = (page: Page) => page.getByRole('article', { name: 'All highlights' });
const rowsOf = (page: Page, list: 'Sources' | 'Highlights') =>
  page.getByRole('list', { name: list }).getByRole('listitem');

test('the Library lists every literature note, filters by kind, and opens a source', async ({
  page,
}) => {
  await openVault(page);
  await sidebarRow(page, 'Library').click();
  await expect(library(page)).toBeVisible();

  const rows = rowsOf(page, 'Sources');
  await expect(rows).toHaveCount(3);
  // Newest first, each with its author, kind and highlight count; the plain note is not a source.
  await expect(rows.filter({ hasText: 'The Art of War' })).toContainText('Sun Tzu');
  await expect(rows.filter({ hasText: 'The Art of War' })).toContainText('2 highlights');
  await expect(rows.filter({ hasText: 'Meditations' })).toContainText('Kindle');
  await expect(rows.filter({ hasText: 'Journal' })).toHaveCount(0);
  await expect(page.getByText('3 sources')).toBeVisible();

  await library(page)
    .getByRole('group', { name: 'Kind' })
    .getByRole('button', { name: /Kindle/ })
    .click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Meditations');
  await expect(page.getByText('1 of 3 sources')).toBeVisible();

  await library(page)
    .getByRole('group', { name: 'Kind' })
    .getByRole('button', { name: /PDF/ })
    .click();
  await expect(rows).toHaveCount(2);

  await rows.filter({ hasText: 'The Art of War' }).getByRole('button').click();
  await expect(page.getByRole('article', { name: 'The Art of War' })).toBeVisible();
});

test('All highlights lists and filters every highlight, and a row opens its note at the block', async ({
  page,
}) => {
  await openVault(page);
  await sidebarRow(page, 'All highlights').click();
  await expect(highlights(page)).toBeVisible();

  const rows = rowsOf(page, 'Highlights');
  await expect(rows).toHaveCount(3);
  await expect(rows.filter({ hasText: 'deception' })).toContainText('Compare the Larkspur pitch.');
  await expect(rows.filter({ hasText: 'deception' })).toContainText('Page 3');
  await expect(rows.filter({ hasText: 'impediment' })).toContainText('Location 77');

  const filters = highlights(page);
  await filters
    .getByRole('group', { name: 'Colour' })
    .getByRole('button', { name: /Green/ })
    .click();
  await expect(rows).toHaveCount(1);
  await filters
    .getByRole('group', { name: 'Colour' })
    .getByRole('button', { name: /Green/ })
    .click();
  await expect(rows).toHaveCount(3);

  await filters.getByRole('combobox', { name: 'Comment' }).selectOption('without');
  await expect(rows).toHaveCount(2);
  await filters.getByRole('combobox', { name: 'Comment' }).selectOption('any');
  await filters
    .getByRole('combobox', { name: 'Source' })
    .selectOption({ label: 'Meditations (1)' });
  await expect(rows).toHaveCount(1);
  await filters.getByRole('combobox', { name: 'Source' }).selectOption({ label: 'All sources' });
  await filters.getByRole('combobox', { name: 'Tag' }).selectOption('strategy');
  await expect(rows).toHaveCount(2);
  // Clear filters is there while a filter is on, and shows every highlight again.
  await filters.getByRole('button', { name: 'Clear filters' }).click();
  await expect(rows).toHaveCount(3);
  await expect(filters.getByRole('button', { name: 'Clear filters' })).toHaveCount(0);
  await filters.getByRole('combobox', { name: 'Tag' }).selectOption('strategy');
  await expect(rows).toHaveCount(2);

  // A row's accessible name says its colour, and its place among all of them.
  const deception = rows.filter({ hasText: 'deception' });
  await expect(deception.getByRole('button', { name: /^green highlight:/ })).toBeVisible();
  await expect(deception).toHaveAttribute('aria-setsize', '2');
  await deception.getByRole('button', { name: /^green highlight:/ }).click();
  const note = page.getByRole('article', { name: 'The Art of War' });
  await expect(note).toBeVisible();
  const revealed = note.locator('.editor .is-revealed');
  await expect(revealed).toHaveCount(1);
  await expect(revealed).toContainText('All warfare is based on deception.');
});

test('a highlight dragged from All highlights into a note becomes its embed there', async ({
  page,
}) => {
  const vault = await openVault(page);
  await sidebarSection(page, 'userSpace')
    .getByRole('treeitem', { name: 'Journal', exact: true })
    .click();
  await expect(page.getByRole('article', { name: 'Journal' })).toBeVisible();
  await splitWindow(page);
  await sidebarRow(page, 'All highlights').click();
  await expect(rowsOf(page, 'Highlights')).toHaveCount(3);

  const row = rowsOf(page, 'Highlights').filter({ hasText: 'deception' });
  const target = page.getByRole('article', { name: 'Journal' }).getByText('Today.');
  await caretAtLineEnd(target);
  const box = await target.boundingBox();
  if (box === null) throw new Error('the note is not on screen');
  await row.evaluate(
    (source, { x, y }) => {
      const transfer = new DataTransfer();
      source.dispatchEvent(
        new DragEvent('dragstart', { dataTransfer: transfer, bubbles: true, cancelable: true }),
      );
      const editor = document.querySelector<HTMLElement>(
        'article[aria-label="Journal"] .ProseMirror',
      );
      if (editor === null) throw new Error('no editor for Journal');
      const init = {
        dataTransfer: transfer,
        clientX: x,
        clientY: y,
        bubbles: true,
        cancelable: true,
      };
      const over = new DragEvent('dragover', init);
      editor.dispatchEvent(over);
      if (!over.defaultPrevented) throw new Error('the editor did not take the drag');
      editor.dispatchEvent(new DragEvent('drop', init));
    },
    { x: box.x + box.width, y: box.y + box.height + 6 },
  );

  const journal = page.getByRole('article', { name: 'Journal' });
  await expect(
    journal.getByRole('group', { name: 'Embedded block from The Art of War' }),
  ).toBeVisible();
  await saveNow(page, page.getByRole('region', { name: 'Pane 1' }));
  await expectFile(vault, 'Journal.md').toContain('![[The Art of War#^k3x9q2]]');
  // The source note is untouched by the drag.
  await expectFile(vault, 'Library/The Art of War.md').toBe(ART);
});

test('⌘K finds a highlight by its comment and opens its note at the block', async ({ page }) => {
  await openVault(page);
  await page.keyboard.press('Meta+k');
  const search = page.getByRole('searchbox', { name: 'Search the vault' });
  await expect(search).toBeFocused();
  await search.fill('Larkspur pitch');

  const results = page.getByRole('listbox', { name: 'Results' });
  const hit = results.getByRole('option').filter({ hasText: 'Highlight' });
  await expect(hit).toHaveCount(1);
  await expect(hit).toContainText('The Art of War');
  await hit.click();

  const note = page.getByRole('article', { name: 'The Art of War' });
  await expect(note).toBeVisible();
  await expect(note.locator('.editor .is-revealed')).toContainText(
    'All warfare is based on deception.',
  );
});

test('⌘K offers the Library and All highlights as pages to open', async ({ page }) => {
  await openVault(page);
  await page.keyboard.press('Meta+k');
  await page.getByRole('searchbox', { name: 'Search the vault' }).fill('All highl');
  await page
    .getByRole('listbox', { name: 'Results' })
    .getByRole('option', { name: /All highlights/ })
    .click();
  await expect(highlights(page)).toBeVisible();
  await page.keyboard.press('Meta+k');
  await page.getByRole('searchbox', { name: 'Search the vault' }).fill('Library');
  await page
    .getByRole('listbox', { name: 'Results' })
    .getByRole('option', { name: /^Library/ })
    .first()
    .click();
  await expect(library(page)).toBeVisible();
});
