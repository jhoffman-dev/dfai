import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, sidebarSection } from './host.ts';

/**
 * P17-05: every view can be drawn another way from its toolbar, a feed reads
 * the notes' bodies, and a task can be ticked done from any layout — the tick
 * written into its file, as a board drag is.
 */

const TASK_TYPE = [
  '---',
  'name: task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [backlog, review, done]',
  '  phase: number',
  '---',
  '',
].join('\n');

const view = (title: string, layout: string, extra: string[] = []) =>
  [
    '---',
    'atlas: view',
    'type: task',
    `layout: ${layout}`,
    ...extra,
    'columns: [phase]',
    'limit: 50',
    '---',
    '',
    `# ${title}`,
    '',
  ].join('\n');

const task = (title: string, status: string, body: string) =>
  [
    '---',
    'type: task',
    `status: ${status}`,
    'phase: 1',
    '---',
    '',
    `# ${title}`,
    '',
    body,
    '',
  ].join('\n');

async function openVault(page: Page, extra: readonly { name: string; content: string }[] = []) {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/views');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write('.atlas/views/All tasks.md', view('All tasks', 'table'));
  await vault.write('.atlas/views/Board.md', view('Board', 'board', ['groupBy: status']));
  for (const file of extra) await vault.write(file.name, file.content);
  await vault.write(
    'first.md',
    task('First', 'review', 'The first task’s body, pointing at [[Second]].'),
  );
  await vault.write(
    'second.md',
    task('Second', 'backlog', 'The second task’s body, filed under #someday.'),
  );

  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return vault;
}

const openView = (page: Page, name: string) =>
  sidebarSection(page, 'views').getByRole('button', { name, exact: true }).click();

const doneBox = (page: Page, title: string) =>
  page.getByRole('checkbox', { name: `Mark ${title} done` });

test('ticking a task in a table marks it done, the board follows, and unticking puts it back', async ({
  page,
}) => {
  const vault = await openVault(page);
  await openView(page, 'All tasks');

  // The status is not one of the table's columns, and still the box knows it.
  await expect(doneBox(page, 'First')).not.toBeChecked();
  await doneBox(page, 'First').click();
  await expectFile(vault, 'first.md').toContain('status: done');
  await expect(doneBox(page, 'First')).toBeChecked();
  expect(await vault.read('first.md')).toContain('The first task’s body');

  await page
    .getByRole('navigation', { name: 'Views' })
    .getByRole('button', { name: 'Board' })
    .click();
  const doneColumn = page.getByRole('region', { name: 'Done' });
  await expect(doneColumn.getByRole('button', { name: 'first', exact: true })).toBeVisible();
  await expect(doneColumn.getByRole('checkbox', { name: 'Mark First done' })).toBeChecked();

  // Unticked on the board: back to review, where it was before — not the start.
  await doneColumn.getByRole('checkbox', { name: 'Mark First done' }).click();
  await expectFile(vault, 'first.md').toContain('status: review');
  const reviewColumn = page.getByRole('region', { name: 'Review' });
  await expect(reviewColumn.getByRole('button', { name: 'first', exact: true })).toBeVisible();
});

test('a view switched to a feed reads each note’s body, and to a gallery draws cards', async ({
  page,
}) => {
  const vault = await openVault(page);
  await openView(page, 'All tasks');

  await page.getByRole('button', { name: 'Layout', exact: true }).click();
  await page.getByRole('menuitemradio', { name: /Feed/ }).click();

  const first = page.getByRole('article', { name: 'First' });
  await expect(first.getByLabel('Body of First')).toContainText('pointing at');
  await expect(
    page.getByRole('article', { name: 'Second' }).getByLabel('Body of Second'),
  ).toContainText('The second task’s body');
  // The feed is a tickable layout like the rest.
  await expect(first.getByRole('checkbox', { name: 'Mark First done' })).not.toBeChecked();

  // Drawn at once, and like a filter, only written into the view when saved.
  expect(await vault.read('.atlas/views/All tasks.md')).toContain('layout: table');
  await page.getByRole('button', { name: 'Save view' }).click();
  await expectFile(vault, '.atlas/views/All tasks.md').toContain('layout: feed');

  // A link in a body opens its note.
  await first.locator('[data-wikilink="Second"]').click();
  await expect(page.getByRole('heading', { name: 'second', exact: true, level: 1 })).toBeVisible();

  await openView(page, 'All tasks');
  await page.getByRole('button', { name: 'Layout', exact: true }).click();
  await page.getByRole('menuitemradio', { name: /Gallery/ }).click();
  const gallery = page.getByRole('list', { name: 'Notes' });
  await expect(gallery.getByRole('button', { name: 'first', exact: true })).toBeVisible();
  await expect(gallery.getByRole('checkbox', { name: 'Mark Second done' })).toBeVisible();

  // Reset puts the saved layout back, and the file never heard of the gallery.
  await page.getByRole('button', { name: 'Reset' }).click();
  await expect(page.getByRole('article', { name: 'First' })).toBeVisible();
  expect(await vault.read('.atlas/views/All tasks.md')).toContain('layout: feed');
});

test('a tag in a feed card’s body opens the tags page on it', async ({ page }) => {
  await openVault(page);
  await openView(page, 'All tasks');
  await page.getByRole('button', { name: 'Layout', exact: true }).click();
  await page.getByRole('menuitemradio', { name: /Feed/ }).click();

  const second = page.getByRole('article', { name: 'Second' });
  await second.locator('[data-tag="someday"]').click();
  await expect(page.getByRole('heading', { name: '#someday', level: 2 })).toBeVisible();
});

test('a new view can be made as a feed', async ({ page }) => {
  const vault = await openVault(page);
  await sidebarSection(page, 'types').getByRole('button', { name: /^task/i }).click();
  await page
    .getByRole('navigation', { name: 'Views' })
    .getByRole('button', { name: 'Add a view' })
    .click();
  await page.getByRole('menuitem', { name: /Feed/ }).click();

  await expectFile(vault, '.atlas/views/task feed.md').toContain('layout: feed');
  await expect(
    page.getByRole('article', { name: 'First' }).getByLabel('Body of First'),
  ).toContainText('pointing at');
});

/**
 * UI v2 slice 13d: what each layout *renders* — a list row is the table's
 * 34px row on `line-soft`; a gallery card is the board's card, one hairline
 * with no shadow and no lift under the pointer; a feed row sits on
 * `line-soft`. Measured against the token as painted, not the sheet's words.
 */
test('list rows are 34px on line-soft, gallery cards hairline and still, feed rows on line-soft', async ({
  page,
}) => {
  await openVault(page);
  await openView(page, 'All tasks');
  const choose = async (layout: string) => {
    await page.getByRole('button', { name: 'Layout', exact: true }).click();
    await page.getByRole('menuitemradio', { name: new RegExp(`^${layout}`) }).click();
  };
  // A token as the browser paints it, so the comparison is colour to colour.
  const painted = (token: string) =>
    page.evaluate((name) => {
      const probe = document.createElement('div');
      probe.style.backgroundColor = `var(${name})`;
      document.body.append(probe);
      const colour = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return colour;
    }, token);
  const lineSoft = await painted('--line-soft');
  const line = await painted('--line');
  // The row holding First, wherever the query's order puts it.
  const rowOf = (inner: ReturnType<Page['getByRole']>) =>
    page.getByRole('list', { name: 'Notes' }).getByRole('listitem').filter({ has: inner });

  await choose('List');
  const row = rowOf(page.getByRole('button', { name: 'first', exact: true }));
  await expect(row).toHaveCSS('height', '34px');
  await expect(row).toHaveCSS('border-bottom-color', lineSoft);
  await expect(row).toHaveCSS('border-bottom-width', '1px');

  await choose('Gallery');
  const card = rowOf(page.getByRole('button', { name: 'first', exact: true }));
  await expect(card).toHaveCSS('border-top-width', '1px');
  await expect(card).toHaveCSS('border-top-color', line);
  await expect(card).toHaveCSS('border-top-left-radius', '0px');
  await expect(card).toHaveCSS('box-shadow', 'none');
  const resting = await card.boundingBox();
  await card.hover();
  await expect(card).toHaveCSS('box-shadow', 'none');
  await expect(card).toHaveCSS('transform', 'none');
  expect(await card.boundingBox()).toEqual(resting);

  await choose('Feed');
  const feedRow = rowOf(page.getByRole('article', { name: 'First' }));
  await expect(feedRow).toHaveCSS('border-bottom-color', lineSoft);
  await expect(feedRow).toHaveCSS('box-shadow', 'none');
  await expect(feedRow.getByRole('checkbox', { name: 'Mark First done' })).toBeVisible();
});

/**
 * A title with nothing to break at (a 130-character slug) wraps inside its
 * feed row rather than running out of it; and in a pane too narrow for a list
 * row's fields, the fields are cut at the row's edge rather than overflowing
 * it. The narrow view lists two fields so the row has something to cut.
 */
test('an unbroken title stays inside its feed row, and a narrow list row cuts its fields', async ({
  page,
}) => {
  const unbroken = 'u'.repeat(130);
  const narrowView = [
    '---',
    'atlas: view',
    'type: task',
    'layout: list',
    'columns: [phase, status]',
    'limit: 50',
    '---',
    '',
    '# Narrow',
    '',
  ].join('\n');
  await openVault(page, [
    { name: `${unbroken}.md`, content: task(unbroken, 'backlog', 'A body.') },
    { name: '.atlas/views/Narrow.md', content: narrowView },
  ]);
  await openView(page, 'All tasks');
  await page.getByRole('button', { name: 'Layout', exact: true }).click();
  await page.getByRole('menuitemradio', { name: /^Feed/ }).click();
  const article = page.getByRole('article', { name: unbroken });
  const row = page
    .getByRole('list', { name: 'Notes' })
    .getByRole('listitem')
    .filter({ has: article });
  const title = article.getByRole('button', { name: unbroken });
  await expect(title).toBeVisible();
  const [rowBox, titleBox] = await Promise.all([row.boundingBox(), title.boundingBox()]);
  expect(rowBox).not.toBeNull();
  expect(titleBox).not.toBeNull();
  expect((titleBox?.x ?? 0) + (titleBox?.width ?? 0)).toBeLessThanOrEqual(
    (rowBox?.x ?? 0) + (rowBox?.width ?? 0) + 0.5,
  );

  await page.setViewportSize({ width: 420, height: 900 });
  await openView(page, 'Narrow');
  const list = page.getByRole('list', { name: 'Notes' });
  await expect(list.getByRole('button', { name: 'first', exact: true })).toBeVisible();
  // Nothing in any row runs past the list's own box.
  await expect
    .poll(() => list.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBe(0);
});

test('the Layout menu says why a calendar cannot be chosen for a type with no date', async ({
  page,
}) => {
  // Not the Task type: it is given `focus` (Chosen for), a date, as the vault opens (#108).
  await openVault(page, [
    {
      name: '.atlas/types/recipe.md',
      content: '---\nname: recipe\nproperties:\n  serves: number\n---\n',
    },
    {
      name: '.atlas/views/All recipes.md',
      content: view('All recipes', 'table').replace('type: task', 'type: recipe'),
    },
    { name: 'soup.md', content: '---\ntype: recipe\nserves: 4\n---\n\n# Soup\n' },
  ]);
  await openView(page, 'All recipes');

  await page.getByRole('button', { name: 'Layout', exact: true }).click();
  const calendar = page.getByRole('menuitemradio', { name: /Calendar/ });
  await expect(calendar).toBeVisible();
  await expect(calendar).toHaveAttribute('aria-disabled', 'true');
  await expect(calendar).toContainText('A calendar needs a date');
});
