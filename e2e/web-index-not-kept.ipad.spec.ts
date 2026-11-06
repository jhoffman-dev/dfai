import { expect, test } from './fixtures.ts';
import { toastSaying } from './toasts.ts';
import { signInOnTheWeb, webVaultOnGitHub } from './web-github.ts';
import { GARDEN_VAULT } from './web-vault.ts';

/**
 * #761: where the browser refuses the index its storage, the web build keeps
 * the index in memory for the visit. A test's ephemeral context is such a
 * place: WebKit refuses it OPFS's file handles ("an unknown transient
 * reason"), as Private Browsing may. Today still lists the vault's next
 * action, and the person is told, once, why it is built again each visit.
 * Unlike `webTest`, this context keeps nothing on disk.
 */

const NOT_KEPT =
  'Search and lists are rebuilt each visit here, because this browser won’t store them.';

test('where OPFS is refused, Today lists the next action from an index in memory, and says once why', async ({
  page,
}) => {
  await webVaultOnGitHub(page, GARDEN_VAULT);
  await signInOnTheWeb(page);

  await page
    .getByRole('list', { name: 'Go to' })
    .getByRole('button', { name: /^Today/ })
    .tap();
  const nextActions = page
    .getByRole('article', { name: 'Today' })
    .getByRole('region', { name: 'Next actions', exact: true });
  await expect(
    nextActions.getByRole('button', { name: 'Sow the beans', exact: true }),
  ).toBeVisible();
  await expect(toastSaying(page, NOT_KEPT)).toHaveCount(1);
});
