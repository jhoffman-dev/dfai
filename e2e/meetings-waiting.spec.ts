import { readFileSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { expect, test, type Page } from './fixtures.ts';
import { createVault, emitVaultChanged, installHost } from './host.ts';
import { otherMac } from './git-host.ts';

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
const syncCard = (page: Page) => page.getByRole('region', { name: 'Sync' });

async function openVault(page: Page) {
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
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return { vault, host };
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
  await expect(banner(page)).toHaveText('2 meetings waiting for Laptop');
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
  await expect(banner(page)).toHaveText('2 meetings waiting for Laptop');
  await goTo(page).getByRole('button', { name: 'Activity', exact: true }).click();
  await expect(warnings).toHaveCount(1);

  // A sync that brings nothing new keeps the count and warns of nothing (#627 review).
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await syncCard(page).getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByTestId('sync-status')).toContainText('Synced at');
  await page.keyboard.press('Escape');
  await openInbox(page);
  await expect(banner(page)).toHaveText('2 meetings waiting for Laptop');
  await goTo(page).getByRole('button', { name: 'Activity', exact: true }).click();
  await expect(warnings).toHaveCount(1);
});
