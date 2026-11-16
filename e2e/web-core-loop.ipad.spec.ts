import { caretAtLineEndByTap } from './caret.ts';
import { expect, type Page } from './fixtures.ts';
import { webVaultOnGitHub } from './web-github.ts';
import { webTest as test } from './web-test.ts';
import {
  GARDEN_VAULT,
  PLAN,
  readsKeptOnTheDevice,
  saveStatus,
  signedInOnTheWeb,
} from './web-vault.ts';

/**
 * #669: the web build's core loop on an iPad, by finger, against the fake
 * GitHub: sign in, the vault and its tree, a note edited and committed,
 * Today and the Inbox from the browser's index, search, and signing out
 * leaving nothing of the vault on the device. Every step taps.
 */

const goTo = (page: Page, name: RegExp) =>
  page.getByRole('list', { name: 'Go to' }).getByRole('button', { name });

test('on the web, a finger signs in, edits a note into a commit, and runs Today, the Inbox and search', async ({
  page,
  webUrl,
}) => {
  const { github } = await webVaultOnGitHub(page, GARDEN_VAULT);

  await test.step('signed in by a tap, the vault and its tree are there', async () => {
    await signedInOnTheWeb(page, { url: webUrl, press: (button) => button.tap() });
    await expect(page.getByRole('navigation', { name: 'Vault' })).toContainText('larkspur-vault');
    const tree = page.getByRole('tree');
    for (const name of ['Inbox', 'Tasks', 'Garden plan'])
      await expect(tree.getByRole('treeitem', { name, exact: true })).toBeVisible();
  });

  await test.step('a note, opened and edited by a tap, is committed', async () => {
    await page.getByRole('treeitem', { name: 'Garden plan', exact: true }).tap();
    await caretAtLineEndByTap(page.getByLabel('Note', { exact: true }).getByText('First line.'));
    await page.keyboard.type(' Tapped.');
    await expect(saveStatus(page)).toHaveText('Saved', { timeout: 10_000 });
    await expect
      .poll(() => github.textAt('Garden plan.md'))
      .toBe(PLAN.replace('.\n', '. Tapped.\n'));
    expect(await github.history()).toContain('Save Garden plan.md');
  });

  await test.step('Today, by a tap, lists the next action from the index', async () => {
    await goTo(page, /^Today/).tap();
    const nextActions = page
      .getByRole('article', { name: 'Today' })
      .getByRole('region', { name: 'Next actions', exact: true });
    await expect(
      nextActions.getByRole('button', { name: 'Sow the beans', exact: true }),
    ).toBeVisible();
  });

  await test.step('the Inbox, by a tap, lists what waits to be processed', async () => {
    await goTo(page, /^Inbox/).tap({ timeout: 5_000 });
    const inbox = page.getByRole('article', { name: 'Inbox' });
    await expect(inbox.getByRole('button', { name: 'Seed swap idea', exact: true })).toBeVisible();
  });

  await test.step('search, by a tap, finds a note by a word in its body and opens it', async () => {
    await goTo(page, /^Search/).tap();
    await page.getByRole('searchbox', { name: 'Search the vault' }).fill('sourdough');
    const hit = page
      .getByRole('dialog', { name: 'Search notes' })
      .getByRole('option', { name: /Seed swap idea/ });
    await expect(hit).toBeVisible();
    await hit.tap();
    await expect(
      page.getByLabel('Note', { exact: true }).getByText('Ask about the sourdough starter.'),
    ).toBeVisible();
  });
});

test('on the web, signing out by a tap leaves nothing of the vault on the iPad', async ({
  page,
  webUrl,
}) => {
  const { unreachable, signInUnreachable } = await webVaultOnGitHub(page, GARDEN_VAULT);
  await signedInOnTheWeb(page, { url: webUrl, press: (button) => button.tap() });
  await page.getByRole('treeitem', { name: 'Garden plan', exact: true }).tap();
  await expect(page.getByLabel('Note', { exact: true }).getByText('First line.')).toBeVisible();
  await expect.poll(() => readsKeptOnTheDevice(page)).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Sign out' }).tap();
  await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible();
  await expect.poll(() => readsKeptOnTheDevice(page)).toBe(0);

  // With nothing reachable, a device that kept the vault opens it (web-offline-save.ipad.spec.ts);
  // one signed out has nothing to open, so it asks to sign in.
  unreachable(true);
  signInUnreachable(true);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible();
  await expect(page.getByRole('tree')).toHaveCount(0);
  await expect(page.getByText('First line.')).toHaveCount(0);
});
