import { expect, test, type Page } from './fixtures.ts';
import { dragWithPointer } from './drag.ts';
import { createVault, expectFile, installHost, type FakeVault } from './host.ts';

// P19-01 and P19-02 (U-17, U-18): the sidebar's sections can be dragged into
// any order, which the vault keeps in `.atlas/settings.md`. A shut section
// keeps its place (issue #17, ADR-0013 addendum).

const TASK_TYPE = ['---', 'name: task', 'label: Task', '---', ''].join('\n');
const VIEW = ['---', 'atlas: view', 'type: task', 'layout: table', '---', '', '# Board', ''].join(
  '\n',
);

async function openVault(page: Page, { settings }: { settings?: string } = {}): Promise<FakeVault> {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/views');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  await vault.write('.atlas/views/Board.md', VIEW);
  await vault.write('Garden.md', '# Garden\n');
  if (settings !== undefined) await vault.write('.atlas/settings.md', settings);

  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return vault;
}

/** The section headings, top to bottom, as the sidebar shows them. */
const headings = (page: Page) =>
  page.getByRole('navigation', { name: 'Vault' }).getByRole('heading', { level: 2 });

const heading = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Vault' }).getByRole('button', { name, exact: true });

const grip = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Vault' }).getByRole('button', { name: `Move ${name}` });

/**
 * The section ids the settings note lists, in order — whichever YAML list
 * style the file was written in.
 */
async function savedOrder(vault: FakeVault): Promise<string[]> {
  const text = await vault.read('.atlas/settings.md').catch(() => '');
  const [, after = ''] = text.split('sidebarOrder:');
  const [list = ''] = after.split(/\n(?=\S)/);
  return list.match(/\w+/g) ?? [];
}

const DEFAULT = ['Favorites', 'Types', 'Views', 'Dashboards', 'Pages'];

test('a section dragged by its grip stays where it was put, across a reload', async ({ page }) => {
  const vault = await openVault(page, { settings: '---\nquickAdd: [task]\n---\n\n# Settings\n' });
  await expect(headings(page)).toHaveText(DEFAULT);

  // The grip keeps out of sight until its heading is hovered.
  await expect(grip(page, 'Favorites')).toHaveCSS('opacity', '0');
  await heading(page, 'Favorites').hover();
  await expect(grip(page, 'Favorites')).toHaveCSS('opacity', '1');

  await dragWithPointer(page, {
    from: grip(page, 'Favorites'),
    to: heading(page, 'Dashboards'),
    overText: 'over droppable area dashboards',
  });

  await expect(headings(page)).toHaveText(['Types', 'Views', 'Dashboards', 'Favorites', 'Pages']);
  await expect
    .poll(() => savedOrder(vault))
    .toEqual(['types', 'views', 'dashboards', 'favorites', 'userSpace']);
  // Written beside what the file already said, not over it.
  await expectFile(vault, '.atlas/settings.md').toContain('quickAdd: [task]');

  // A reload stands in for quitting and relaunching.
  await page.reload();
  await expect(headings(page)).toHaveText(['Types', 'Views', 'Dashboards', 'Favorites', 'Pages']);
});

test('a tall section lands on the heading it is dropped on', async ({ page }) => {
  // Enough views that the section is far taller than the one it is dropped
  // on: the drop is where the pointer is, not where the section's middle is.
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.mkdir('.atlas/views');
  await vault.write('.atlas/types/task.md', TASK_TYPE);
  for (const name of ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta']) {
    await vault.write(`.atlas/views/${name}.md`, VIEW.replace('# Board', `# ${name}`));
  }
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();

  await dragWithPointer(page, {
    from: grip(page, 'Views'),
    to: heading(page, 'Favorites'),
    overText: 'over droppable area favorites',
  });

  await expect(headings(page)).toHaveText(['Views', 'Favorites', 'Types', 'Dashboards', 'Pages']);
});

test('a section moves from the keyboard, keeping focus on its grip', async ({ page }) => {
  const vault = await openVault(page);

  await grip(page, 'Pages').focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect(headings(page)).toHaveText(['Favorites', 'Types', 'Views', 'Pages', 'Dashboards']);
  await expect(grip(page, 'Pages')).toBeFocused();

  await page.keyboard.press('Alt+ArrowUp');
  await expect(headings(page)).toHaveText(['Favorites', 'Types', 'Pages', 'Views', 'Dashboards']);
  await expect
    .poll(() => savedOrder(vault))
    .toEqual(['favorites', 'types', 'userSpace', 'views', 'dashboards']);
});

test('a shut section keeps its place, and can be moved like an open one', async ({ page }) => {
  const vault = await openVault(page);
  await expect(headings(page)).toHaveText(DEFAULT);

  // From the keyboard, so the heading has focus to keep.
  await heading(page, 'Types').focus();
  await page.keyboard.press('Enter');
  await expect(heading(page, 'Types')).toHaveAttribute('aria-expanded', 'false');
  await expect(headings(page)).toHaveText(DEFAULT);
  await expect(heading(page, 'Types')).toBeFocused();

  await heading(page, 'Favorites').click();
  await expect(heading(page, 'Favorites')).toHaveAttribute('aria-expanded', 'false');
  await expect(headings(page)).toHaveText(DEFAULT);

  // Shut, it still moves past an open section.
  await grip(page, 'Types').focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(headings(page)).toHaveText(['Favorites', 'Views', 'Types', 'Dashboards', 'Pages']);
  await expect
    .poll(() => savedOrder(vault))
    .toEqual(['favorites', 'views', 'types', 'dashboards', 'userSpace']);
});

test('a tall section dragged past either end of the list lands at that end', async ({ page }) => {
  // Enough notes that Pages is far the tallest section, so where it lands is
  // read from the pointer and not from the middle of what is being dragged.
  const vault = await createVault();
  for (let at = 1; at <= 16; at += 1) await vault.write(`Note ${at}.md`, `# Note ${at}\n`);
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await expect(headings(page)).toHaveText(DEFAULT);

  const list = page.getByRole('navigation', { name: 'Vault' }).locator('.sidebar__sections');
  const edges = async () => {
    const box = await list.boundingBox();
    if (box === null) throw new Error('the section list is not on screen');
    return { x: box.x + box.width / 2, top: box.y, bottom: box.y + box.height };
  };

  const above = await edges();
  await dragWithPointer(page, {
    from: grip(page, 'Pages'),
    to: { x: above.x, y: above.top - 12 },
    overText: 'over droppable area favorites',
  });
  await expect(headings(page)).toHaveText(['Pages', 'Favorites', 'Types', 'Views', 'Dashboards']);

  const below = await edges();
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error('the page has no viewport');
  await dragWithPointer(page, {
    from: grip(page, 'Pages'),
    to: { x: below.x, y: Math.min(below.bottom + 12, viewport.height - 1) },
    overText: 'over droppable area dashboards',
  });
  await expect(headings(page)).toHaveText(DEFAULT);
});

test('a section dragged again while the last move still slides it into place lands where it is sent (#781)', async ({
  page,
}) => {
  // The slide after a move, made long: a test on a loaded runner reaches for
  // the grip at a place the slide has already carried it from.
  await page.addInitScript(() => {
    const animate = Element.prototype.animate;
    Element.prototype.animate = function slowly(keyframes, options) {
      const timing = typeof options === 'number' ? { duration: options } : (options ?? {});
      return animate.call(this, keyframes, { ...timing, duration: 1_000 });
    };
  });
  const vault = await createVault();
  for (let at = 1; at <= 16; at += 1) await vault.write(`Note ${at}.md`, `# Note ${at}\n`);
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();

  const list = page.getByRole('navigation', { name: 'Vault' }).locator('.sidebar__sections');
  const box = await list.boundingBox();
  if (box === null) throw new Error('the section list is not on screen');
  await dragWithPointer(page, {
    from: grip(page, 'Pages'),
    to: { x: box.x + box.width / 2, y: box.y - 12 },
    overText: 'over droppable area favorites',
  });
  await expect(headings(page)).toHaveText(['Pages', 'Favorites', 'Types', 'Views', 'Dashboards']);
  // Straight after the drop, as the slide has only begun.
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error('the page has no viewport');
  await dragWithPointer(page, {
    from: grip(page, 'Pages'),
    to: { x: box.x + box.width / 2, y: Math.min(box.y + box.height + 12, viewport.height - 1) },
    overText: 'over droppable area dashboards',
  });
  await expect(headings(page)).toHaveText(DEFAULT);
});
