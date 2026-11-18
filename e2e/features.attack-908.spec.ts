import { expect, test, type Locator, type Page } from './fixtures.ts';
import { createVault, installHost, type FakeHost } from './host.ts';

/*
 * Attack on PR #908 (#901, slice 2): what a switched-off feature leaves
 * behind. Fictional names only (Larkspur Payroll, Mara Quill).
 */

const SLACK_TOKEN = 'xoxp-1111-2222-fictional0123456789';
const CHANNEL = 'C0LARK5PUR';
const TS = '1793136000.000100';
const PERMALINK = `https://larkspur.slack.com/archives/${CHANNEL}/p1793136000000100`;
const ASK = 'Ask and Claude chat';

async function openVault(page: Page): Promise<FakeHost> {
  const vault = await createVault();
  await vault.write('Garden.md', '# Garden\n\nBeans by [[Orchard]].\n');
  await vault.write('Orchard.md', '# Orchard\n\nApples.\n');
  const host = await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return host;
}

const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings' });

async function switchFeature(page: Page, label: string, on: boolean): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const toggle = settings(page).getByRole('switch', { name: label, exact: true });
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', String(on));
  await page.keyboard.press('Escape');
  await expect(settings(page)).toBeHidden();
}

async function paste(target: Locator, text: string): Promise<void> {
  await target.evaluate((element, pasted) => {
    const transfer = new DataTransfer();
    transfer.setData('text/plain', pasted);
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, text);
}

const slackOffer = (page: Page) => page.getByRole('region', { name: 'Slack message' });

test('a Slack offer put away by switching Slack capture off does not come back when it is on again', async ({
  page,
}) => {
  const host = await openVault(page);
  host.slack.serve('auth.test', { ok: true, team: 'Larkspur Payroll', user: 'mara' });
  host.slack.serve('conversations.replies', {
    ok: true,
    messages: [{ ts: TS, user: 'U0MARAQ111', text: 'Can you send the renewal by Friday?' }],
  });
  host.slack.serve('chat.getPermalink', { ok: true, channel: CHANNEL, permalink: PERMALINK });
  host.slack.serveUser('U0MARAQ111', {
    ok: true,
    user: {
      id: 'U0MARAQ111',
      profile: { display_name: 'Mara Quill', email: 'mara.quill@example.com' },
    },
  });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settings(page)
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Slack', exact: true })
    .click();
  const card = settings(page).getByRole('region', { name: 'Slack' });
  await card.getByLabel('Slack user token', { exact: true }).fill(SLACK_TOKEN);
  await card.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(card.getByTestId('slack-token')).toHaveText('Connected as mara in Larkspur Payroll');
  await page.keyboard.press('Escape');
  await expect(settings(page)).toBeHidden();

  await page.getByRole('treeitem', { name: 'Garden', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Garden' })).toBeVisible();
  await paste(page.locator('.editor'), PERMALINK);
  await expect(slackOffer(page)).toContainText('Mara Quill');

  await switchFeature(page, 'Slack capture', false);
  await expect(slackOffer(page)).toHaveCount(0);
  await switchFeature(page, 'Slack capture', true);
  // Nothing was pasted since: no offer is waiting to be answered.
  await expect(page.getByRole('article', { name: 'Garden' })).toBeVisible();
  await expect(slackOffer(page)).toHaveCount(0);
});

test('with Ask switched off, a kept Ask tab does not ask Claude Code whether it is signed in', async ({
  page,
}) => {
  const host = await openVault(page);
  await page.getByRole('treeitem', { name: 'Garden', exact: true }).click();
  await page.keyboard.press('Meta+j');
  await expect(page.getByRole('article', { name: 'Ask' })).toBeVisible();
  const signedIn = () => host.claude.runs().filter((run) => run.args[0] === 'auth').length;
  // The control: Ask on screen asks once whether Claude Code is signed in.
  await expect.poll(signedIn).toBeGreaterThan(0);

  await switchFeature(page, ASK, false);
  const before = signedIn();
  await page.reload();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: `${ASK} is turned off` })).toBeVisible();
  // A round trip through the window, so an ask made on mount has reached the host.
  await page.keyboard.press('Meta+k');
  await expect(page.getByRole('searchbox', { name: 'Search the vault' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('searchbox', { name: 'Search the vault' })).toBeHidden();
  expect(signedIn()).toBe(before);
});
