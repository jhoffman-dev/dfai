import { utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost, type FakeHost, type FakeVault } from './host.ts';

/*
 * Settings → Features (#901, slice 3): Automations and Meetings. Off, no
 * rule runs, nothing is pulled from Granola and no calendar is read for
 * meetings; a tab kept on Automations shows the notice, from which a run
 * already made can still be undone; switching on brings it all back, with no
 * restart. The choice is the vault's, so it survives a reload. Every claim
 * about a note reads the disk. All names are made up.
 */

const SETTINGS = '.atlas/settings.md';
const SWEEP_LOG = '.atlas/automations/log/Sweep.md';
const DAY_MS = 86_400_000;

const TASK_TYPE = [
  '---',
  'name: task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [backlog, doing, done]',
  '---',
  '',
].join('\n');

/** Archives done tasks a month old each time DFAI opens. */
const SWEEP = [
  '---',
  'atlas: automation',
  'name: Sweep',
  'enabled: true',
  'when: on app open',
  'which: FROM task WHERE status = done',
  'olderThanDays: 30',
  'do: archive',
  '---',
  '',
].join('\n');

/** A done task last touched forty days ago: what Sweep archives. */
async function writeOldDone(vault: FakeVault, name: string): Promise<void> {
  const path = `Tasks/${name}.md`;
  await vault.write(path, '---\ntype: task\nstatus: done\n---\n\n');
  const old = new Date(Date.now() - 40 * DAY_MS);
  await utimes(join(vault.root, path), old, old);
}

async function openVault(
  page: Page,
  prepare: (vault: FakeVault) => Promise<void> = async () => {},
): Promise<{ vault: FakeVault; host: FakeHost }> {
  const vault = await createVault();
  await vault.write('Garden.md', '# Garden\n\nBeans.\n');
  await prepare(vault);
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
  await expect(featureSwitch(page, label)).toHaveAttribute('aria-disabled', 'false');
  await featureSwitch(page, label).click();
  await expect(featureSwitch(page, label)).toHaveAttribute('aria-checked', String(on));
  await closeSettings(page);
}

const sidebarRow = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Vault' }).getByRole('button', { name, exact: true });
const notice = (page: Page, label: string) =>
  page.getByRole('status').filter({ hasText: `${label} is turned off` });
const rulesList = (page: Page) => page.getByRole('list', { name: 'All automations' });
const opened = (text: string) => text.match(/· Ran when DFAI opened/g)?.length ?? 0;

/** A round trip through the window, so whatever it asked for as it mounted has reached the host. */
async function roundTrip(page: Page): Promise<void> {
  await page.keyboard.press('Meta+k');
  const search = page.getByRole('searchbox', { name: 'Search the vault' });
  await expect(search).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(search).toBeHidden();
}

test('Automations switched off runs no rule, its kept tab shows the notice and can still undo a run, and on again runs them', async ({
  page,
}) => {
  const { vault } = await openVault(page, async (made) => {
    await made.mkdir('.atlas/types');
    await made.mkdir('.atlas/automations');
    await made.mkdir('Tasks');
    await made.write('.atlas/types/task.md', TASK_TYPE);
    await made.write('.atlas/automations/Sweep.md', SWEEP);
    await writeOldDone(made, 'Old done');
  });
  // The control: on, the rule runs as the vault opens.
  await expect.poll(() => vault.exists('Archive/Tasks/Old done.md')).toBe(true);
  await expectFile(vault, SWEEP_LOG).toContain('· Ran when DFAI opened');
  await sidebarRow(page, 'Automations').click();
  await expect(rulesList(page)).toBeVisible();

  await switchFeature(page, 'Automations', false);
  await expect(notice(page, 'Automations')).toBeVisible();
  await expect(rulesList(page)).toHaveCount(0);
  await expect(sidebarRow(page, 'Automations')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo last run of Sweep' })).toBeVisible();
  // Held in the file before the reload, or the window relaunches with Automations on.
  await expectFile(vault, SETTINGS).toMatch(/featuresOff:\s*\n\s*- automations/);

  // A task the rule would archive on the next opening: off, it stays put.
  await writeOldDone(vault, 'Late done');
  await reloadVault(page);
  await expect(notice(page, 'Automations')).toBeVisible();
  await expect(sidebarRow(page, 'Automations')).toHaveCount(0);
  await roundTrip(page);
  expect(opened(await vault.read(SWEEP_LOG))).toBe(1);
  expect(await vault.exists('Tasks/Late done.md')).toBe(true);

  // What the rule did can still be undone with the feature off.
  await page.getByRole('button', { name: 'Undo last run of Sweep' }).click();
  await expect.poll(() => vault.exists('Tasks/Old done.md')).toBe(true);
  expect(await vault.exists('Archive/Tasks/Old done.md')).toBe(false);
  await expectFile(vault, SWEEP_LOG).toContain('· Undid the run of ');
  expect(opened(await vault.read(SWEEP_LOG))).toBe(1);

  // On again, with no restart: the rules carry on, a rule run on opening as when the vault opens.
  await switchFeature(page, 'Automations', true);
  await expect(sidebarRow(page, 'Automations')).toHaveCount(1);
  await expect(rulesList(page)).toBeVisible();
  await expect(notice(page, 'Automations')).toHaveCount(0);
  await expect.poll(() => vault.exists('Archive/Tasks/Late done.md')).toBe(true);
  await expect.poll(async () => opened(await vault.read(SWEEP_LOG))).toBe(2);
});

const KEY = 'grn_fictional0123456789abcdef';
const CLIENT_ID = '123456789012-abcdef0123456789abcdef0123456789.apps.googleusercontent.com';
const googleCard = (page: Page) => settings(page).getByRole('region', { name: 'Google Calendar' });
const granolaCard = (page: Page) => settings(page).getByRole('region', { name: 'Granola' });
const meetingsPart = (page: Page) => googleCard(page).getByRole('group', { name: 'Meetings' });

/** Sets a Granola key and lets Google read meetings, from Settings, and waits for each to be used. */
async function connectMeetings(page: Page, host: FakeHost): Promise<void> {
  host.granola.serve('/v1/notes', {
    status: 200,
    body: JSON.stringify({ notes: [], hasMore: false, cursor: null }),
  });
  host.google.serveEvents('primary', []);
  await openSettings(page);
  await granolaCard(page).getByLabel('Granola API key', { exact: true }).fill(KEY);
  await granolaCard(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(granolaCard(page).getByTestId('granola-key')).toHaveText('Key accepted');
  await expect.poll(() => host.granola.requests().length).toBeGreaterThan(0);
  await googleCard(page).getByRole('textbox', { name: 'OAuth client ID' }).fill(CLIENT_ID);
  await googleCard(page).getByRole('button', { name: 'Connect' }).click();
  await meetingsPart(page).getByRole('button', { name: 'Allow reading meetings' }).click();
  await expect.poll(() => host.google.eventsAsked()).toBeGreaterThan(0);
  await closeSettings(page);
}

test('Meetings switched off pulls nothing from Granola and reads no meetings, keeps the sign-ins and time blocks’ card, and on again pulls', async ({
  page,
}) => {
  const { vault, host } = await openVault(page);
  await connectMeetings(page, host);

  await switchFeature(page, 'Meetings', false);
  await expectFile(vault, SETTINGS).toMatch(/featuresOff:\s*\n\s*- meetings/);
  await openSettings(page);
  await expect(sectionLink(page, 'Features')).toHaveCount(1);
  await expect(sectionLink(page, 'Granola')).toHaveCount(0);
  // The card stays for the sign-in and time blocks; only its meetings part goes.
  await expect(sectionLink(page, 'Google Calendar')).toHaveCount(1);
  await expect(googleCard(page)).toBeVisible();
  await expect(meetingsPart(page)).toHaveCount(0);
  await closeSettings(page);
  // The key and the sign-in are kept, for when Meetings is on again.
  expect(host.granola.hasKey()).toBe(true);
  expect(host.google.connected()).toBe(true);

  const pulls = host.granola.requests().length;
  const reads = host.google.eventsAsked();
  await reloadVault(page);
  await roundTrip(page);
  await expect(page.getByRole('treeitem', { name: 'Garden', exact: true })).toBeVisible();
  expect(host.granola.requests()).toHaveLength(pulls);
  expect(host.google.eventsAsked()).toBe(reads);

  // On again, with no restart: Granola pulls as on opening, and today's meetings are read.
  await switchFeature(page, 'Meetings', true);
  await expect.poll(() => host.granola.requests().length).toBeGreaterThan(pulls);
  await expect.poll(() => host.google.eventsAsked()).toBeGreaterThan(reads);
  await openSettings(page);
  await expect(sectionLink(page, 'Granola')).toHaveCount(1);
  await expect(meetingsPart(page)).toBeVisible();
});
