import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, sidebarSection, type FakeVault } from './host.ts';

// P13-03 and P13-04: five peer sections, and a favourite that is a property of
// the note rather than app state.

const TASK_TYPE = [
  '---',
  'name: task',
  'label: Task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [todo, done]',
  '---',
  '',
].join('\n');

const VIEW = ['---', 'atlas: view', 'type: task', 'layout: table', '---', '', '# Board', ''].join(
  '\n',
);

const DASHBOARD = [
  '---',
  'atlas: dashboard',
  'widgets:',
  '  - kind: number',
  '    title: Tasks',
  '    type: task',
  '---',
  '',
].join('\n');

const task = (title: string, status: string): string =>
  ['---', 'type: task', `status: ${status}`, '---', '', `# ${title}`, ''].join('\n');

async function openVault(page: Page): Promise<FakeVault> {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/views');
  await vault.mkdir('.atlas/dashboards');
  await vault.mkdir('Notes');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write('.atlas/views/Board.md', VIEW);
  await vault.write('.atlas/dashboards/Progress.md', DASHBOARD);
  await vault.mkdir('.atlas/skills/weekly-review');
  await vault.write(
    '.atlas/skills/weekly-review/SKILL.md',
    ['---', 'name: weekly-review', 'description: Reviews the week.', '---', '', 'Read.', ''].join(
      '\n',
    ),
  );
  await vault.write('Notes/Ship it.md', task('Ship it', 'todo'));
  await vault.write('Notes/Write it.md', task('Write it', 'done'));

  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return vault;
}

const heading = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

const starOn = (page: Page, section: Parameters<typeof sidebarSection>[1], name: string) =>
  sidebarSection(page, section).getByRole('button', { name: `Add ${name} to favorites` });

const SECTIONS = ['Favorites', 'Types', 'Views', 'Dashboards', 'Pages'];

test('the vault arrives in five sections', async ({ page }) => {
  await openVault(page);

  for (const name of SECTIONS) {
    await expect(heading(page, name)).toHaveAttribute('aria-expanded', 'true');
  }

  // Each derived section is read from the files rather than kept as a list.
  await expect(sidebarSection(page, 'types').getByRole('button', { name: /^Task/ })).toBeVisible();
  await expect(
    sidebarSection(page, 'views').getByRole('button', { name: 'Board', exact: true }),
  ).toBeVisible();
  await expect(
    sidebarSection(page, 'dashboards').getByRole('button', { name: 'Progress', exact: true }),
  ).toBeVisible();
});

test('a section shuts and opens again, and stays shut across a restart', async ({ page }) => {
  await openVault(page);
  await expect(
    sidebarSection(page, 'views').getByRole('button', { name: 'Board', exact: true }),
  ).toBeVisible();

  await heading(page, 'Views').click();

  await expect(heading(page, 'Views')).toHaveAttribute('aria-expanded', 'false');
  await expect(
    sidebarSection(page, 'views').getByRole('button', { name: 'Board', exact: true }),
  ).toHaveCount(0);

  // A reload stands in for quitting and relaunching.
  await page.reload();
  await expect(heading(page, 'Views')).toHaveAttribute('aria-expanded', 'false');
  await expect(heading(page, 'Types')).toHaveAttribute('aria-expanded', 'true');

  await heading(page, 'Views').click();
  await expect(
    sidebarSection(page, 'views').getByRole('button', { name: 'Board', exact: true }),
  ).toBeVisible();
});

test('Pages is the vault, minus only what another section already lists', async ({ page }) => {
  await openVault(page);

  const userSpace = sidebarSection(page, 'userSpace');
  await expect(userSpace.getByRole('treeitem', { name: 'Notes', exact: true })).toBeVisible();

  // `.atlas` is listed — last, shut, and as System — because it also holds the
  // type definitions and the sources, and those have no section of their own.
  // Nothing in Pages shows a `.md`.
  const atlas = userSpace.getByRole('treeitem', { name: 'System', exact: true });
  await expect(atlas).toBeVisible();
  await expect(atlas).toHaveAttribute('aria-expanded', 'false');
  await expect(userSpace.getByRole('treeitem').last()).toHaveAttribute('aria-label', 'System');
  await expect(userSpace.getByRole('treeitem', { name: '.atlas', exact: true })).toHaveCount(0);
  await atlas.click();

  await expect(userSpace.getByRole('treeitem', { name: 'types', exact: true })).toBeVisible();

  // Views, dashboards, templates and skills are not, since each has a place of
  // its own that lists them (ADR-0026 for templates, ADR-0050 for skills).
  await expect(userSpace.getByRole('treeitem', { name: 'views', exact: true })).toHaveCount(0);
  await expect(userSpace.getByRole('treeitem', { name: 'dashboards', exact: true })).toHaveCount(0);
  await expect(userSpace.getByRole('treeitem', { name: 'templates', exact: true })).toHaveCount(0);
  await expect(userSpace.getByRole('treeitem', { name: 'skills', exact: true })).toHaveCount(0);
  await expect(userSpace.getByRole('treeitem', { name: 'SKILL', exact: true })).toHaveCount(0);
});

test('the Skills page is a row of its own, marked while it is open (#169)', async ({ page }) => {
  await openVault(page);
  const row = page.getByRole('list', { name: 'Go to' }).getByRole('button', { name: 'Skills' });
  await expect(row).not.toHaveAttribute('aria-current', 'page');
  await row.click();
  await expect(row).toHaveAttribute('aria-current', 'page');
  await expect(
    page.getByRole('article', { name: 'Skills' }).getByRole('button', { name: /^weekly-review/ }),
  ).toBeVisible();
});

test('a type definition can be reached from the sidebar', async ({ page }) => {
  await openVault(page);

  const userSpace = sidebarSection(page, 'userSpace');
  await userSpace.getByRole('treeitem', { name: 'System', exact: true }).click();
  await userSpace.getByRole('treeitem', { name: 'types', exact: true }).click();
  await userSpace.getByRole('treeitem', { name: 'task', exact: true }).click();

  await expect(page.getByRole('article', { name: 'task', exact: true })).toBeVisible();
});

test('a type opens on its views, and its own page is a press away (ADR-0023)', async ({ page }) => {
  await openVault(page);

  await sidebarSection(page, 'types')
    .getByRole('button', { name: 'Task, 2 notes', exact: true })
    .click();

  const tabs = page.getByRole('navigation', { name: 'Views' });
  await expect(tabs.getByRole('button', { name: 'Board' })).toHaveAttribute('aria-pressed', 'true');
  const board = page.getByRole('article', { name: 'Board', exact: true });
  await expect(board.getByRole('button', { name: 'Ship it' })).toBeVisible();
  await expect(board.getByRole('button', { name: 'Write it' })).toBeVisible();

  await tabs.getByRole('button', { name: 'Edit Task type' }).click();
  // The editor opens in the right sidebar, beside the view, which stays.
  const aside = page.getByRole('complementary', { name: 'Right sidebar' });
  await expect(aside.getByRole('tab', { name: 'Type' })).toHaveAttribute('aria-selected', 'true');
  await expect(aside.getByRole('textbox', { name: 'Name of this type' })).toHaveValue('Task');
  await expect(board.getByRole('button', { name: 'Ship it' })).toBeVisible();
});

test('starring a note from the sidebar writes it into the file, and unstarring takes it out', async ({
  page,
}) => {
  const vault = await openVault(page);
  await sidebarSection(page, 'userSpace')
    .getByRole('treeitem', { name: 'Notes', exact: true })
    .click();

  await starOn(page, 'userSpace', 'Ship it').click();

  await expectFile(vault, 'Notes/Ship it.md').toContain('favorite: true');
  const favorite = sidebarSection(page, 'favorites').getByRole('button', {
    name: 'Ship it',
    exact: true,
  });
  await expect(favorite).toBeVisible();

  await sidebarSection(page, 'favorites')
    .getByRole('button', { name: 'Remove Ship it from favorites', exact: true })
    .click();

  await expectFile(vault, 'Notes/Ship it.md').not.toContain('favorite');
  await expect(favorite).toHaveCount(0);
  // Unstarring changes one property and leaves the rest of the file alone.
  await expectFile(vault, 'Notes/Ship it.md').toContain('status: todo');
});

test('a favourite can be a view, which lives where the index cannot see it', async ({ page }) => {
  const vault = await openVault(page);

  await starOn(page, 'views', 'Board').click();

  await expectFile(vault, '.atlas/views/Board.md').toContain('favorite: true');
  await expect(
    sidebarSection(page, 'favorites').getByRole('button', { name: 'Board', exact: true }),
  ).toBeVisible();
  // It is still a view: one note, in both sections it belongs to.
  await expect(
    sidebarSection(page, 'views').getByRole('button', { name: 'Board', exact: true }),
  ).toBeVisible();
});

test('opening a type marks only the type, not the note still held underneath it', async ({
  page,
}) => {
  await openVault(page);
  // Every row the sidebar lights as "where you are", in any section.
  const marked = page.locator('.sidebar [aria-current="page"], .sidebar [aria-selected="true"]');

  await sidebarSection(page, 'userSpace')
    .getByRole('treeitem', { name: 'Notes', exact: true })
    .click();
  await sidebarSection(page, 'userSpace')
    .getByRole('treeitem', { name: 'Ship it', exact: true })
    .click();
  await expect(page.getByRole('article', { name: 'Ship it' })).toBeVisible();
  await expect(marked).toHaveCount(1);
  await expect(marked).toHaveAccessibleName('Ship it');

  await sidebarSection(page, 'types').getByRole('button', { name: /^Task/ }).click();
  await expect(page.getByRole('article', { name: 'Ship it' })).toBeHidden();
  await expect(marked).toHaveCount(1);
  await expect(marked).toHaveAccessibleName(/^Task/);
});

test('a note can be starred from the note itself', async ({ page }) => {
  const vault = await openVault(page);
  await sidebarSection(page, 'userSpace')
    .getByRole('treeitem', { name: 'Notes', exact: true })
    .click();
  await sidebarSection(page, 'userSpace')
    .getByRole('treeitem', { name: 'Write it', exact: true })
    .click();

  // The star sits in the page's bar, above the note.
  await expect(page.getByRole('article', { name: 'Write it' })).toBeVisible();
  const note = page.getByRole('region', { name: 'Pane 1' });
  await note.getByRole('button', { name: 'Add Write it to favorites' }).click();

  await expectFile(vault, 'Notes/Write it.md').toContain('favorite: true');
  await expect(note.getByRole('button', { name: 'Remove Write it from favorites' })).toBeVisible();
  await expect(
    sidebarSection(page, 'favorites').getByRole('button', { name: 'Write it', exact: true }),
  ).toBeVisible();
});
