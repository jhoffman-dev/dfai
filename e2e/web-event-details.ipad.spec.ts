import { expect, test, type Page } from './fixtures.ts';
import { toastSaying } from './toasts.ts';
import { expectFocusIn, focusThenPress } from './typing.ts';
import { signInOnTheWeb, webVaultOnGitHub } from './web-github.ts';
import { GARDEN_VAULT } from './web-vault.ts';

/**
 * #815: a warning in the Activity log opens to its details. A test's
 * ephemeral context is where WebKit refuses the index its storage (#761), so
 * the web build says so, as a warning, on every visit: the line this opens.
 * Unlike `webTest`, this context keeps nothing on disk.
 */

const NOT_KEPT =
  'Search and lists are rebuilt each visit here, because this browser won’t store them.';

const details = (page: Page) => page.getByRole('dialog', { name: 'Warning details' });

test('on the web, a warning line of Activity opens to its details by tap and by key, and closes by Esc and a press outside', async ({
  page,
}) => {
  await webVaultOnGitHub(page, GARDEN_VAULT);
  await signInOnTheWeb(page);
  // Said once to the person, and so kept in Activity by now.
  await expect(toastSaying(page, NOT_KEPT)).toHaveCount(1);

  await page
    .getByRole('list', { name: 'Go to' })
    .getByRole('button', { name: /^Activity/ })
    .tap();
  const line = page
    .getByRole('article', { name: 'Activity' })
    .getByRole('list', { name: 'Activity lines' })
    .getByRole('listitem')
    .filter({ hasText: NOT_KEPT });
  await expect(line).toHaveCount(1);
  const words = line.getByRole('button', { name: /^Search and lists are rebuilt each visit/ });

  await test.step('a tap opens it: the level, the time and the whole message', async () => {
    await words.tap();
    await expect(details(page)).toBeVisible();
    await expect(details(page).getByText('Warning', { exact: true })).toBeVisible();
    await expect(details(page).locator('time')).toHaveText(/, \d\d:\d\d$/);
    await expect(details(page).getByText(NOT_KEPT)).toBeVisible();
    await expect(details(page).getByRole('button', { name: 'Copy' })).toBeVisible();
  });

  await test.step('Esc closes it, and the focus goes back to the line', async () => {
    await expectFocusIn(details(page));
    await page.keyboard.press('Escape');
    await expect(details(page)).toHaveCount(0);
    await expect(words).toBeFocused();
  });

  await test.step('Enter on the line opens it, and a press outside closes it', async () => {
    await focusThenPress(words, 'Enter');
    await expect(details(page)).toBeVisible();
    // The top left corner of the window is the scrim, outside the popup.
    await page.mouse.click(4, 4);
    await expect(details(page)).toHaveCount(0);
  });
});
