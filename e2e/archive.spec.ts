import { expect, test, type Page } from './fixtures.ts';
import {
  createVault,
  expectFile,
  installHost,
  pageCommand,
  sidebarSection,
  type FakeVault,
} from './host.ts';

/**
 * Phase 23 (U-22): archiving puts a note out of the way — out of Pages, views
 * and search — without losing it: the Archive lists it, search finds it when
 * asked, and Unarchive puts it back where it was with its links intact. Every
 * claim about a file reads the disk.
 */

const TASK_TYPE = [
  '---',
  'name: task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [backlog, doing, done]',
  '---',
  '',
].join('\n');

const VIEW = ['---', 'atlas: view', 'type: task', 'columns: [status]', '---', '', ''].join('\n');

const PLAN = ['---', 'type: task', 'status: done', '---', '', 'Bake the sourdough.', ''].join('\n');
const task = (status: string) =>
  ['---', 'type: task', `status: ${status}`, '---', '', ''].join('\n');

async function openArchiveVault(
  page: Page,
  archived: Record<string, string> = {},
): Promise<FakeVault> {
  const vault = await createVault();
  if (Object.keys(archived).length > 0) await vault.mkdir('Archive');
  for (const [path, text] of Object.entries(archived)) {
    await vault.mkdir(path.split('/').slice(0, -1).join('/'));
    await vault.write(path, text);
  }
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/views');
  await vault.mkdir('Projects');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write('.atlas/views/Tasks.md', VIEW);
  await vault.write('Projects/Plan.md', PLAN);
  await vault.write('Projects/Chores.md', task('doing'));
  await vault.write('Errands.md', task('backlog'));
  await vault.write('Linker.md', 'See [[Projects/Plan]] and [[Plan]].\n');
  await vault.write('Bakery.md', 'Where to buy sourdough.\n');
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return vault;
}

const pages = (page: Page) => sidebarSection(page, 'userSpace');
const row = (page: Page, name: string) => pages(page).getByRole('treeitem', { name, exact: true });
const openView = (page: Page) =>
  sidebarSection(page, 'views').getByRole('button', { name: 'Tasks', exact: true }).click();
const tableRow = (page: Page, name: string) =>
  page.locator('.table').getByRole('button', { name, exact: true });

async function search(page: Page, words: string) {
  await page.keyboard.down('Meta');
  await page.keyboard.press('k');
  await page.keyboard.up('Meta');
  await page.getByRole('searchbox', { name: 'Search the vault' }).fill(words);
  return page.getByRole('dialog', { name: 'Search notes' });
}

test('archiving a note takes it out of the way, and unarchiving puts it back with its links', async ({
  page,
}) => {
  const vault = await openArchiveVault(page);

  // It is in Pages, the view and search to begin with.
  await row(page, 'Projects').click();
  await expect(row(page, 'Plan')).toBeVisible();
  await openView(page);
  await expect(tableRow(page, 'Plan')).toBeVisible();

  // Archived from its page's menu.
  await row(page, 'Plan').click();
  await expect(page.getByRole('article', { name: 'Plan' })).toBeVisible();
  await pageCommand(page, /^Archive$/);
  await expect.poll(() => vault.exists('Projects/Plan.md')).toBe(false);
  await expectFile(vault, 'Archive/Projects/Plan.md').toMatch(
    /^---\ntype: task\nstatus: done\narchived: \d{4}-\d{2}-\d{2}\narchivedFrom: Projects\/Plan\.md\n---\n\nBake the sourdough\.\n$/,
  );
  // The link that named its path is offered, as a move offers it.
  await page.getByRole('button', { name: 'Update 1 link' }).click();
  await expectFile(vault, 'Linker.md').toBe('See [[Archive/Projects/Plan]] and [[Plan]].\n');

  // Out of Pages: its folder no longer holds it, and the Archive is one row.
  await expect(row(page, 'Chores')).toBeVisible();
  await expect(row(page, 'Plan')).toHaveCount(0);
  await expect(row(page, 'Archive')).toBeVisible();

  // Out of the view, until it is asked for.
  await openView(page);
  await expect(tableRow(page, 'Chores')).toBeVisible();
  await expect(tableRow(page, 'Plan')).toHaveCount(0);
  await page.getByRole('button', { name: 'Include archived' }).click();
  await expect(tableRow(page, 'Plan')).toBeVisible();

  // Out of search, until it is asked for. The note in use that matches is
  // waited for first, so the archived one's absence is the search's answer.
  const palette = await search(page, 'sourdough');
  await expect(palette.getByRole('option', { name: /Bakery/ })).toBeVisible();
  await expect(palette.getByRole('option', { name: /Plan/ })).toHaveCount(0);
  await palette.getByRole('switch', { name: 'Include archived' }).click();
  await expect(palette.getByRole('option', { name: /Plan/ })).toBeVisible();
  await expect(palette.getByRole('option', { name: /Plan/ })).toContainText('Archive');
  await page.keyboard.press('Escape');

  // In the Archive, with where it came from; and back from there.
  await row(page, 'Archive').click();
  const archive = page.getByRole('article', { name: 'Archive' });
  await expect(archive.getByRole('button', { name: 'Plan', exact: true })).toBeVisible();
  await expect(archive.getByText('Projects/Plan.md')).toBeVisible();
  await archive.getByRole('button', { name: 'Unarchive Plan' }).click();

  await expectFile(vault, 'Projects/Plan.md').toBe(PLAN);
  await expect.poll(() => vault.exists('Archive/Projects/Plan.md')).toBe(false);
  await expect(archive.getByText(/Nothing is archived/)).toBeVisible();
  await page.getByRole('button', { name: 'Update 1 link' }).click();
  await expectFile(vault, 'Linker.md').toBe('See [[Projects/Plan]] and [[Plan]].\n');

  // Back in Pages and the view, where it was.
  await expect(row(page, 'Plan')).toBeVisible();
  await openView(page);
  await expect(tableRow(page, 'Plan')).toBeVisible();
});

test('a view’s chosen rows are archived together, and the Archive puts them back together', async ({
  page,
}) => {
  const vault = await openArchiveVault(page);
  await openView(page);

  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Select Chores' }).check();
  await page.getByRole('checkbox', { name: 'Select Errands' }).check();
  await page.getByRole('button', { name: 'Archive 2 notes' }).click();

  await expect.poll(() => vault.exists('Archive/Projects/Chores.md')).toBe(true);
  await expect.poll(() => vault.exists('Archive/Errands.md')).toBe(true);
  await expect(tableRow(page, 'Chores')).toHaveCount(0);
  await expect(tableRow(page, 'Errands')).toHaveCount(0);
  await expect(tableRow(page, 'Plan')).toBeVisible();

  await row(page, 'Archive').click();
  const archive = page.getByRole('article', { name: 'Archive' });
  await archive.getByRole('checkbox', { name: 'Select all' }).check();
  await archive.getByRole('button', { name: 'Unarchive 2 notes' }).click();

  await expectFile(vault, 'Projects/Chores.md').toBe(task('doing'));
  await expectFile(vault, 'Errands.md').toBe(task('backlog'));
});

test('a folder is archived note by note from its row, each keeping its path', async ({ page }) => {
  const vault = await openArchiveVault(page);

  await row(page, 'Projects').hover();
  await pages(page).getByRole('button', { name: 'Options for Projects', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Archive 2 notes' }).click();

  await expect.poll(() => vault.exists('Archive/Projects/Plan.md')).toBe(true);
  await expect.poll(() => vault.exists('Archive/Projects/Chores.md')).toBe(true);
  await expect(row(page, 'Archive')).toBeVisible();
  // A batch rewrites the links it leaves behind as it goes.
  await expectFile(vault, 'Linker.md').toBe('See [[Archive/Projects/Plan]] and [[Plan]].\n');
});

test('the Archive’s columns never run into each other, however wide the window (A20-05)', async ({
  page,
}, testInfo) => {
  // A long way back: the Archive lists where a note goes back to, which is its path there (A20-06).
  const from =
    'Clients/Acme Corporation/Quarterly planning 2026/Very long folder about the roadmap and its many owners/Roadmap.md';
  await openArchiveVault(page, {
    [`Archive/${from}`]: `---\narchived: 2026-09-01\narchivedFrom: ${from}\n---\nBody.\n`,
  });
  await row(page, 'Archive').click();
  const archive = page.getByRole('article', { name: 'Archive' });
  await expect(archive.getByRole('button', { name: 'Roadmap', exact: true })).toBeVisible();

  // Where each cell's text is painted: its extent, cut by any box that clips it.
  const painted = () =>
    archive.locator('tbody tr').evaluateAll((rows) =>
      rows.map((tr) =>
        [...tr.querySelectorAll('td')].slice(1).map((cell) => {
          const range = document.createRange();
          range.selectNodeContents(cell);
          let { left, right } = range.getBoundingClientRect();
          const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
          const text = walker.nextNode()?.parentElement ?? cell;
          for (let box: Element | null = text; box !== null; box = box.parentElement) {
            const style = getComputedStyle(box);
            if (style.overflowX !== 'visible') {
              // Text is clipped at the content box: the padding stays empty.
              const clip = box.getBoundingClientRect();
              left = Math.max(left, clip.left + parseFloat(style.paddingLeft));
              right = Math.min(right, clip.right - parseFloat(style.paddingRight));
            }
            if (box === cell) break;
          }
          return { left, right };
        }),
      ),
    );

  for (const width of [1440, 1100, 820]) {
    await page.setViewportSize({ width, height: 800 });
    const rows = await painted();
    expect(rows.length).toBeGreaterThan(0);
    for (const cells of rows) {
      for (let at = 1; at < cells.length; at += 1) {
        // A readable gap between one column's text and the next, not text touching text.
        expect(
          cells[at]!.left - cells[at - 1]!.right,
          `column ${at} runs into ${at + 1} at ${width}px`,
        ).toBeGreaterThanOrEqual(12);
      }
    }
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((name) => (document.documentElement.dataset['theme'] = name), theme);
      await page.screenshot({ path: testInfo.outputPath(`archive-${theme}-${width}.png`) });
    }
  }
});
