import { expect, test, type Page } from './fixtures.ts';
import {
  createVault,
  emitVaultChanged,
  expectFile,
  expectSaved,
  installHost,
  pageCommand,
  saveNow,
} from './host.ts';
import { caretAtLineEnd } from './caret.ts';

/**
 * A small web: Hub links to Spoke; Task points at Hub through a `project`
 * relation; Far hangs off Spoke, two steps from Hub; Loner links nothing.
 */
async function openLinkedVault(page: Page) {
  const vault = await createVault();
  await vault.write('Hub.md', '# Hub\n\nThe centre links [[Spoke]].\n');
  await vault.write('Spoke.md', '# Spoke\n\nOut to [[Far]].\n');
  await vault.write('Far.md', '# Far\n\nThe edge.\n');
  await vault.write('Task.md', '---\ntype: task\nproject: "[[Hub]]"\n---\n# Task\n');
  await vault.write('Loner.md', '# Loner\n\nNo links at all.\n');
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return vault;
}

const openNote = (page: Page, name: string) =>
  page.getByRole('treeitem', { name, exact: true }).click();

const linksPanel = (page: Page) => page.getByRole('region', { name: 'Links', exact: true });

test('a note linked from the menu gets the link in its file, and a backlink on its target', async ({
  page,
}) => {
  const vault = await openLinkedVault(page);
  await openNote(page, 'Loner');
  await expect(page.getByRole('article', { name: 'Loner' })).toBeVisible();

  await pageCommand(page, /^Link to…/);
  const picker = page.getByRole('dialog', { name: 'Link to a note' });
  await picker.getByRole('searchbox').fill('Fa');
  await expect(picker.getByRole('option', { name: /Far/ })).toBeVisible();
  await expect(picker.getByRole('option', { name: /Hub/ })).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(picker).toHaveCount(0);

  await saveNow(page);
  await expectSaved(page);
  await expectFile(vault, 'Loner.md').toBe('# Loner\n\nNo links at all.\n\n[[Far]]\n');

  // The host's watcher reports the write; the index and the links follow it.
  await emitVaultChanged(page, ['Loner.md']);
  await openNote(page, 'Far');
  const toggle = linksPanel(page).getByRole('button', { name: /^Links/ });
  await expect(toggle).toContainText('2 linked here · 0 linked from here');
  await toggle.click();
  const here = linksPanel(page).getByRole('region', { name: 'Links here' });
  await expect(here.getByRole('button', { name: 'Loner' })).toBeVisible();
  await expect(here.getByRole('button', { name: 'Spoke' })).toBeVisible();
});

test('/link at the start of a line links a note at the cursor', async ({ page }) => {
  const vault = await openLinkedVault(page);
  await openNote(page, 'Far');
  await caretAtLineEnd(page.getByText('The edge.'));
  await page.keyboard.press('Enter');
  await page.keyboard.type('/link');
  await page
    .getByRole('listbox', { name: 'Insert block' })
    .getByRole('option', { name: /Link to note/ })
    .waitFor();
  await page.keyboard.press('Enter');

  const picker = page.getByRole('dialog', { name: 'Link to a note' });
  await picker.getByRole('searchbox').fill('Hub');
  await page.keyboard.press('Enter');
  await saveNow(page);
  await expectSaved(page);
  // No `/link` left behind, and nothing but the link where it was typed.
  await expectFile(vault, 'Far.md').toBe('# Far\n\nThe edge.\n\n[[Hub]]\n');
});

test('a relation shows as a named link both ways', async ({ page }) => {
  await openLinkedVault(page);
  await openNote(page, 'Hub');
  const toggle = linksPanel(page).getByRole('button', { name: /^Links/ });
  await expect(toggle).toContainText('1 linked here · 1 linked from here');
  await toggle.click();
  await expect(
    linksPanel(page)
      .getByRole('region', { name: 'Links here' })
      .getByRole('button', { name: 'Task — Project' }),
  ).toBeVisible();
  await expect(
    linksPanel(page)
      .getByRole('region', { name: 'Links from this note' })
      .getByRole('button', { name: 'Spoke' }),
  ).toBeVisible();
});

test('an unlinked mention is linked in one click, changing nothing else', async ({ page }) => {
  const vault = await openLinkedVault(page);
  await vault.write('Diary.md', '# Diary\n\nMet the loner  today.   \n\n`Loner` in code.\n');
  await emitVaultChanged(page, ['Diary.md']);
  await openNote(page, 'Loner');

  await linksPanel(page)
    .getByRole('button', { name: /^Links/ })
    .click();
  await linksPanel(page).getByRole('button', { name: 'Unlinked mentions' }).click();
  await linksPanel(page).getByRole('button', { name: 'Link the mention in Diary' }).click();
  await expectFile(vault, 'Diary.md').toBe(
    '# Diary\n\nMet the [[Loner|loner]]  today.   \n\n`Loner` in code.\n',
  );
});

/** The graph's notes, read from the list alternative. */
async function graphListed(page: Page): Promise<string[]> {
  await page.getByRole('radio', { name: 'List' }).click();
  const items = page.getByRole('list', { name: 'Notes in the graph' }).locator(':scope > li');
  return (
    await items.evaluateAll((all) => all.map((item) => item.getAttribute('data-path')))
  ).filter((path): path is string => path !== null);
}

test('the graph draws every note and opens one on click', async ({ page }) => {
  await openLinkedVault(page);
  await page.getByRole('list', { name: 'Go to' }).getByRole('button', { name: 'Graph' }).click();

  const stage = page.locator('.graph__surface');
  await expect(stage).toBeVisible();
  await expect(page.locator('.graph__node')).toHaveCount(5);
  await expect(page.locator('[data-edge="relation"]')).toHaveCount(1);
  await expect(page.locator('[data-edge="link"]')).toHaveCount(2);

  await page.locator('.graph__node[data-path="Spoke.md"] .graph__dot').click();
  await expect(page.getByRole('article', { name: 'Spoke' })).toBeVisible();
});

test('the graph as a list, narrowed by type and orphans', async ({ page }) => {
  await openLinkedVault(page);
  await page.getByRole('list', { name: 'Go to' }).getByRole('button', { name: 'Graph' }).click();
  expect(await graphListed(page)).toEqual(['Far.md', 'Hub.md', 'Loner.md', 'Spoke.md', 'Task.md']);

  await page.getByRole('switch', { name: 'Hide orphans' }).click();
  await expect(
    page.getByRole('list', { name: 'Notes in the graph' }).locator('[data-path="Loner.md"]'),
  ).toHaveCount(0);

  await page.getByRole('group', { name: 'Types' }).getByRole('button', { name: 'task' }).click();
  await expect(
    page.getByRole('list', { name: 'Notes in the graph' }).locator('[data-path="Task.md"]'),
  ).toHaveCount(0);
  await expect(
    page.getByRole('list', { name: 'Notes in the graph' }).locator('[data-path="Hub.md"]'),
  ).toHaveCount(1);

  // Opened from the list with the keyboard, as the canvas cannot be.
  await page.getByRole('button', { name: /^Hub/ }).first().focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('article', { name: 'Hub' })).toBeVisible();
});

test('a long linked title stays inside the list in a narrow pane, ellipsised with the whole on hover', async ({
  page,
}) => {
  const long = 'Review the quarterly numbers with the whole team before the board meeting, twice';
  const vault = await createVault();
  await vault.write('Hub.md', `# Hub\n\nLinks [[${long}]].\n`);
  await vault.write(`${long}.md`, `# ${long}\n\nThe long one.\n`);
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await page.getByRole('list', { name: 'Go to' }).getByRole('button', { name: 'Graph' }).click();
  // Opened wide, then squeezed: under 944px the sidebar is a drawer (#658).
  await page.setViewportSize({ width: 720, height: 900 });
  await page.getByRole('radio', { name: 'List' }).click();

  const list = page.getByRole('list', { name: 'Notes in the graph' });
  const link = list.getByRole('list', { name: 'Connected to Hub' }).getByRole('button');
  await expect(link).toHaveCount(1);
  await expect(link.locator('.graph__list-title')).toHaveAttribute('title', long);
  // The row, and the list it is in, are no wider than the pane shows: the
  // title is cut with an ellipsis, not run off the edge.
  await expect.poll(() => list.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect.poll(() => link.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
});

test('show in graph draws the note and its neighbours only, then one step further', async ({
  page,
}) => {
  await openLinkedVault(page);
  await openNote(page, 'Hub');
  await pageCommand(page, /^Show in graph/);

  await expect(page.getByRole('article', { name: 'Around Hub' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Hub', level: 1 })).toBeVisible();
  await expect(page.locator('.graph__node')).toHaveCount(3);
  await expect(page.locator('.graph__node--centre')).toHaveAttribute('data-path', 'Hub.md');
  expect(await graphListed(page)).toEqual(['Hub.md', 'Spoke.md', 'Task.md']);

  await page.getByRole('radio', { name: '2 steps' }).click();
  expect(await graphListed(page)).toEqual(['Far.md', 'Hub.md', 'Spoke.md', 'Task.md']);
});
