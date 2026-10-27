import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from './fixtures.ts';
import { createVault, expectFile, installHost } from './host.ts';

/**
 * #39: the morning brief. The ready-made rule, turned on from the
 * Automations page, writes a pre-read for each of today's meetings with a
 * linked person — from the event notes a meetings sync writes (ADR-0046) and
 * what `brief()` says of who is met — into `Inbox/Briefs/<day>/`, where it
 * waits in the Inbox. Claude is the e2e host's scripted model, on a fixed clock.
 */

test.use({ timezoneId: 'America/Los_Angeles' });

/** 07:30 in Los Angeles on Monday 2026-10-26. */
const NOW = new Date('2026-10-26T14:30:00Z');
const DAY = '2026-10-26';
const EVENT = `Calendar/${DAY} Larkspur sync.md`;
const BRIEF = `Inbox/Briefs/${DAY}/09.30 Larkspur sync.md`;

const type = (name: string, label: string) =>
  ['---', `name: ${name}`, `label: ${label}`, 'properties: {}', '---', ''].join('\n');

const event = (fields: readonly string[]) =>
  [
    '---',
    'type: event',
    'gcal_calendar: primary',
    'gcal_response: accepted',
    ...fields,
    '---',
    '',
    '',
  ].join('\n');

const ANSWER = JSON.stringify({
  note: {
    title: 'Larkspur sync prep',
    body: '## Who\n\n- Mara Quill, met before: [[People/Mara Quill.md]]\n- Something nobody said\n',
  },
});

/** A vault with today's meetings as event notes: one with Mara linked, one declined, one with nobody. */
async function meetingsVault() {
  const vault = await createVault();
  await vault.mkdir('.atlas/types');
  await vault.write('.atlas/types/person.md', type('person', 'Person'));
  await vault.write('.atlas/types/company.md', type('company', 'Company'));
  await vault.mkdir('People');
  await vault.write(
    'People/Mara Quill.md',
    '---\ntype: person\nemail: mara@larkspur.example\n---\n',
  );
  await vault.mkdir('Calendar');
  await vault.write(
    EVENT,
    event([
      'title: Larkspur sync',
      `date: ${DAY}T09:30`,
      `ends: ${DAY}T10:00`,
      'gcal_event_id: ev-sync',
      'people: ["[[People/Mara Quill]]"]',
    ]),
  );
  // Declined, and with nobody linked: neither is briefed.
  await vault.write(
    `Calendar/${DAY} Declined review.md`,
    event([
      'title: Declined review',
      `date: ${DAY}T13:00`,
      'gcal_event_id: ev-declined',
      'gcal_response: declined',
      'people: ["[[People/Mara Quill]]"]',
    ]),
  );
  await vault.write(
    `Calendar/${DAY} Focus time.md`,
    event(['title: Focus time', `date: ${DAY}T15:00`, 'gcal_event_id: ev-focus']),
  );
  return vault;
}

test('the "Morning brief" preset writes a cited brief per meeting into the Inbox, once a day (#39)', async ({
  page,
}) => {
  const vault = await meetingsVault();
  const host = await installHost(page, vault);
  host.claude.reply(ANSWER);
  await page.clock.setFixedTime(NOW);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();

  // Opt in: the preset is offered, and nothing runs until it is created.
  await page.getByRole('button', { name: 'Automations', exact: true }).click();
  const screen = page.getByRole('article', { name: 'Automations' });
  await page.getByRole('button', { name: 'Morning brief' }).click();
  const editor = screen.getByRole('region', { name: 'Automation' });
  await expect(editor.getByRole('textbox', { name: 'Folder' })).toHaveValue('Inbox/Briefs');
  await expect(editor.getByRole('combobox', { name: 'What DFAI hands Claude' })).toHaveValue(
    'meeting-briefs',
  );
  await editor.getByRole('button', { name: 'Create automation' }).click();
  const rule = '.atlas/automations/Morning brief.md';
  await expectFile(vault, rule).toContain('\nwhen: daily at 07:00\n');
  await expectFile(vault, rule).toContain('\ndata: meeting-briefs\n');
  await expectFile(vault, '.atlas/prompts/morning-brief.md').toContain('## What the brief holds');
  expect(await vault.exists(BRIEF)).toBe(false);
  const list = screen.getByRole('list', { name: 'All automations' });
  await expect(list.getByText(/Every day at 07:00/)).toBeVisible();
  await list.getByRole('button', { name: 'Morning brief', exact: true }).click();

  await editor.getByRole('button', { name: 'Run now' }).click();
  await expectFile(vault, BRIEF).toContain('atlas_period_item: gcal:ev-sync');
  const written = await vault.read(BRIEF);
  expect(written).toContain('- Mara Quill, met before: [[People/Mara Quill.md]]');
  expect(written).not.toContain('Something nobody said');
  // Asked once, about the one meeting with someone linked, handed it and Mara's page to cite.
  const turns = () => host.claude.runs().filter((run) => run.args[0] === '-p');
  expect(turns()).toHaveLength(1);
  const told = turns()[0]!.args.join('\n');
  expect(told).toContain(`[[${EVENT}]] Larkspur sync — today 09:30–10:00`);
  expect(told).toContain('[[People/Mara Quill.md]] Mara Quill');

  // Run again the same day: nothing new, and Claude is not asked.
  const log = '.atlas/automations/log/Morning brief.md';
  await expectFile(vault, log).toContain('gcal:ev-sync');
  await editor.getByRole('button', { name: 'Run now' }).click();
  await expect(
    screen.getByText(/Its note for 2026-10-26 07:00:00 is made already/).first(),
  ).toBeVisible();
  expect(turns()).toHaveLength(1);
  expect(await readdir(join(vault.root, `Inbox/Briefs/${DAY}`))).toEqual([
    '09.30 Larkspur sync.md',
  ]);

  // The brief waits in the Inbox.
  await page.getByRole('button', { name: /^Inbox/ }).click();
  const inbox = page.getByRole('article', { name: 'Inbox' });
  await expect(inbox.getByText('09.30 Larkspur sync', { exact: true })).toBeVisible();
});

// #587: the calendar keeps Kiritimati's clock, a day ahead of the Mac in Los Angeles.
test('the brief briefs the calendar’s day, on the zone the vault keeps, not the Mac’s (#587)', async ({
  page,
}) => {
  const vault = await meetingsVault();
  await vault.write('.atlas/settings.md', '---\ngoogle_plan_zone: Pacific/Kiritimati\n---\n');
  const host = await installHost(page, vault);
  host.claude.reply(ANSWER);
  // 10:30 on the 25th in Los Angeles; 07:30 on the 26th on Kiritimati.
  await page.clock.setFixedTime(new Date('2026-10-25T17:30:00Z'));
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText(/notes indexed/)).toBeVisible();

  await page.getByRole('button', { name: 'Automations', exact: true }).click();
  const screen = page.getByRole('article', { name: 'Automations' });
  await page.getByRole('button', { name: 'Morning brief' }).click();
  const editor = screen.getByRole('region', { name: 'Automation' });
  await editor.getByRole('button', { name: 'Create automation' }).click();
  await expectFile(vault, '.atlas/automations/Morning brief.md').toContain(
    '\ndata: meeting-briefs\n',
  );
  const list = screen.getByRole('list', { name: 'All automations' });
  await list.getByRole('button', { name: 'Morning brief', exact: true }).click();

  await editor.getByRole('button', { name: 'Run now' }).click();
  await expectFile(vault, BRIEF).toContain('atlas_period_item: gcal:ev-sync');
  expect(await vault.read(BRIEF)).toMatch(/atlas_period: '?2026-10-26T07:00:00/);
});
