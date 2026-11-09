/**
 * Two things James saw on 2026-10-18 after UI v2 slices 3b and 4: the view
 * bar's tab strip grew scrollbars, and a saved query view's builder always
 * took two thirds of the page. The strip never scrolls visibly; the query
 * folds to one line, and the fold is remembered per view on this Mac (#341).
 */
import { expect, test, type Locator, type Page } from './fixtures.ts';
import { createVault, installHost, sidebarSection } from './host.ts';

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

const TASKS_VIEW = ['---', 'atlas: view', 'type: task', 'columns: [status]', '---', ''].join('\n');

const BOARD = [
  '---',
  'atlas: view',
  'type: task',
  'layout: board',
  'groupBy: status',
  'columns: [status]',
  '---',
  '',
].join('\n');

const QUERY_VIEW = [
  '---',
  'atlas: view',
  'layout: board',
  'query: FROM task GROUP BY status',
  '---',
  '',
  '# Open work',
  '',
].join('\n');

const task = (title: string, status: string) =>
  ['---', 'type: task', `status: ${status}`, '---', '', `# ${title}`, ''].join('\n');

async function openVault(page: Page) {
  await page.setViewportSize({ width: 1280, height: 800 });
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/views');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write('.atlas/views/Tasks.md', TASKS_VIEW);
  await vault.write('.atlas/views/Tasks board.md', BOARD);
  await vault.write('.atlas/views/Open work.md', QUERY_VIEW);
  await vault.write('first.md', task('First', 'doing'));
  await vault.write('second.md', task('Second', 'done'));
  await installHost(page, vault);
  await page.goto('/');
  // Classic scrollbars, as on a Mac set to always show them: a styled
  // scrollbar takes layout space in WebKit, so any overflow shows as a bar.
  await page.addStyleTag({ content: '::-webkit-scrollbar { width: 15px; height: 15px; }' });
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return vault;
}

const views = (page: Page) => sidebarSection(page, 'views');

/** The strip's scrollable size against its box: equal when nothing can scroll. */
const overflowOf = (strip: Locator) =>
  strip.evaluate((el) => ({
    right: el.scrollWidth - el.clientWidth,
    down: el.scrollHeight - el.clientHeight,
  }));

test('the view bar’s tabs fit their strip, so no scrollbar can show', async ({ page }) => {
  await openVault(page);
  await views(page).getByRole('button', { name: 'Tasks board', exact: true }).click();
  const strip = page.getByRole('navigation', { name: 'Views' });
  await expect(strip.locator('.view-tabs__tab')).toHaveText(['Tasks board', 'Tasks']);
  await expect.poll(() => overflowOf(strip)).toEqual({ right: 0, down: 0 });
  // Even when the tabs could not fit, the strip scrolls without a bar.
  await expect(async () => {
    const scrollbars = await strip.evaluate(
      (el) => getComputedStyle(el).scrollbarWidth || getComputedStyle(el).overflowY,
    );
    expect(scrollbars).toMatch(/^(none|hidden)$/);
  }).toPass();
});

test('a saved query view opens with its query folded to one line, and remembers it unfolded', async ({
  page,
}) => {
  await openVault(page);
  const open = () => views(page).getByRole('button', { name: 'Open work', exact: true }).click();
  await open();

  const toggle = page.getByRole('button', { name: 'Edit query' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.aquery__fold-text')).toHaveText('FROM task GROUP BY status');
  // The builder is not there to tab into while the query is folded.
  await expect(page.getByRole('radiogroup', { name: 'Edit the query as' })).toHaveCount(0);
  // The answer is still drawn under it.
  await expect(
    page.getByRole('region', { name: 'doing' }).getByRole('button', { name: /^first/ }),
  ).toBeVisible();

  await toggle.click();
  const hide = page.getByRole('button', { name: 'Hide query' });
  await expect(hide).toHaveAttribute('aria-expanded', 'true');
  const controls = await hide.getAttribute('aria-controls');
  await expect(
    page.locator(`#${controls}`).getByRole('radiogroup', { name: 'Edit the query as' }),
  ).toBeVisible();

  // Away and back: the view opens as it was left.
  await views(page).getByRole('button', { name: 'Tasks', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Views' })).toBeVisible();
  await open();
  await expect(page.getByRole('button', { name: 'Hide query' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
});

test('a query view’s unsaved-changes notice sits above the query bar, not in it (#341)', async ({
  page,
}) => {
  await openVault(page);
  await views(page).getByRole('button', { name: 'Open work', exact: true }).click();
  await page
    .getByRole('radiogroup', { name: 'Layout' })
    .getByRole('radio', { name: 'Table' })
    .click();
  const notice = page.getByRole('group', { name: 'Unsaved view changes' });
  await expect(notice).toBeVisible();
  await expect(
    page.locator('.aquery__bar').getByRole('group', { name: 'Unsaved view changes' }),
  ).toHaveCount(0);
  // Above: the notice comes before the query panel in the page.
  await expect(async () => {
    const order = await notice.evaluate((el) => {
      const panel = document.querySelector('.aquery');
      return (
        panel !== null &&
        Boolean(el.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING)
      );
    });
    expect(order).toBe(true);
  }).toPass();
});
