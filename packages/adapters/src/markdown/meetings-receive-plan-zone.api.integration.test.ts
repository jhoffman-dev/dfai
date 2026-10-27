/**
 * #587 through POST /v1/meetings, with the real YAML reader and a real
 * SQLite index: a meeting sent with no start takes its calendar event's,
 * measured on the plan zone the vault keeps — the clock its event notes are
 * written on — not the Mac's. The review's case: the Mac in Los Angeles
 * (the API fixture's zone), the calendar in Chicago, two events of the
 * meeting's title that day. All names are made up.
 */
import { describe, expect, it } from 'vitest';
import { apiFixture } from '@dfai/application';
import { atlasQueryIndex } from '@dfai/application/testing/sqlite';
import { splitFrontmatter } from '@dfai/domain';
import { remarkMarkdown } from './markdown-port.ts';

const TITLE = 'Wrenfield Payroll sync';
const SENT = {
  provider: 'gemini',
  sourceId: '19f5a7c3e1b2d587',
  title: TITLE,
  subject: `Notes: “${TITLE}” Oct 24, 2026`,
  // 10:05 in Chicago; 08:05 in Los Angeles.
  arrived: '2026-10-24T15:05:00Z',
  attendees: [{ name: 'Odile Varga', email: 'odile.varga@example.com' }],
  summaryMd: '## Summary\n\nThe import is on track.',
  timeZone: 'America/Los_Angeles',
};

const eventNote = (start: string, end: string, id: string) =>
  [
    '---',
    'type: event',
    `title: '${TITLE}'`,
    `date: '${start}'`,
    `ends: '${end}'`,
    `gcal_event_id: '${id}'`,
    "gcal_calendar: 'primary'",
    '---',
    '',
  ].join('\n');

// On Chicago's clock the notes came 5 minutes after the 09:30 one ended, and
// 3 hours 35 minutes after the 06:00 one: only the 09:30 one fits. Read on Los
// Angeles's clock (08:05), the 06:00 one fits and the 09:30 one has not begun.
const EVENTS = {
  'Calendar/2026-10-24 Wrenfield Payroll sync.md': eventNote(
    '2026-10-24T06:00',
    '2026-10-24T06:30',
    'ev-early',
  ),
  'Calendar/2026-10-24 Wrenfield Payroll sync 2.md': eventNote(
    '2026-10-24T09:30',
    '2026-10-24T10:00',
    'ev-late',
  ),
};

const SETTINGS = '.atlas/settings.md';

function vault(files: Record<string, string>) {
  const index = atlasQueryIndex({ files, markdown: remarkMarkdown });
  return apiFixture({ files, markdown: remarkMarkdown, index: { query: index } });
}

function writtenFrontmatter(api: ReturnType<typeof vault>) {
  const meeting = [...api.files.entries()].find(([path]) => path.startsWith('Meetings/'));
  if (meeting === undefined) return null;
  return remarkMarkdown.frontmatterProperties(splitFrontmatter(meeting[1].text).frontmatter);
}

const send = (api: ReturnType<typeof vault>) =>
  api.send({ method: 'POST', path: '/v1/meetings', body: SENT });

describe('POST /v1/meetings: the calendar start on the kept plan zone (#587)', () => {
  it('takes the event that fits on the calendar’s clock, with the Mac in another zone', async () => {
    const api = vault({ ...EVENTS, [SETTINGS]: '---\ngoogle_plan_zone: America/Chicago\n---\n' });
    const response = await send(api);
    expect(response.status).toBe(201);
    expect(writtenFrontmatter(api)).toMatchObject({ start: '09:30', start_source: 'calendar' });
  });

  it('measures on the Mac’s zone while the vault keeps none, as before', async () => {
    const api = vault(EVENTS);
    const response = await send(api);
    expect(response.status).toBe(201);
    expect(writtenFrontmatter(api)).toMatchObject({ start: '06:00', start_source: 'calendar' });
  });

  it('measures on the Mac’s zone when the settings cannot be read, and still takes the meeting', async () => {
    const api = vault({ ...EVENTS, [SETTINGS]: '---\ngoogle_plan_zone: [unclosed\n---\n' });
    const response = await send(api);
    expect(response.status).toBe(201);
    expect(writtenFrontmatter(api)).toMatchObject({ start: '06:00' });
  });
});
