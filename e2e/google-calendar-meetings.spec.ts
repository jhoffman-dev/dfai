import { expect, test, type Page } from './fixtures.ts';
import { createVault, expectFile, installHost } from './host.ts';

/**
 * #31: today's meetings from Google Calendar (ADR-0046). The host's commands
 * are stubbed (`host.ts`), its Calendar answering `events.list` as Google
 * does; the sign-in, the token and the host's side of each call are tested in
 * Rust against a fake Google (`google/tests/events.rs`), and the reader of
 * the events against a fake on the loopback (`tauri-calendar-source.test.ts`).
 */

test.use({ timezoneId: 'America/Los_Angeles' });

/** 08:00 in Los Angeles on Saturday 2026-10-24. */
const NOW = new Date('2026-10-24T15:00:00Z');
const CLIENT_ID = '123456789012-abcdef0123456789abcdef0123456789.apps.googleusercontent.com';
const READ_EVENTS = 'https://www.googleapis.com/auth/calendar.events.readonly';
const NOTE = 'Calendar/2026-10-24 Payroll standup.md';

const standup = {
  id: 'ev-standup',
  status: 'confirmed',
  summary: 'Payroll standup',
  start: { dateTime: '2026-10-24T09:00:00-07:00' },
  end: { dateTime: '2026-10-24T09:30:00-07:00' },
  attendees: [
    { email: 'james@larkspur.example', self: true, responseStatus: 'accepted' },
    { email: 'mara@larkspur.example', displayName: 'Mara Quill', responseStatus: 'accepted' },
  ],
  eventType: 'default',
};

/** Tasks that follow GTD, so the vault has a Today page (#111). */
const GTD_TASK_TYPE = [
  '---',
  'name: task',
  'label: Task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [inbox, backlog, next-action, in-progress, waiting, someday, longterm, archive]',
  '    done: archive',
  '---',
  '',
].join('\n');

async function openVault(page: Page) {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.write('.atlas/types/task.md', GTD_TASK_TYPE);
  await vault.mkdir('People');
  await vault.write(
    'People/Mara Quill.md',
    '---\ntype: person\nemail: mara@larkspur.example\n---\n',
  );
  const host = await installHost(page, vault);
  await page.clock.setFixedTime(NOW);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();
  return { vault, host };
}

const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings' });
const card = (page: Page) => settings(page).getByRole('region', { name: 'Google Calendar' });
const meetingsPart = (page: Page) => card(page).getByRole('group', { name: 'Meetings' });
const todaysMeetings = (page: Page) =>
  page.getByRole('article', { name: 'Today' }).getByRole('region', { name: 'Meetings' });

async function openToday(page: Page) {
  await page.keyboard.press('Escape');
  await expect(settings(page)).toHaveCount(0);
  await page.getByRole('list', { name: 'Go to' }).getByRole('button', { name: 'Today' }).click();
}

test('today’s meetings arrive as event notes linked to People, show on Today, and a cancelled one is marked, not deleted', async ({
  page,
}) => {
  const { vault, host } = await openVault(page);
  host.google.serveEvents('primary', [standup]);

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await card(page).getByRole('textbox', { name: 'OAuth client ID' }).fill(CLIENT_ID);
  await card(page).getByRole('button', { name: 'Connect' }).click();
  await expect(meetingsPart(page)).toContainText('Today’s meetings are not read.');
  expect(host.google.scopes()).not.toContain(READ_EVENTS);

  await meetingsPart(page).getByRole('button', { name: 'Allow reading meetings' }).click();

  await expect.poll(() => host.google.scopes()).toContain(READ_EVENTS);
  await expect.poll(() => host.google.eventsAsked()).toBeGreaterThan(0);
  await expectFile(vault, '.atlas/settings.md').toContain('google_meetings: true');
  await expectFile(vault, NOTE).toContain('gcal_event_id: ev-standup');
  // The zone the notes were written on is kept for the brief, Today and meeting start (#587).
  await expectFile(vault, '.atlas/settings.md').toContain('google_plan_zone: America/Los_Angeles');
  const note = await vault.read(NOTE);
  expect(note).toContain('date: 2026-10-24T09:00');
  expect(note).toContain('[[Mara Quill]]');
  expect(note).not.toContain('james@larkspur.example');
  await expect(meetingsPart(page)).toContainText('last read at');

  await openToday(page);
  await expect(todaysMeetings(page).getByRole('listitem')).toHaveText([
    '09:00–09:30Payroll standupwith Mara Quill',
  ]);

  // Prep written under the meeting is the person's, and stays.
  await vault.write(NOTE, `${await vault.read(NOTE)}Bring the Q4 close numbers.\n`);
  host.google.change('primary', { id: 'ev-standup', status: 'cancelled' });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await meetingsPart(page).getByRole('button', { name: 'Read meetings now' }).click();

  await expectFile(vault, NOTE).toContain('gcal_missing: true');
  expect(await vault.read(NOTE)).toContain('Bring the Q4 close numbers.');
  await openToday(page);
  await expect(todaysMeetings(page)).toHaveCount(0);
});

test('a vault that has not allowed meetings reads none, and Today shows none', async ({ page }) => {
  const { vault, host } = await openVault(page);
  host.google.serveEvents('primary', [standup]);

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await card(page).getByRole('textbox', { name: 'OAuth client ID' }).fill(CLIENT_ID);
  await card(page).getByRole('button', { name: 'Connect' }).click();
  await expect(meetingsPart(page)).toContainText('Today’s meetings are not read.');

  await openToday(page);
  await expect(page.getByRole('article', { name: 'Today' })).toBeVisible();
  await expect(todaysMeetings(page)).toHaveCount(0);
  expect(host.google.eventsAsked()).toBe(0);
  expect(await vault.exists('Calendar')).toBe(false);
});

test('a Mac that does not run the vault’s automations never asks Google for meetings or writes them', async ({
  page,
}) => {
  const { vault, host } = await openVault(page);
  // The other Mac runs this vault's automations (U-29), so it alone writes meeting notes.
  await vault.write(
    '.atlas/settings.md',
    '---\nautomationsMac: laptop-0000\nautomationsMacName: Laptop\n---\n',
  );
  host.google.serveEvents('primary', [standup]);

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await card(page).getByRole('textbox', { name: 'OAuth client ID' }).fill(CLIENT_ID);
  await card(page).getByRole('button', { name: 'Connect' }).click();
  await meetingsPart(page).getByRole('button', { name: 'Allow reading meetings' }).click();

  await expectFile(vault, '.atlas/settings.md').toContain('google_meetings: true');
  await expect(meetingsPart(page)).toContainText('written on the Mac that runs its automations');
  await expect(meetingsPart(page).getByRole('button', { name: 'Read meetings now' })).toHaveCount(
    0,
  );
  expect(host.google.eventsAsked()).toBe(0);
  expect(await vault.exists('Calendar')).toBe(false);
});
