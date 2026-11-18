import { expect, test, type Locator, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, type FakeHost, type FakeVault } from './host.ts';

/*
 * Settings → Features (#901, slice 2): Kindle, Ask and Claude chat, Graph and
 * Slack capture each leave the view when switched off — sidebar rows, ⌘K,
 * shortcuts, Settings sections, a note's menu, the paste offer — a tab kept
 * on an off feature's page shows the notice, and switching it on brings it
 * all back. The choice is the vault's, so it survives a reload. Kindle needs
 * Reading: with Reading off, Kindle's row says so and its switch is held.
 * All names are made up.
 */

const SETTINGS = '.atlas/settings.md';
const SLACK_TOKEN = 'xoxp-1111-2222-fictional0123456789';
const CHANNEL = 'C0LARK5PUR';
const TS = '1793136000.000100';
const PERMALINK = `https://larkspur.slack.com/archives/${CHANNEL}/p1793136000000100`;

async function openVault(page: Page): Promise<{ vault: FakeVault; host: FakeHost }> {
  const vault = await createVault();
  await vault.write('Garden.md', '# Garden\n\nBeans by [[Orchard]].\n');
  await vault.write('Orchard.md', '# Orchard\n\nApples.\n');
  const host = await installHost(page, vault);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return { vault, host };
}

async function reloadVault(page: Page): Promise<void> {
  // A reload stands in for quitting and relaunching.
  await page.reload();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
}

const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings' });
const featureSwitch = (page: Page, label: string) =>
  settings(page).getByRole('switch', { name: label, exact: true });
const sectionLink = (page: Page, name: string) =>
  settings(page)
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name, exact: true });

async function openSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(settings(page)).toBeVisible();
}

async function closeSettings(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(settings(page)).toBeHidden();
}

/** Flips one feature's switch in Settings → Features and closes Settings. */
async function switchFeature(page: Page, label: string, on: boolean): Promise<void> {
  await openSettings(page);
  await expect(featureSwitch(page, label)).toBeEnabled();
  await featureSwitch(page, label).click();
  await expect(featureSwitch(page, label)).toHaveAttribute('aria-checked', String(on));
  await closeSettings(page);
}

/** Whether Settings lists each of `sections`, all or none. */
async function expectSections(page: Page, sections: string[], shown: boolean): Promise<void> {
  await openSettings(page);
  // The list is drawn: Features is always in it.
  await expect(sectionLink(page, 'Features')).toHaveCount(1);
  for (const name of sections) await expect(sectionLink(page, name)).toHaveCount(shown ? 1 : 0);
  await closeSettings(page);
}

const sidebarRow = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Vault' }).getByRole('button', { name, exact: true });

/** The palette's options for `query`, the palette left open. */
async function paletteFor(page: Page, query: string): Promise<Locator> {
  await page.keyboard.press('Meta+k');
  await page.getByRole('searchbox', { name: 'Search the vault' }).fill(query);
  return page.getByRole('option', { name: query, exact: true });
}

async function closePalette(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('searchbox', { name: 'Search the vault' })).toBeHidden();
}

const notice = (page: Page, label: string) =>
  page.getByRole('status').filter({ hasText: `${label} is turned off` });
const tabs = (page: Page) => page.getByRole('tablist', { name: 'Pane 1 tabs' }).getByRole('tab');

async function openNote(page: Page, name: string): Promise<void> {
  await page.getByRole('treeitem', { name, exact: true }).click();
  await expect(page.getByRole('article', { name })).toBeVisible();
}

/** Opens the note's page menu, says whether it offers Show in graph, and closes it. */
async function expectShowInGraph(page: Page, offered: boolean): Promise<void> {
  await page.getByRole('button', { name: 'More' }).first().click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem').first()).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /^Show in graph/ })).toHaveCount(offered ? 1 : 0);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
}

test('Graph switched off leaves the sidebar and the note menu, and its kept tab shows the notice', async ({
  page,
}) => {
  const { vault } = await openVault(page);
  await openNote(page, 'Garden');
  await expectShowInGraph(page, true);
  await sidebarRow(page, 'Graph').click();
  await expect(page.locator('.graph__surface')).toBeVisible();
  const before = await tabs(page).count();

  await switchFeature(page, 'Graph', false);
  await expect(notice(page, 'Graph')).toBeVisible();
  await expect(page.locator('.graph__surface')).toHaveCount(0);
  await expect(tabs(page)).toHaveCount(before);
  await expect(sidebarRow(page, 'Graph')).toHaveCount(0);
  await expectFile(vault, SETTINGS).toMatch(/featuresOff:\s*\n\s*- graph/);

  await reloadVault(page);
  await expect(notice(page, 'Graph')).toBeVisible();
  await expect(sidebarRow(page, 'Graph')).toHaveCount(0);
  await openNote(page, 'Garden');
  await expectShowInGraph(page, false);

  await switchFeature(page, 'Graph', true);
  await expect(sidebarRow(page, 'Graph')).toHaveCount(1);
  await expectShowInGraph(page, true);
  await sidebarRow(page, 'Graph').click();
  await expect(page.locator('.graph__surface')).toBeVisible();
  await expect(notice(page, 'Graph')).toHaveCount(0);
});

const askPage = (page: Page) => page.getByRole('article', { name: 'Ask' });
const ASK = 'Ask and Claude chat';

test('Ask and Claude chat switched off leaves the sidebar, ⌘J, ⇧⌘J and the bar, and keeps Settings → Claude', async ({
  page,
}) => {
  const { vault } = await openVault(page);
  await openNote(page, 'Garden');
  await expect(page.getByRole('button', { name: 'Claude', exact: true }).first()).toBeVisible();
  await page.keyboard.press('Meta+j');
  await expect(askPage(page)).toBeVisible();

  await switchFeature(page, ASK, false);
  await expect(notice(page, ASK)).toBeVisible();
  await expect(askPage(page)).toHaveCount(0);
  await expect(sidebarRow(page, 'Ask')).toHaveCount(0);
  await expectFile(vault, SETTINGS).toMatch(/featuresOff:\s*\n\s*- ask/);

  await reloadVault(page);
  await expect(notice(page, ASK)).toBeVisible();
  await openNote(page, 'Garden');
  await expect(page.getByRole('button', { name: 'Claude', exact: true })).toHaveCount(0);
  // ⌘J and ⇧⌘J open nothing: the note stays, and no chat comes up beside it.
  await page.keyboard.press('Meta+j');
  await page.keyboard.press('Shift+Meta+j');
  await expect(page.getByRole('article', { name: 'Garden' })).toBeVisible();
  await expect(askPage(page)).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Claude' })).toHaveCount(0);
  // Settings → Claude stays: its provider and model are what Suggest and rules use.
  await expectSections(page, ['Claude'], true);

  await switchFeature(page, ASK, true);
  await expect(sidebarRow(page, 'Ask')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Claude', exact: true }).first()).toBeVisible();
  await page.keyboard.press('Meta+j');
  await expect(askPage(page)).toBeVisible();
});

test('with Ask off, a Claude tab kept in the right sidebar asks Claude Code nothing after a reload', async ({
  page,
}) => {
  const { host, vault } = await openVault(page);
  await openNote(page, 'Garden');
  await page.keyboard.press('Shift+Meta+j');
  const chat = page.getByRole('complementary', { name: 'Claude' });
  await expect(chat).toBeVisible();
  const signedIn = () => host.claude.runs().filter((run) => run.args[0] === 'auth').length;
  // The control: the chat on screen asks whether Claude Code is signed in.
  await expect.poll(signedIn).toBeGreaterThan(0);

  await switchFeature(page, ASK, false);
  await expect(chat).toHaveCount(0);
  // Held in the file before the reload, or the window relaunches with Ask on.
  await expectFile(vault, SETTINGS).toMatch(/featuresOff:\s*\n\s*- ask/);
  const before = signedIn();
  await reloadVault(page);
  await openNote(page, 'Garden');
  await expect(chat).toHaveCount(0);
  // A round trip through the window, so an ask made as it mounted has reached the host.
  await page.keyboard.press('Meta+k');
  await expect(page.getByRole('searchbox', { name: 'Search the vault' })).toBeVisible();
  await closePalette(page);
  expect(signedIn()).toBe(before);

  // Back on, the right sidebar's remembered Claude tab is the chat again, and asks as before.
  await switchFeature(page, ASK, true);
  await expect(chat).toBeVisible();
  await expect.poll(signedIn).toBeGreaterThan(before);
});

function serveSlack(host: FakeHost): void {
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
}

async function connectSlack(page: Page): Promise<void> {
  await openSettings(page);
  await sectionLink(page, 'Slack').click();
  const card = settings(page).getByRole('region', { name: 'Slack' });
  await card.getByLabel('Slack user token', { exact: true }).fill(SLACK_TOKEN);
  await card.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(card.getByTestId('slack-token')).toHaveText('Connected as mara in Larkspur Payroll');
  await closeSettings(page);
}

/** Pastes `text` into `target` as the clipboard's plain text, as ⌘V would hand it to the webview. */
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

test('Slack capture switched off offers no pasted link and leaves Settings, until it is on again', async ({
  page,
}) => {
  const { vault, host } = await openVault(page);
  serveSlack(host);
  await connectSlack(page);
  await openNote(page, 'Garden');
  const editor = page.locator('.editor');
  await paste(editor, PERMALINK);
  await expect(slackOffer(page)).toContainText('Mara Quill');

  // The offer up as Slack capture is switched off goes with it.
  await switchFeature(page, 'Slack capture', false);
  await expect(slackOffer(page)).toHaveCount(0);
  await expectFile(vault, SETTINGS).toMatch(/featuresOff:\s*\n\s*- slack/);

  await reloadVault(page);
  await expectSections(page, ['Slack'], false);
  await openNote(page, 'Garden');
  await paste(page.locator('.editor'), PERMALINK);
  // The paste lands as text and nothing is read from Slack for it.
  await expect(page.locator('.editor')).toContainText('larkspur.slack.com');
  await expect(slackOffer(page)).toHaveCount(0);

  await switchFeature(page, 'Slack capture', true);
  await expectSections(page, ['Slack'], true);
  await paste(page.locator('.editor'), PERMALINK);
  await expect(slackOffer(page)).toContainText('Mara Quill');
});

/** Whether ⌘K offers Connect Kindle, as it does on a Mac not yet connected. */
async function expectConnectKindle(page: Page, offered: boolean): Promise<void> {
  const option = await paletteFor(page, 'Connect Kindle');
  await expect(option).toHaveCount(offered ? 1 : 0);
  await closePalette(page);
}

test('Kindle switched off leaves ⌘K and Settings, across a reload, and comes back on', async ({
  page,
}) => {
  const { vault } = await openVault(page);
  await expectConnectKindle(page, true);
  await expectSections(page, ['Kindle'], true);

  await switchFeature(page, 'Kindle', false);
  await expectConnectKindle(page, false);
  await expectSections(page, ['Kindle'], false);
  await expectFile(vault, SETTINGS).toMatch(/featuresOff:\s*\n\s*- kindle/);

  await reloadVault(page);
  await expectConnectKindle(page, false);

  await switchFeature(page, 'Kindle', true);
  await expectConnectKindle(page, true);
  await expectSections(page, ['Kindle'], true);
});

test('Reading off holds Kindle off, saying it needs Reading, and writes only Reading', async ({
  page,
}) => {
  const { vault } = await openVault(page);
  await switchFeature(page, 'Reading', false);
  await expectFile(vault, SETTINGS).toMatch(/featuresOff:\s*\n\s*- reading\s*\n---/);

  await openSettings(page);
  await expect(featureSwitch(page, 'Kindle')).toBeDisabled();
  await expect(featureSwitch(page, 'Kindle')).toHaveAttribute('aria-checked', 'false');
  const kindleRow = settings(page)
    .locator('.settings__row')
    // Relative to the row: the switch, not the dialog it is in.
    .filter({ has: page.getByRole('switch', { name: 'Kindle', exact: true }) });
  await expect(kindleRow).toContainText('Needs Reading.');
  await expect(sectionLink(page, 'Kindle')).toHaveCount(0);
  await closeSettings(page);
  await expectConnectKindle(page, false);

  await switchFeature(page, 'Reading', true);
  await openSettings(page);
  await expect(featureSwitch(page, 'Kindle')).toBeEnabled();
  await expect(featureSwitch(page, 'Kindle')).toHaveAttribute('aria-checked', 'true');
  await closeSettings(page);
  await expectConnectKindle(page, true);
  await expectFile(vault, SETTINGS).toContain('featuresOff: []');
});
