import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost } from './host.ts';

/**
 * #30: blocks sync two ways with the calendar DFAI made. The host's commands
 * are stubbed (`host.ts`), its Calendar answering `events.list`, `insert` and
 * `patch` on that calendar as Google does; the host's side of each call is
 * tested in Rust (`google/tests/events.rs`), and the adapter against a fake
 * on the loopback (`tauri-block-calendar.test.ts`).
 */

test.use({ timezoneId: 'America/Los_Angeles' });

/** 09:00 in Los Angeles on Sunday 2026-10-25. */
const NOW = new Date('2026-10-25T16:00:00Z');
const CLIENT_ID = '123456789012-abcdef0123456789abcdef0123456789.apps.googleusercontent.com';
const BLOCK = 'Larkspur close block.md';

const blockNote = [
  '---',
  'type: block',
  'start: 2026-10-26T09:00',
  'end: 2026-10-26T10:00',
  'owner: Mara Quill',
  '---',
  'Bring the Q4 close numbers.',
  '',
].join('\n');

const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings' });
const card = (page: Page) => settings(page).getByRole('region', { name: 'Google Calendar' });
const blocksPart = (page: Page) => card(page).getByRole('group', { name: 'Blocks' });

async function connected(page: Page) {
  const vault = await createVault();
  await vault.write(BLOCK, blockNote);
  const host = await installHost(page, vault);
  await page.clock.setFixedTime(NOW);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await card(page).getByRole('textbox', { name: 'OAuth client ID' }).fill(CLIENT_ID);
  await card(page).getByRole('button', { name: 'Connect' }).click();
  await card(page).getByRole('button', { name: 'Create “DFAI blocks”' }).click();
  await expect(card(page).getByText('Connected. Blocks go to DFAI blocks.')).toBeVisible();
  return { vault, host };
}

test('a block appears as a busy event and as synced; moving the event in Google moves the block, its body kept', async ({
  page,
}) => {
  const { vault, host } = await connected(page);
  await expect(blocksPart(page)).toContainText('Blocks are not on Google Calendar yet.');
  expect(host.google.blockEvents()).toEqual([]);

  await blocksPart(page).getByRole('button', { name: 'Sync blocks with Google Calendar' }).click();

  await expectFile(vault, '.atlas/settings.md').toContain('google_blocks: true');
  await expect.poll(() => host.google.blockEvents().length).toBe(1);
  const [event] = host.google.blockEvents();
  expect(event).toMatchObject({
    summary: 'Larkspur close block',
    start: { dateTime: '2026-10-26T09:00:00', timeZone: 'America/Los_Angeles' },
    end: { dateTime: '2026-10-26T10:00:00', timeZone: 'America/Los_Angeles' },
    transparency: 'opaque',
  });
  await expectFile(vault, BLOCK).toContain(`gcal_event_id: ${String(event?.['id'])}`);
  await expectFile(vault, BLOCK).toContain('gcal_etag:');
  await expect(blocksPart(page)).toContainText('last synced at');

  host.google.moveBlockEvent(
    String(event?.['id']),
    '2026-10-26T15:00:00-07:00',
    '2026-10-26T16:30:00-07:00',
  );
  await blocksPart(page).getByRole('button', { name: 'Sync blocks now' }).click();

  await expectFile(vault, BLOCK).toContain('start: 2026-10-26T15:00');
  const moved = await vault.read(BLOCK);
  expect(moved).toContain('end: 2026-10-26T16:30');
  expect(moved).toContain('owner: Mara Quill');
  expect(moved).toContain('Bring the Q4 close numbers.');
  // Pulled, it is not pushed back: Google holds the one insert.
  expect(host.google.blockEvents()).toHaveLength(1);
});

test('a vault that has not turned block sync on writes nothing to Google', async ({ page }) => {
  const { vault, host } = await connected(page);
  await expect(blocksPart(page)).toContainText('Blocks are not on Google Calendar yet.');
  expect(host.google.blockEvents()).toEqual([]);
  expect(await vault.read(BLOCK)).toBe(blockNote);
});

test('a sync Google refuses says why in Settings, and the block is left as it was', async ({
  page,
}) => {
  const { vault, host } = await connected(page);
  host.google.refuseNextBlockCall(503);
  await blocksPart(page).getByRole('button', { name: 'Sync blocks with Google Calendar' }).click();

  await expect(blocksPart(page).getByRole('alert')).toContainText('503');
  expect(host.google.blockEvents()).toEqual([]);
  expect(await vault.read(BLOCK)).toBe(blockNote);
});
