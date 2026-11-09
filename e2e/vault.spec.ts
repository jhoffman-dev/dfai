import { expect, test } from './fixtures.ts';
import { createVault, installHost } from './host.ts';

const NOTE = '---\ntitle: Today\ntags: [daily]\n---\n\n# Today\n\n- [ ] ship phase 1\n';

test('opens a vault, walks the tree, and shows a note exactly as stored', async ({ page }) => {
  const vault = await createVault();
  await vault.write('todo.md', '# Todo\n');
  await vault.mkdir('Notes');
  await vault.write('Notes/today.md', NOTE);
  await installHost(page, vault);

  await page.goto('/');

  // Nothing is open yet, so the only thing offered is choosing a folder.
  await expect(page.getByRole('heading', { name: 'Open a vault' })).toBeVisible();
  await expect(page.getByRole('tree')).toHaveCount(0);

  await page.getByRole('button', { name: 'Choose folder…' }).click();

  // The vault's top level appears, folders above files.
  await expect(page.getByRole('treeitem').filter({ hasText: 'Notes' })).toBeVisible();
  await expect(page.getByRole('treeitem', { name: 'todo', exact: true })).toBeVisible();

  // A folder's contents are read only when it is opened.
  await expect(page.getByRole('treeitem', { name: 'today', exact: true })).toHaveCount(0);
  await page.getByRole('treeitem').filter({ hasText: 'Notes' }).click();
  await expect(page.getByRole('treeitem', { name: 'today', exact: true })).toBeVisible();

  // Opening the note shows its bytes, frontmatter and all.
  await page.getByRole('treeitem', { name: 'today', exact: true }).click();
  await expect(page.getByRole('article', { name: 'today' })).toBeVisible();
  // The body is rendered by the editor; the frontmatter is held aside untouched.
  await expect(
    page.getByLabel('Note', { exact: true }).getByRole('heading', { name: 'Today', level: 1 }),
  ).toBeVisible();
  await expect(page.getByText('title: Today')).toHaveCount(0);

  // Collapsing hides the children again.
  await page.getByRole('treeitem').filter({ hasText: 'Notes' }).click();
  await expect(page.getByRole('treeitem', { name: 'today', exact: true })).toHaveCount(0);
});

test('remembers the vault across a restart', async ({ page }) => {
  const vault = await createVault();
  await vault.write('kept.md', '# Kept\n');
  await installHost(page, vault);

  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByRole('treeitem', { name: 'kept', exact: true })).toBeVisible();

  // A reload stands in for quitting and relaunching.
  await page.reload();
  await expect(page.getByRole('treeitem', { name: 'kept', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Open a vault' })).toHaveCount(0);
});

test('stays usable when a note cannot be read as text', async ({ page }) => {
  const vault = await createVault();
  await vault.write('photo.png', '\u0000\u0001binary');
  await installHost(page, vault);

  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await page.getByRole('treeitem').filter({ hasText: 'photo.png' }).click();

  // The tree is still there and still navigable.
  await expect(page.getByRole('treeitem').filter({ hasText: 'photo.png' })).toBeVisible();
});

test('handles a vault with two thousand notes without bogging down', async ({ page }) => {
  const vault = await createVault();
  await Promise.all(
    Array.from({ length: 2000 }, (_, index) =>
      vault.write(`note-${String(index).padStart(4, '0')}.md`, `# Note ${index}\n`),
    ),
  );
  await installHost(page, vault);

  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByRole('treeitem', { name: 'note-0000', exact: true })).toBeVisible();

  // Virtualised: only a screenful of rows is in the DOM, not two thousand.
  await expect(async () => {
    const rendered = await page.getByRole('treeitem').count();
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(100);
  }).toPass();

  // The derived sections read every note's frontmatter to classify it. None of
  // these notes is a view, a dashboard or a favourite, so none of them may turn
  // into a row: the sections must scale with what they match, not with the
  // vault. Only user space is virtualised, so a section that listed everything
  // would put two thousand rows in the DOM with nothing to catch it.
  for (const name of ['Favorites', 'Views', 'Dashboards']) {
    const section = page.getByRole('region', { name });
    // Assert the section is there before asserting it is empty, or the second
    // assertion passes for the wrong reason when the locator stops matching.
    await expect(section).toHaveCount(1);
    // `listitem`, not `button`: the section's own disclosure heading is a
    // button inside it, so counting buttons never reaches zero.
    await expect(section.getByRole('listitem')).toHaveCount(0);
  }
});
