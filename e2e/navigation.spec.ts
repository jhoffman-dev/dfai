import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost, sidebarSection } from './host.ts';

const TASK_TYPE = ['---', 'name: task', 'label: Task', 'properties:', '  status: text', '---', ''];

async function openVault(page: Page) {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.write('.atlas/types/task.md', TASK_TYPE.join('\n'));
  await vault.write('alpha.md', 'The first note.\n');
  await vault.write('beta.md', 'The second note.\n');
  await vault.write('gamma.md', '---\ntype: task\n---\n\nA task.\n');
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return vault;
}

const pages = (page: Page) => sidebarSection(page, 'userSpace');
const row = (page: Page, name: string) => pages(page).getByRole('treeitem', { name, exact: true });
const back = (page: Page) => page.getByRole('button', { name: 'Back', exact: true });
const forward = (page: Page) => page.getByRole('button', { name: 'Forward', exact: true });
const showing = (page: Page, name: string) =>
  expect(page.getByRole('article', { name, exact: true })).toBeVisible();

test('Back and Forward walk the notes a pane has shown, and say where they go', async ({
  page,
}) => {
  await openVault(page);
  await row(page, 'alpha').click();
  await showing(page, 'alpha');
  // Nothing before the first note: Back is there, and disabled.
  await expect(back(page)).toBeDisabled();
  await expect(forward(page)).toBeDisabled();

  await row(page, 'beta').click();
  await showing(page, 'beta');
  await expect(back(page)).toBeEnabled();
  await expect(back(page)).toHaveAttribute('title', 'Back to alpha (⌘[)');

  await back(page).click();
  await showing(page, 'alpha');
  await expect(back(page)).toBeDisabled();
  await expect(forward(page)).toHaveAttribute('title', 'Forward to beta (⌘])');

  await forward(page).click();
  await showing(page, 'beta');
  await expect(forward(page)).toBeDisabled();
});

test('Cmd+[ and Cmd+] go back and forward', async ({ page }) => {
  await openVault(page);
  await row(page, 'alpha').click();
  await showing(page, 'alpha');
  await row(page, 'beta').click();
  await showing(page, 'beta');

  await page.keyboard.press('Meta+[');
  await showing(page, 'alpha');
  await page.keyboard.press('Meta+]');
  await showing(page, 'beta');
});

test("Back leaves a type's page for the note it replaced, and Forward returns to it", async ({
  page,
}) => {
  await openVault(page);
  await row(page, 'alpha').click();
  await showing(page, 'alpha');

  await sidebarSection(page, 'types')
    .getByRole('button', { name: /^Task, / })
    .click();
  await showing(page, 'Task');
  await expect(back(page)).toHaveAttribute('title', 'Back to alpha (⌘[)');

  await back(page).click();
  await showing(page, 'alpha');
  await expect(forward(page)).toHaveAttribute('title', 'Forward to Task (⌘])');
  await forward(page).click();
  await showing(page, 'Task');

  // A note opened from the type's table is one more step.
  await page
    .getByRole('article', { name: 'Task', exact: true })
    .getByRole('button', { name: 'gamma', exact: true })
    .click();
  // The row peeks its note (slice 6b); expanding it opens the note as the tab's next place.
  await page.locator('.peek').getByRole('button', { name: 'Open as full page' }).click();
  await showing(page, 'gamma');
  await back(page).click();
  await showing(page, 'Task');
});

// Temporarily skipped: fails most runs on the macOS CI runner (30 s click timeout on the Delete… menu item), tracked in #52.
test.fixme('a deleted note drops out of Forward', async ({ page }) => {
  const vault = await openVault(page);
  await row(page, 'alpha').click();
  await showing(page, 'alpha');
  await row(page, 'beta').click();
  await showing(page, 'beta');
  await back(page).click();
  await showing(page, 'alpha');
  await expect(forward(page)).toBeEnabled();

  await row(page, 'beta').hover();
  await pages(page).getByRole('button', { name: 'Options for beta', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Delete…/ }).click();
  await page.getByRole('button', { name: 'Move to Trash' }).click();
  await expect.poll(() => vault.exists('beta.md')).toBe(false);

  await showing(page, 'alpha');
  await expect(forward(page)).toBeDisabled();
});
