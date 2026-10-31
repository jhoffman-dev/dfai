import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from './fixtures.ts';
import { createVault, installHost, sidebarSection, type FakeVault } from './host.ts';

/*
 * Attack on PR #547 (#37): Ask brought back at launch, and a recent question
 * whose chat note is gone. A reload stands in for quitting. Fictional data only.
 */

async function openVault(page: Page): Promise<FakeVault> {
  const vault = await createVault();
  await vault.write('Journal.md', '# Journal\n\nToday.\n');
  await vault.mkdir('Chats');
  await vault.write(
    'Chats/What is open for Larkspur.md',
    '---\ntype: chat\n---\n\n## You\n\nWhat is open for Larkspur\n',
  );
  await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await sidebarSection(page, 'userSpace')
    .getByRole('treeitem', { name: 'Journal', exact: true })
    .click();
  await expect(page.getByRole('article', { name: 'Journal' })).toBeVisible();
  return vault;
}

const ask = (page: Page) => page.getByRole('article', { name: 'Ask' });
const recentRow = (page: Page) =>
  ask(page)
    .getByRole('navigation', { name: 'Recent questions' })
    .getByRole('button', { name: 'What is open for Larkspur' });

test('an Ask tab brought back at launch does not take the keys', async ({ page }) => {
  await openVault(page);
  await page.keyboard.press('Meta+j');
  await expect(ask(page).getByRole('textbox', { name: 'Ask Claude' })).toBeFocused();

  await page.reload();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  const box = ask(page).getByRole('textbox', { name: 'Ask Claude' });
  await expect(box).toBeVisible();
  // Read after the recent questions arrive, so the page's mount effects have run.
  await expect(recentRow(page)).toBeVisible();
  await expect(box).not.toBeFocused();
});

test('picking a recent question whose chat note was deleted underneath says so, never nothing', async ({
  page,
}) => {
  const vault = await openVault(page);
  await page.keyboard.press('Meta+j');
  await expect(recentRow(page)).toBeVisible();

  // Deleted by another program before the watcher has told the app.
  await rm(join(vault.root, 'Chats/What is open for Larkspur.md'));
  await recentRow(page).click();

  await expect
    .poll(
      async () =>
        (await page.getByRole('alert').count()) > 0 || (await recentRow(page).count()) === 0,
      {
        message: 'an alert, or the stale row taken away',
      },
    )
    .toBe(true);
});
