import { expect, test, type Page } from './fixtures.ts';
import { signInOnTheWeb, webVaultOnGitHub } from './web-github.ts';
import { readKeptOnTheDevice } from './web-vault.ts';

/**
 * #773: a note captured on the web with no network waits on the iPad as a
 * new note, says "Not saved yet", is still there after a reload, and is
 * created on GitHub once the connection is back. The plain `test`: an
 * ephemeral context, so nothing is written to ~/Library/WebKit.
 */

const FILES: Record<string, string> = {
  'Garden plan.md': '# Garden plan\n\nFirst line.\n',
  'Inbox/Seed list.md': '# Seed list\n',
};

const status = (page: Page) => page.getByRole('status').filter({ hasText: /Sav|Not saved/ });
const capture = (page: Page) => page.getByRole('dialog', { name: 'Capture a task' });
const treeItem = (page: Page, name: string) => page.getByRole('treeitem', { name, exact: true });

async function openInInbox(page: Page, name: string) {
  const note = treeItem(page, name);
  if (!(await note.isVisible())) await treeItem(page, 'Inbox').tap();
  await note.tap();
}

test('on the web, a note captured offline waits as Not saved yet, outlives a reload, and is created once back online', async ({
  page,
  context,
}) => {
  const { github, unreachable } = await webVaultOnGitHub(page, FILES);
  await signInOnTheWeb(page);
  // The Inbox opened once online, so its listing is on the device for later.
  await openInInbox(page, 'Seed list');
  await expect(page.getByRole('article', { name: 'Seed list' })).toBeVisible();
  // Listings are kept after they answer: offline and after a reload the tree is what the device holds.
  await expect.poll(() => readKeptOnTheDevice(page, 'directory', '')).toBe(true);
  await expect.poll(() => readKeptOnTheDevice(page, 'directory', 'Inbox')).toBe(true);

  await test.step('offline, the capture is queued on the device', async () => {
    await context.setOffline(true);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
    await page.keyboard.press('Alt+Meta+n');
    await capture(page).getByRole('textbox', { name: 'What needs doing' }).fill('Buy seed');
    await page.keyboard.press('Enter');
    await expect(capture(page).getByRole('textbox', { name: 'What needs doing' })).toHaveValue('');
    await expect(capture(page).getByRole('alert')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('article', { name: 'Buy seed' })).toBeVisible();
    await expect(status(page)).toHaveText('Not saved yet: waiting to reach GitHub', {
      timeout: 10_000,
    });
    expect(await github.paths()).not.toContain('Inbox/Buy seed.md');
  });

  await test.step('reloaded with GitHub still out of reach, the note is still there', async () => {
    unreachable(true);
    await context.setOffline(false);
    await page.reload();
    await page.getByRole('button', { name: 'Sign out' }).waitFor();
    await openInInbox(page, 'Buy seed');
    await expect(page.getByRole('article', { name: 'Buy seed' })).toBeVisible();
    await expect(status(page)).toHaveText('Not saved yet: waiting to reach GitHub');
    expect(await github.paths()).not.toContain('Inbox/Buy seed.md');
  });

  await test.step('back online, the note is created on GitHub', async () => {
    unreachable(false);
    await context.setOffline(true);
    await context.setOffline(false);
    await expect.poll(() => github.paths(), { timeout: 15_000 }).toContain('Inbox/Buy seed.md');
    await expect(status(page)).toHaveText('Saved');
    expect(await github.textAt('Inbox/Seed list.md')).toBe('# Seed list\n');
  });
});
