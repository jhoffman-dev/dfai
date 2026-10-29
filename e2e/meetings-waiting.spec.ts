import { readFileSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { expect, test, type Browser, type Page } from './fixtures.ts';
import { createVault, emitVaultChanged, installHost, type FakeVault } from './host.ts';
import { gitIn, otherMac } from './git-host.ts';

/**
 * #175 (ADR-0035 part 1): a Mac that is not named stops dropping meetings
 * silently. Once a pull shows another Mac is named, the Inbox says how many
 * meetings wait for it — counting only the unstamped ones, never a stamped
 * one or a sync-conflict copy — and Activity warns once. The named Mac says
 * nothing. "GitHub" is a bare repository on disk and git is the Mac's own.
 */

const shipped = (path: string) =>
  readFileSync(new URL(`../vault/${path}`, import.meta.url), 'utf8');
const VALID = readFileSync(
  new URL(
    '../packages/domain/src/meetings/fixtures/valid/gemini-platform-sync.md',
    import.meta.url,
  ),
  'utf8',
);
const STAMPED = VALID.replace(/^(atlas_import: .*\n)/m, '$1atlas_import_outcome: imported\n');
const LAPTOP_SETTINGS =
  '---\nsync: github\nautomationsMac: laptop-0000\nautomationsMacName: Laptop\n---\n';

const goTo = (page: Page) => page.getByRole('list', { name: 'Go to' });
const inboxPage = (page: Page) => page.getByRole('article', { name: 'Inbox' });
const banner = (page: Page) => inboxPage(page).getByRole('status', { name: 'Meetings waiting' });
/** The banner's line itself, without the button beside it. */
const bannerLine = (page: Page) => banner(page).locator('p').first();
const syncCard = (page: Page) => page.getByRole('region', { name: 'Sync' });

async function openVault(page: Page, macName?: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  const vault = await createVault();
  for (const folder of ['.atlas/types', '.atlas/views', 'Inbox/Meetings']) {
    await vault.mkdir(folder);
  }
  for (const type of ['task', 'meeting', 'person', 'company', 'project']) {
    await vault.write(`.atlas/types/${type}.md`, shipped(`.atlas/types/${type}.md`));
  }
  await vault.write('.atlas/views/Inbox.md', shipped('.atlas/views/Inbox.md'));
  await vault.write('Inbox/Call Mara.md', '---\ntype: task\nstatus: backlog\n---\n\n# Call Mara\n');
  const host = await installHost(page, vault);
  if (macName !== undefined) host.git.setMacName(macName);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return { vault, host };
}

/** A second Mac running DFAI, in a window of its own: its own id, and a clone of the vault's repository. */
async function secondMac(browser: Browser, remote: string, env: NodeJS.ProcessEnv, name: string) {
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const page = await context.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  const vault: FakeVault = await createVault();
  const cloned = await gitIn(vault.root, ['clone', '--quiet', remote, '.'], env);
  if (cloned.code !== 0) throw new Error(`the second Mac could not clone: ${cloned.stderr}`);
  const host = await installHost(page, vault);
  host.git.setMacName(name);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return { page, vault, host, close: () => context.close() };
}

async function syncNow(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await syncCard(page).getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByTestId('sync-status')).toContainText('Synced at');
}

/** The laptop names itself in the vault's settings and pushes meetings this Mac has not imported. */
async function laptopClaimsWithMeetings(root: string) {
  await mkdir(join(root, 'Inbox/Meetings'), { recursive: true });
  await writeFile(join(root, '.atlas/settings.md'), LAPTOP_SETTINGS);
  await writeFile(join(root, 'Inbox/Meetings/2026-10-27 Larkspur weekly.md'), VALID);
  await writeFile(
    join(root, 'Inbox/Meetings/2026-10-28 Vendor call.md'),
    VALID.replace('gemini-7f3a9c21', 'gemini-11aa22bb'),
  );
  await writeFile(join(root, 'Inbox/Meetings/2026-10-26 Platform sync.md'), STAMPED);
  await writeFile(
    join(root, 'Inbox/Meetings/2026-10-27 Larkspur weekly (conflict from Studio).md'),
    VALID,
  );
}

async function openInbox(page: Page) {
  await goTo(page)
    .getByRole('button', { name: /^Inbox/ })
    .click();
  await expect(inboxPage(page)).toBeVisible();
}

test('a Mac that is not named says how many meetings wait for the named one, and warns once in Activity', async ({
  page,
}) => {
  const { vault, host } = await openVault(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Set up sync with GitHub' }).click();
  await expect(page.getByTestId('sync-status')).toContainText('Synced at');

  // Named after setting sync up, this Mac says nothing waits.
  await page.keyboard.press('Escape');
  await openInbox(page);
  await expect(inboxPage(page).getByText('Call Mara', { exact: true })).toBeVisible();
  await expect(banner(page)).toHaveCount(0);

  // The laptop takes the automations and pushes four meeting files.
  const laptop = await otherMac(host.git, host.git.remote(basename(vault.root)), 'Laptop');
  await laptopClaimsWithMeetings(laptop.root);
  await laptop.commitAndPush('DFAI sync from Laptop 2026-10-28 09:00');

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await syncCard(page).getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByTestId('automations-mac')).toContainText('Laptop');
  await page.keyboard.press('Escape');

  // Two unstamped meetings wait; the stamped one and the conflict copy are not counted.
  await expect(bannerLine(page)).toHaveText('2 meetings waiting for Laptop');
  // This Mac imported nothing.
  expect(await vault.read('Inbox/Meetings/2026-10-27 Larkspur weekly.md')).toBe(VALID);

  // Activity warns once for that pull, and not again as the index hears of a file changing.
  await goTo(page).getByRole('button', { name: 'Activity', exact: true }).click();
  const warnings = page
    .getByRole('article', { name: 'Activity' })
    .getByRole('listitem')
    .filter({ hasText: '2 meetings are waiting for Laptop to process them.' });
  await expect(warnings).toHaveCount(1);
  await vault.write(
    'Inbox/Water the beds.md',
    '---\ntype: task\nstatus: backlog\n---\n\n# Water\n',
  );
  await emitVaultChanged(page, ['Inbox/Water the beds.md']);
  await openInbox(page);
  await expect(inboxPage(page).getByText('Water the beds', { exact: true })).toBeVisible();
  await expect(bannerLine(page)).toHaveText('2 meetings waiting for Laptop');
  await goTo(page).getByRole('button', { name: 'Activity', exact: true }).click();
  await expect(warnings).toHaveCount(1);

  // A sync that brings nothing new keeps the count and warns of nothing (#627 review).
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await syncCard(page).getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByTestId('sync-status')).toContainText('Synced at');
  await page.keyboard.press('Escape');
  await openInbox(page);
  await expect(bannerLine(page)).toHaveText('2 meetings waiting for Laptop');
  await goTo(page).getByRole('button', { name: 'Activity', exact: true }).click();
  await expect(warnings).toHaveCount(1);
});

const STUDIO_SETTINGS =
  '---\nsync: github\nautomationsMac: studio-0000\nautomationsMacName: Studio\n---\n';
const LARKSPUR = 'Inbox/Meetings/2026-10-27 Larkspur weekly.md';
const VENDOR = 'Inbox/Meetings/2026-10-28 Vendor call.md';
const PLANNING = 'Inbox/Meetings/2026-10-29 Planning.md';

test('"Process here" names this Mac, imports what waited, and the other Mac then says meetings wait for it (#176)', async ({
  page,
  browser,
}) => {
  // The desk Mac sets sync up; Studio, a Mac the test drives with git alone, then takes the
  // automations and pushes two meetings neither DFAI window has imported.
  const desk = await openVault(page, 'Desk');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Set up sync with GitHub' }).click();
  await expect(page.getByTestId('sync-status')).toContainText('Synced at');
  await page.keyboard.press('Escape');
  const remote = desk.host.git.remote(basename(desk.vault.root));
  const studio = await otherMac(desk.host.git, remote, 'Studio');
  await mkdir(join(studio.root, 'Inbox/Meetings'), { recursive: true });
  await writeFile(join(studio.root, '.atlas/settings.md'), STUDIO_SETTINGS);
  await writeFile(join(studio.root, LARKSPUR), VALID);
  await writeFile(join(studio.root, VENDOR), VALID.replace('gemini-7f3a9c21', 'gemini-11aa22bb'));
  await studio.commitAndPush('DFAI sync from Studio 2026-10-28 09:00');

  // The laptop opens its own clone and is told what waits for Studio.
  const laptop = await secondMac(browser, remote, desk.host.git.env, 'Laptop');
  await syncNow(laptop.page);
  await expect(laptop.page.getByTestId('automations-mac')).toContainText('Studio');
  await laptop.page.keyboard.press('Escape');
  await openInbox(laptop.page);
  await expect(bannerLine(laptop.page)).toHaveText('2 meetings waiting for Studio');
  const processHere = banner(laptop.page).getByRole('button', { name: 'Process here' });
  await expect(processHere).toBeEnabled();

  await processHere.click();

  // The banner goes, the claim is in the settings, and the import catches up on both meetings.
  await expect(banner(laptop.page)).toHaveCount(0);
  await expect
    .poll(() => laptop.vault.read('.atlas/settings.md'))
    .toContain('automationsMacName: Laptop');
  for (const meeting of [LARKSPUR, VENDOR]) {
    await expect.poll(() => laptop.vault.read(meeting)).toContain('atlas_import_outcome:');
  }
  await goTo(laptop.page).getByRole('button', { name: 'Activity', exact: true }).click();
  await expect(
    laptop.page
      .getByRole('article', { name: 'Activity' })
      .getByRole('listitem')
      .filter({ hasText: 'Laptop now runs the automations' }),
  ).toHaveCount(1);
  // Its stamps go to GitHub.
  await syncNow(laptop.page);
  await laptop.page.keyboard.press('Escape');

  // A new meeting lands. The desk Mac pulls: the laptop is named, and the desk imports nothing.
  await studio.pull();
  await writeFile(join(studio.root, PLANNING), VALID.replace('gemini-7f3a9c21', 'gemini-33cc44dd'));
  await studio.commitAndPush('DFAI sync from Studio 2026-10-29 09:00');
  await syncNow(page);
  await expect(page.getByTestId('automations-mac')).toContainText('Laptop');
  await page.keyboard.press('Escape');
  await openInbox(page);
  await expect(bannerLine(page)).toHaveText('1 meeting waiting for Laptop');
  await expect(banner(page).getByRole('button', { name: 'Process here' })).toBeEnabled();
  expect(await desk.vault.read(PLANNING)).toBe(VALID.replace('gemini-7f3a9c21', 'gemini-33cc44dd'));
  expect(await desk.vault.read(LARKSPUR)).toContain('atlas_import_outcome:');

  await laptop.close();
});

test('two Macs that press "Process here" before either syncs leave one named: the one whose sync comes second (#176)', async ({
  page,
  browser,
}) => {
  const desk = await openVault(page, 'Desk');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Set up sync with GitHub' }).click();
  await expect(page.getByTestId('sync-status')).toContainText('Synced at');
  await page.keyboard.press('Escape');
  const remote = desk.host.git.remote(basename(desk.vault.root));
  const studio = await otherMac(desk.host.git, remote, 'Studio');
  await mkdir(join(studio.root, 'Inbox/Meetings'), { recursive: true });
  await writeFile(join(studio.root, '.atlas/settings.md'), STUDIO_SETTINGS);
  await writeFile(join(studio.root, LARKSPUR), VALID);
  await studio.commitAndPush('DFAI sync from Studio 2026-10-28 09:00');
  const laptop = await secondMac(browser, remote, desk.host.git.env, 'Laptop');
  for (const each of [page, laptop.page]) {
    await syncNow(each);
    await each.keyboard.press('Escape');
    await openInbox(each);
    await expect(bannerLine(each)).toHaveText('1 meeting waiting for Studio');
  }
  /** Who the settings on GitHub name. */
  const namedOnGitHub = async () =>
    (await gitIn(remote, ['show', 'main:.atlas/settings.md'], desk.host.git.env)).stdout;

  // The desk presses, and its sync takes the claim to GitHub.
  await banner(page).getByRole('button', { name: 'Process here' }).click();
  await expect.poll(namedOnGitHub).toContain('automationsMacName: Desk');
  // The laptop, which has not pulled since, presses too: its sync merges, keeping its own.
  await banner(laptop.page).getByRole('button', { name: 'Process here' }).click();
  await expect.poll(namedOnGitHub).toContain('automationsMacName: Laptop');

  // The desk's next sync brings the laptop's claim in, and the desk stands down.
  await syncNow(page);
  await expect(page.getByTestId('automations-mac')).toContainText('Laptop');
  expect(await desk.vault.read('.atlas/settings.md')).toContain('automationsMacName: Laptop');
  await syncNow(laptop.page);
  await expect(laptop.page.getByTestId('automations-mac')).toContainText('Laptop');

  await laptop.close();
});

const RULE = '.atlas/automations/After a meeting.md';
const PROMPT = '.atlas/prompts/after-a-meeting.md';
const RULE_FILE = [
  '---',
  'atlas: automation',
  'name: After a meeting',
  'id: After a meeting',
  'enabled: true',
  'when: a meeting is created',
  'which: FROM meeting',
  'do: claude',
  `prompt: ${PROMPT}`,
  'output: meeting-items',
  'apply: mine',
  '---',
  '',
].join('\n');
const PROMPT_TEXT = 'List what somebody now has to do, what was decided, and what to chase.\n';
/** A meeting the import let in, undated so the rule's 14 days always reach it, that no rule has summarised. */
const IMPORTED_UNDATED = STAMPED.replace(/^date: .*\n/m, '');

test('a Mac that is not named counts an imported meeting whose summary and tasks are still pending (#182)', async ({
  page,
}) => {
  const { vault, host } = await openVault(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Set up sync with GitHub' }).click();
  await expect(page.getByTestId('sync-status')).toContainText('Synced at');
  await page.keyboard.press('Escape');

  // The laptop takes the automations and pushes the "After a meeting" rule and a meeting it let
  // in but never summarised: its Claude is unavailable, so the stamp alone would count nothing.
  const laptop = await otherMac(host.git, host.git.remote(basename(vault.root)), 'Laptop');
  await mkdir(join(laptop.root, 'Inbox/Meetings'), { recursive: true });
  await mkdir(join(laptop.root, '.atlas/automations'), { recursive: true });
  await mkdir(join(laptop.root, '.atlas/prompts'), { recursive: true });
  await writeFile(join(laptop.root, '.atlas/settings.md'), LAPTOP_SETTINGS);
  await writeFile(join(laptop.root, RULE), RULE_FILE);
  await writeFile(join(laptop.root, PROMPT), PROMPT_TEXT);
  await writeFile(
    join(laptop.root, 'Inbox/Meetings/2026-10-26 Platform sync.md'),
    IMPORTED_UNDATED,
  );
  await laptop.commitAndPush('DFAI sync from Laptop 2026-10-28 09:00');

  await syncNow(page);
  await expect(page.getByTestId('automations-mac')).toContainText('Laptop');
  await page.keyboard.press('Escape');
  await openInbox(page);

  await expect(bannerLine(page)).toHaveText('1 meeting waiting for Laptop');
  await goTo(page).getByRole('button', { name: 'Activity', exact: true }).click();
  await expect(
    page
      .getByRole('article', { name: 'Activity' })
      .getByRole('listitem')
      .filter({ hasText: '1 meeting is waiting for Laptop to process it.' }),
  ).toHaveCount(1);
});

test('the Mac that runs the step says once when Claude is unavailable, and nothing once a run gets through (#182)', async ({
  page,
}) => {
  const { vault, host } = await openVault(page);
  await vault.mkdir('.atlas/automations');
  await vault.mkdir('.atlas/prompts');
  await vault.write('.atlas/settings.md', '---\nprofileName: Mara Quill\n---\n');
  await vault.write(RULE, RULE_FILE);
  await vault.write(PROMPT, PROMPT_TEXT);
  await emitVaultChanged(page, ['.atlas/settings.md', RULE, PROMPT]);
  host.claude.loggedIn(false);

  // A meeting arrives: the import lets it in, and the step cannot reach Claude.
  const meeting = 'Inbox/Meetings/2026-10-27 Larkspur weekly.md';
  await vault.write(meeting, VALID);
  await emitVaultChanged(page, [meeting]);
  await expect.poll(() => vault.read(meeting)).toContain('atlas_import_outcome: imported');

  await openInbox(page);
  await expect(bannerLine(page)).toHaveText(
    'Claude is unavailable on this Mac: summaries and tasks are pending.',
  );
  await expect(banner(page)).toContainText('Fix:');
  await expect(banner(page).getByRole('button')).toHaveCount(0);
  await goTo(page)
    .getByRole('button', { name: /^Activity/ })
    .click();
  const said = page
    .getByRole('article', { name: 'Activity' })
    .getByRole('listitem')
    .filter({ hasText: 'Claude is unavailable on this Mac: summaries and tasks are pending.' });
  await expect(said).toHaveCount(1);

  // Logged in, a run by hand gets through: the summary is written and the line goes.
  host.claude.loggedIn(true);
  host.claude.reply(JSON.stringify({ summary: 'Nothing to chase.', key_points: [], items: [] }));
  await goTo(page).getByRole('button', { name: 'Automations' }).click();
  const screen = page.getByRole('article', { name: 'Automations' });
  await screen.getByRole('button', { name: 'After a meeting', exact: true }).click();
  await screen
    .getByRole('region', { name: 'Automation' })
    .getByRole('button', { name: 'Run now' })
    .click();
  await expect.poll(() => vault.read(meeting)).toContain('<!-- atlas:summary v1 -->');
  await openInbox(page);
  await expect(banner(page)).toHaveCount(0);
  await goTo(page)
    .getByRole('button', { name: /^Activity/ })
    .click();
  await expect(said).toHaveCount(1);
});
