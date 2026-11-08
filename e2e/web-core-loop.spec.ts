import { expect, type Locator, type Page } from './fixtures.ts';
import { webVaultOnGitHub } from './web-github.ts';
import { webTest as test } from './web-test.ts';
import { GARDEN_VAULT, PLAN, saveStatus, signedInOnTheWeb } from './web-vault.ts';

/**
 * #669: the web build's core loop at a desktop's size, by keyboard, against
 * the fake GitHub. web-core-loop.ipad.spec.ts runs it by finger.
 */

/** Presses Enter on `target`, as Tab would have reached it. */
async function enterOn(target: Locator) {
  // Seen first, so a control that never comes fails here rather than at the test's time limit.
  await expect(target).toBeVisible();
  await target.focus();
  await target.press('Enter');
}

/** The caret to the note's end, ⌘↓ as on a Mac (or Ctrl+End where WebKit is Linux's), then `text`. */
async function typeAtTheNoteEnd(page: Page, text: string) {
  await page.getByLabel('Note', { exact: true }).focus();
  // eslint-disable-next-line e2e-flake/no-keys-after-focus -- #797 migrates this
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
  await page.keyboard.type(text);
}

const goTo = (page: Page, name: RegExp) =>
  page.getByRole('list', { name: 'Go to' }).getByRole('button', { name });

/** Opens Garden plan from the tree by arrow keys: from Tasks, one down, and Enter. */
async function openThePlanByKeys(page: Page) {
  const tree = page.getByRole('tree');
  await tree.getByRole('treeitem', { name: 'Tasks', exact: true }).focus();
  // eslint-disable-next-line e2e-flake/no-keys-after-focus -- #797 migrates this
  await page.keyboard.press('ArrowDown');
  await expect(tree.getByRole('treeitem', { name: 'Garden plan', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Note', { exact: true }).getByText('First line.')).toBeVisible();
}

test('on the web, the keyboard signs in, saves a note into a commit, runs Today, the Inbox and search, and signs out', async ({
  page,
  webUrl,
}) => {
  const { github, unreachable, signInUnreachable } = await webVaultOnGitHub(page, GARDEN_VAULT);
  await signedInOnTheWeb(page, { url: webUrl, press: enterOn });

  await test.step('a note, opened from the tree and saved by ⌘S, is committed', async () => {
    await openThePlanByKeys(page);
    await typeAtTheNoteEnd(page, ' Typed.');
    await page.keyboard.press('Meta+s');
    await expect
      .poll(() => github.textAt('Garden plan.md'))
      .toBe(PLAN.replace('.\n', '. Typed.\n'));
    expect(await github.history()).toContain('Save Garden plan.md');
    await expect(saveStatus(page)).toHaveText('Saved');
  });

  await test.step('Today lists the next action from the index', async () => {
    await enterOn(goTo(page, /^Today/));
    const today = page.getByRole('article', { name: 'Today' });
    await expect(
      today
        .getByRole('region', { name: 'Next actions', exact: true })
        .getByRole('button', { name: 'Sow the beans', exact: true }),
    ).toBeVisible();
  });

  await test.step('the Inbox, from Today, lists what waits to be processed', async () => {
    await enterOn(
      page.getByRole('article', { name: 'Today' }).getByRole('button', { name: /^Inbox 1/ }),
    );
    const inbox = page.getByRole('article', { name: 'Inbox' });
    await expect(inbox.getByRole('button', { name: 'Seed swap idea', exact: true })).toBeVisible();
  });

  await test.step('⌘K finds a note by a word in its body, and Enter opens it', async () => {
    await page.keyboard.press('Meta+k');
    await page.getByRole('searchbox', { name: 'Search the vault' }).fill('sourdough');
    const palette = page.getByRole('dialog', { name: 'Search notes' });
    await expect(palette.getByRole('option', { name: /Seed swap idea/ })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(
      page.getByLabel('Note', { exact: true }).getByText('Ask about the sourdough starter.'),
    ).toBeVisible();
  });

  await test.step('signed out by Enter, nothing of the vault is left to open', async () => {
    await enterOn(page.getByRole('button', { name: 'Sign out' }));
    await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible();
    unreachable(true);
    signInUnreachable(true);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible();
    await expect(page.getByRole('tree')).toHaveCount(0);
  });
});

test('on the web, a save refused because a Mac moved the note is kept as a copy, by keyboard', async ({
  page,
  webUrl,
}) => {
  const { github } = await webVaultOnGitHub(page, GARDEN_VAULT);
  await signedInOnTheWeb(page, { url: webUrl, press: enterOn });
  await openThePlanByKeys(page);
  await github.commitOutside({ 'Garden plan.md': '# Garden plan\n\nThe Mac’s line.\n' });

  await typeAtTheNoteEnd(page, ' Mine.');
  await page.keyboard.press('Meta+s');
  const keep = page.getByRole('button', { name: 'Keep mine as a copy' });
  await expect(keep).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'Overwrite the file' })).toHaveCount(0);

  await enterOn(keep);
  await expect.poll(() => github.paths()).toContainEqual(expect.stringMatching(/conflict from/));
  const copy = (await github.paths()).find((path) => path.includes('conflict from'))!;
  expect(await github.textAt(copy)).toContain('First line. Mine.');
  expect(await github.textAt('Garden plan.md')).toBe('# Garden plan\n\nThe Mac’s line.\n');
  await expect(page.getByLabel('Note', { exact: true }).getByText('The Mac’s line.')).toBeVisible();
});
