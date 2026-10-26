/**
 * Attack on #582 / PR #583, through POST /v1/meetings with the real YAML
 * reader and a real SQLite index: event notes as a meetings sync writes
 * them (ADR-0046), and meetings sent with no start of their own. All names
 * are made up.
 */
import { describe, expect, it } from 'vitest';
import { apiFixture, codeOf, type IndexPort } from '@dfai/application';
import { atlasQueryIndex } from '@dfai/application/testing/sqlite';
import { splitFrontmatter } from '@dfai/domain';
import { remarkMarkdown } from './markdown-port.ts';

const SENT = {
  provider: 'gemini',
  sourceId: '19a2b3c4d5e6f583',
  title: 'Heron Payroll weekly',
  subject: 'Notes: “Heron Payroll weekly” Oct 24, 2026',
  arrived: '2026-10-24T17:40:00Z',
  attendees: [{ name: 'Ilsa Fenn', email: 'ilsa.fenn@example.com' }],
  summaryMd: '## Summary\n\nThe cutover holds.',
  timeZone: 'America/Los_Angeles',
};

const TIMED_TRANSCRIPT = [
  '### 00:00:12',
  'Ilsa Fenn: Morning.',
  '### Transcription ended after 00:11:49',
].join('\n');

function eventNote(
  { start, end, id, extra = [] }: { start: string; end: string; id: string; extra?: string[] },
  title = 'Heron Payroll weekly',
): string {
  return [
    '---',
    'type: event',
    `title: '${title}'`,
    `date: '${start}'`,
    `ends: '${end}'`,
    `gcal_event_id: '${id}'`,
    "gcal_calendar: 'primary'",
    ...extra,
    '---',
    '',
    'Prep notes.',
    '',
  ].join('\n');
}

function vault(
  files: Record<string, string> = {},
  query?: (base: IndexPort['query']) => IndexPort['query'],
) {
  const indexed = atlasQueryIndex({ files, markdown: remarkMarkdown });
  return apiFixture({
    files,
    markdown: remarkMarkdown,
    index: { query: query === undefined ? indexed : query(indexed) },
  });
}

const send = (api: ReturnType<typeof vault>, body: unknown) =>
  api.send({ method: 'POST', path: '/v1/meetings', body });

function writtenFrontmatter(api: ReturnType<typeof vault>) {
  const meeting = [...api.files.entries()].find(([path]) => path.startsWith('Meetings/'));
  if (meeting === undefined) return null;
  return remarkMarkdown.frontmatterProperties(splitFrontmatter(meeting[1].text).frontmatter);
}

const messageOf = (response: { body: unknown }) => JSON.stringify(response.body);

describe('POST /v1/meetings: calendar start, attack (#583)', () => {
  it('reads two event notes for one gcal_event_id as one event, not two matches', async () => {
    const twin = eventNote({ start: '2026-10-24T10:00', end: '2026-10-24T10:30', id: 'ev-heron' });
    const api = vault({
      'Calendar/2026-10-24 Heron Payroll weekly.md': twin,
      'Calendar/2026-10-24 Heron Payroll weekly 2.md': twin,
    });
    const response = await send(api, SENT);
    expect(response.status).toBe(201);
    expect(writtenFrontmatter(api)).toMatchObject({ start: '10:00', start_source: 'calendar' });
  });

  // 23:00–00:15 crosses midnight: dayMeetings reports its end as null ("ends
  // another day"), and meetingCalendarStart would put any end on the start's
  // day anyway, so an event that ended 15 minutes before the notes is never taken.
  it('takes an event that spans midnight and ended before the notes arrived', async () => {
    const api = vault({
      'Calendar/2026-10-24 Heron Payroll weekly.md': eventNote({
        start: '2026-10-24T23:00',
        end: '2026-10-25T00:15',
        id: 'ev-late',
      }),
    });
    // 00:30 PDT on the 25th; the subject states the 24th.
    const response = await send(api, { ...SENT, arrived: '2026-10-25T07:30:00Z' });
    expect(response.status).toBe(201);
    expect(writtenFrontmatter(api)).toMatchObject({ start: '23:00', start_source: 'calendar' });
  });

  // With no stated day the day asked is the arrival's, so a 22:30–23:30
  // meeting whose notes came at 00:10 is looked for on the wrong day, and the
  // sender is told to connect a calendar that is connected.
  it('takes a late-evening event for notes that arrived just after midnight with no stated day', async () => {
    const api = vault({
      'Calendar/2026-10-24 Heron Payroll weekly.md': eventNote({
        start: '2026-10-24T22:30',
        end: '2026-10-24T23:30',
        id: 'ev-evening',
      }),
    });
    const response = await send(api, {
      ...SENT,
      subject: undefined,
      arrived: '2026-10-25T07:10:00Z',
    });
    expect(messageOf(response)).not.toContain('connect Google Calendar');
    expect(response.status).toBe(201);
    expect(writtenFrontmatter(api)).toMatchObject({ date: '2026-10-24', start: '22:30' });
  });

  it('never takes a declined event, and does not tell the sender to connect a calendar that has events that day', async () => {
    const api = vault({
      'Calendar/2026-10-24 Heron Payroll weekly.md': eventNote({
        start: '2026-10-24T10:00',
        end: '2026-10-24T10:30',
        id: 'ev-declined',
        extra: ["gcal_response: 'declined'"],
      }),
    });
    const response = await send(api, SENT);
    expect(response.status).toBe(400);
    expect(codeOf(response)).toBe('invalid');
    expect(api.writes).toEqual([]);
    expect(messageOf(response)).not.toContain('connect Google Calendar');
  });

  it('never takes a cancelled (gcal_missing) event', async () => {
    const api = vault({
      'Calendar/2026-10-24 Heron Payroll weekly.md': eventNote({
        start: '2026-10-24T10:00',
        end: '2026-10-24T10:30',
        id: 'ev-gone',
        extra: ['gcal_missing: true'],
      }),
    });
    const response = await send(api, SENT);
    expect(response.status).toBe(400);
    expect(codeOf(response)).toBe('invalid');
    expect(api.writes).toEqual([]);
  });

  it('never takes an all-day event', async () => {
    const api = vault({
      'Calendar/2026-10-24 Heron Payroll weekly.md': eventNote({
        start: '2026-10-24',
        end: '2026-10-25',
        id: 'ev-allday',
      }),
    });
    const response = await send(api, SENT);
    expect(response.status).toBe(400);
    expect(api.writes).toEqual([]);
  });

  it('lets a sent ISO-instant start win over a matching event, read on the sender’s zone', async () => {
    const api = vault({
      'Calendar/2026-10-24 Heron Payroll weekly.md': eventNote({
        start: '2026-10-24T10:00',
        end: '2026-10-24T10:30',
        id: 'ev-heron',
      }),
    });
    const response = await send(api, { ...SENT, start: '2026-10-24T16:00:00Z' });
    expect(response.status).toBe(201);
    const front = writtenFrontmatter(api);
    expect(front).toMatchObject({ start: '09:00' });
    expect(front).not.toHaveProperty('start_source');
  });

  it.each([['25:00'], ['9:5'], [900], [['10:00']], ['x'.repeat(100_000)]])(
    'refuses a hostile start %j as invalid, writing nothing',
    async (start) => {
      const api = vault();
      const response = await send(api, { ...SENT, start });
      expect(response.status).toBe(400);
      expect(codeOf(response)).toBe('invalid');
      expect(messageOf(response).length).toBeLessThan(500);
      expect(api.writes).toEqual([]);
    },
  );

  // POST /v1/meetings newly takes `end`; nothing checks it against the start.
  it('refuses an end before the start the sender gave', async () => {
    const api = vault();
    const response = await send(api, { ...SENT, start: '11:00', end: '10:00' });
    expect(response.status).toBe(400);
    expect(codeOf(response)).toBe('invalid');
    expect(api.writes).toEqual([]);
  });

  it('never echoes another meeting’s title in the refusal', async () => {
    const api = vault({
      'Calendar/2026-10-24 Wren Board private.md': eventNote(
        { start: '2026-10-24T10:00', end: '2026-10-24T10:30', id: 'ev-wren' },
        'Wren Board private',
      ),
    });
    const response = await send(api, SENT);
    expect(response.status).toBe(400);
    expect(messageOf(response)).not.toContain('Wren');
  });

  it('surfaces an index failure as an error, never as "connect Google Calendar"', async () => {
    const api = vault({}, () => () => Promise.reject(new Error('index is rebuilding')));
    const response = await send(api, SENT);
    expect(response.status).toBe(500);
    expect(messageOf(response)).not.toContain('connect Google Calendar');
    expect(api.writes).toEqual([]);
  });

  // Before #583 this meeting mapped (arrival less transcript length,
  // approximate) without touching the index; now a failing index lookup for a
  // calendar start it never needed makes it a 500.
  it('still writes a meeting with a transcript length when the calendar lookup fails', async () => {
    const api = vault({}, () => () => Promise.reject(new Error('index is rebuilding')));
    const response = await send(api, { ...SENT, transcriptMd: TIMED_TRANSCRIPT });
    expect(response.status).toBe(201);
    expect(writtenFrontmatter(api)).toMatchObject({ start_approximate: true });
  });
});
