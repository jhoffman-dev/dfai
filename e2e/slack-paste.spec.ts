import { expect, test, type Locator, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, type FakeHost, type FakeVault } from './host.ts';

/**
 * #105: a Slack message link pasted into a note is read through the host,
 * offered, and saved to the Inbox once — a second paste finds it in the
 * vault. The host is stubbed (`host.ts`) to answer Slack's Web API; the
 * Keychain, the pinned origin and the token struck from every answer are
 * Rust's (`slack.rs`). All names are made up.
 */

const TOKEN = 'xoxp-1111-2222-fictional0123456789';
const CHANNEL = 'C0LARK5PUR';
const TS = '1793136000.000100';
const PERMALINK = `https://larkspur.slack.com/archives/${CHANNEL}/p1793136000000100`;
const PATH =
  'Inbox/Captures/Can you send the Larkspur renewal by Friday cc @Tobias Fenn (slack 2db9a3ee76a9e132).md';
const NUMBERED = PATH.replace(').md', ' 2).md');

function serveSlack(host: FakeHost) {
  host.slack.serve('auth.test', { ok: true, team: 'Larkspur Payroll', user: 'mara' });
  host.slack.serve('conversations.replies', {
    ok: true,
    messages: [
      {
        ts: TS,
        user: 'U0MARAQ111',
        text: 'Can you send the *Larkspur* renewal by Friday? cc <@U0TOBIAS22>',
      },
      { ts: '1793136300.000200', thread_ts: TS, user: 'U0TOBIAS22', text: 'On it.' },
    ],
  });
  host.slack.serve('chat.getPermalink', { ok: true, channel: CHANNEL, permalink: PERMALINK });
  for (const [id, name] of [
    ['U0MARAQ111', 'Mara Quill'],
    ['U0TOBIAS22', 'Tobias Fenn'],
  ] as const) {
    host.slack.serveUser(id, {
      ok: true,
      user: {
        id,
        profile: {
          display_name: name,
          email: `${name.toLowerCase().replace(' ', '.')}@example.com`,
        },
      },
    });
  }
}

async function openVault(page: Page): Promise<{ host: FakeHost; vault: FakeVault }> {
  const vault = await createVault();
  await vault.write('first.md', '# First\n');
  const host = await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return { host, vault };
}

async function connectSlack(page: Page) {
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  // Its body is drawn once the section is shown: choose it in the list.
  await settings
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Slack' })
    .click();
  const card = settings.getByRole('region', { name: 'Slack' });
  await expect(card.getByTestId('slack-token')).toHaveText('Not connected on this Mac');
  await card.getByLabel('Slack user token', { exact: true }).fill(TOKEN);
  await card.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(card.getByTestId('slack-token')).toHaveText('Connected as mara in Larkspur Payroll');
  await expect(card.getByLabel('Slack user token', { exact: true })).toHaveValue('');
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(settings).toHaveCount(0);
}

/** Pastes `text` into `target` as the clipboard's plain text, as ⌘V would hand it to the webview. */
async function paste(target: Locator, text: string) {
  await target.evaluate((element, pasted) => {
    const transfer = new DataTransfer();
    transfer.setData('text/plain', pasted);
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, text);
}

const offer = (page: Page) => page.getByRole('region', { name: 'Slack message' });

test('a pasted Slack link is previewed, saved as an Inbox task once, and found in the vault the second time', async ({
  page,
}) => {
  const { host, vault } = await openVault(page);
  serveSlack(host);
  await connectSlack(page);
  expect(await page.content()).not.toContain(TOKEN);

  await page.getByRole('treeitem', { name: 'first', exact: true }).click();
  const editor = page.locator('.editor');
  await expect(editor).toBeVisible();
  await paste(editor, PERMALINK);

  await expect(offer(page)).toContainText('Mara Quill');
  await expect(offer(page).getByTestId('slack-offer-text')).toHaveText(
    'Can you send the Larkspur renewal by Friday? cc @Tobias Fenn',
  );
  await expect(offer(page)).toContainText('1 reply');
  await offer(page).getByRole('button', { name: 'Save as task' }).click();
  await expect(offer(page).getByRole('status')).toHaveText('Saved to the Inbox as a task.');
  await expectFile(vault, PATH).toContain('status: inbox');
  await expectFile(vault, PATH).toContain(`external_id: '${CHANNEL}/${TS}'`);
  await expectFile(vault, PATH).toContain('On it.');

  await offer(page).getByRole('button', { name: 'Dismiss' }).click();
  await expect(offer(page)).toHaveCount(0);
  await paste(editor, PERMALINK);
  await offer(page).getByRole('button', { name: 'Save as task' }).click();
  await expect(offer(page).getByRole('status')).toHaveText('Already in your vault.');
  expect(await vault.exists(NUMBERED)).toBe(false);

  const methods = host.slack.requests().map((request) => request.method);
  expect(methods.filter((method) => method === 'conversations.replies')).toHaveLength(2);
  expect(await page.content()).not.toContain(TOKEN);
});

test('without Slack connected, a link pasted into quick capture says how to connect and saves nothing', async ({
  page,
}) => {
  const { host, vault } = await openVault(page);
  serveSlack(host);
  await page.keyboard.down('Meta');
  await page.keyboard.down('Shift');
  await page.keyboard.press('N');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Meta');
  const capture = page.getByRole('dialog', { name: 'Capture a task' });
  await expect(capture).toBeVisible();

  await paste(capture.getByLabel('What needs doing'), PERMALINK);

  const said = capture.getByRole('region', { name: 'Slack message' });
  await expect(said.getByRole('alert')).toHaveText('Slack is not connected on this Mac.');
  await expect(said).toContainText('Connect Slack in Settings → Slack');
  expect(host.slack.requests()).toEqual([]);
  await said.getByRole('button', { name: 'Open Settings' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Settings' }).getByRole('region', { name: 'Slack' }),
  ).toBeVisible();
  expect(await vault.exists('Inbox/Captures')).toBe(false);
});

test('a link to a message the token cannot read says so, and saves nothing', async ({ page }) => {
  const { host, vault } = await openVault(page);
  serveSlack(host);
  await connectSlack(page);
  host.slack.serve('conversations.replies', { ok: false, error: 'channel_not_found' });

  await page.getByRole('treeitem', { name: 'first', exact: true }).click();
  await paste(page.locator('.editor'), PERMALINK);

  await expect(offer(page).getByRole('alert')).toHaveText(
    'You cannot read this message in Slack: it was deleted, or it is in a conversation you are not in.',
  );
  await expect(offer(page)).toContainText('Only the link was saved.');
  await expect(page.locator('.editor')).toContainText(PERMALINK);
  await expect(offer(page).getByRole('button', { name: 'Save as task' })).toHaveCount(0);
  expect(await vault.exists('Inbox/Captures')).toBe(false);
});

test('opening Settings asks nothing about Slack until its section is shown', async ({ page }) => {
  const { host } = await openVault(page);
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  // The first section drawn, and the Slack section's heading, are there: Settings is open.
  await expect(settings.getByRole('heading', { name: 'Profile' })).toBeVisible();
  await expect(settings.getByRole('heading', { name: 'Slack' })).toHaveCount(1);
  await expect(settings.getByTestId('slack-token')).toHaveCount(0);
  expect(host.slack.statusCalls()).toBe(0);

  await settings
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Slack' })
    .click();
  await expect(settings.getByTestId('slack-token')).toHaveText('Not connected on this Mac');
  expect(host.slack.statusCalls()).toBe(1);
});
