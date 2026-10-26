/**
 * POST /v1/meetings (#93), through the real YAML reader: a meeting sent the
 * way n8n assembles it is mapped by the mapper n8n's Code nodes run, checked
 * against meeting/v1, and written once into its month's folder under
 * Meetings/ (#214), where the import (P28-04) settles it. All names are made up.
 */
import { describe, expect, it } from 'vitest';
import {
  apiFixture,
  bodyOf,
  catchUpMeetings,
  codeOf,
  recordingActivity,
  type IndexPort,
} from '@dfai/application';
import { atlasQueryIndex } from '@dfai/application/testing/sqlite';
import {
  mapMeeting,
  splitFrontmatter,
  validateMeetingImport,
  type MeetingImport,
} from '@dfai/domain';
import { remarkMarkdown } from './markdown-port.ts';

type ApiFixture = ReturnType<typeof apiFixture>;

const GEMINI_TRANSCRIPT = [
  '📖 Transcript',
  'Oct 6, 2026',
  '### 00:00:12',
  'Mara Quill: Morning. Shall we start with the timeline?',
  'Tobias Fenn: Yes. Go-live moves a week.',
  '### 00:09:44',
  'Mara Quill: Agreed, then.',
  '### Transcription ended after 00:11:49',
  'This editable transcript was computer generated and might contain errors. People can also change the text after it was created.',
].join('\n');

/** A meeting as n8n's assembled-meeting and notes-email nodes hand it over. */
const SENT = {
  provider: 'gemini',
  sourceId: '19a2b3c4d5e6f701',
  title: 'Larkspur Payroll onboarding sync',
  subject: 'Notes: “Larkspur Payroll onboarding sync” Oct 6, 2026',
  arrived: '2026-10-06T17:58:00Z',
  attendees: [
    { name: 'Mara Quill', email: 'mara.quill@example.com' },
    { name: 'Tobias Fenn', email: 'tobias.fenn@example.com' },
    { name: null, email: 'platform-team@example.com' },
  ],
  summaryMd: [
    '## Summary',
    '',
    'Mara and Tobias agreed the go-live moves a week.',
    '',
    '## Next steps',
    '',
    '- [Tobias Fenn] Send the plan: share the revised timeline.',
    '',
    '## Details',
    '',
    '- Timeline: go-live moves to the 20th.',
  ].join('\n'),
  transcriptMd: GEMINI_TRANSCRIPT,
  category: 'Sync',
};

const PATH = 'Meetings/2026/10/2026-10-06 Larkspur Payroll onboarding sync.md';
const COLLISION_PATH = mapMeeting({ ...fieldsOf(SENT) }, { timeZone: 'UTC' }).collisionPath;

/** The request's fields under the mapper's names, as n8n's "Meeting fields for DFAI" node gives them. */
function fieldsOf(sent: typeof SENT) {
  return {
    source: sent.provider,
    sourceId: sent.sourceId,
    title: sent.title,
    stated: sent.subject,
    arrived: sent.arrived,
    attendees: sent.attendees,
    sections: sent.summaryMd,
    transcript: sent.transcriptMd,
    category: sent.category,
  };
}

/** A meeting file another source wrote, by the same mapper, with its own id. */
const otherMeeting = (sourceId: string) =>
  mapMeeting({ ...fieldsOf(SENT), sourceId }, { timeZone: 'America/Los_Angeles' }).content;

const imported = (text: string) =>
  text.replace(
    'atlas_import: meeting/v1\n',
    'atlas_import: meeting/v1\natlas_import_outcome: imported\n',
  );

function vault(
  files: Record<string, string> = {},
  { query }: { query?: (base: IndexPort['query']) => IndexPort['query'] } = {},
) {
  // The index is read once, as the vault was: it lags what the route writes, as the real one does.
  const indexed = atlasQueryIndex({ files, markdown: remarkMarkdown });
  return apiFixture({
    files,
    markdown: remarkMarkdown,
    index: { query: query === undefined ? indexed : query(indexed) },
  });
}

const send = (api: ApiFixture, body: unknown) =>
  api.send({ method: 'POST', path: '/v1/meetings', body });

function accepted(text: string): MeetingImport {
  const result = validateMeetingImport({
    text,
    selfName: null,
    readFrontmatter: (frontmatter) => ({
      properties: remarkMarkdown.frontmatterProperties(frontmatter),
      problem: remarkMarkdown.frontmatterProblem(frontmatter),
    }),
  });
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.errors)}`);
  return result.meeting;
}

const frontmatterOf = (text: string) =>
  remarkMarkdown.frontmatterProperties(splitFrontmatter(text).frontmatter);

describe('POST /v1/meetings: a Gemini meeting from n8n', () => {
  it('writes it into its month’s folder under Meetings as a file meeting/v1 accepts, making the folders', async () => {
    const api = vault();
    const response = await send(api, SENT);

    expect(response.status).toBe(201);
    expect(bodyOf(response)).toEqual({ meeting: { path: PATH, outcome: 'written' } });
    const text = api.files.get(PATH)?.text ?? '';
    const meeting = accepted(text);
    expect(meeting).toMatchObject({
      provider: 'gemini',
      externalId: '19a2b3c4d5e6f701',
      title: 'Larkspur Payroll onboarding sync',
      date: '2026-10-06',
    });
    // Arrived 10:58 on this Mac's clock, less the 11:49 the transcript ran.
    expect(frontmatterOf(text)).toMatchObject({
      start: '10:46',
      start_approximate: true,
      kind: 'Sync',
      attendees: [
        { name: 'Mara Quill', email: 'mara.quill@example.com' },
        { name: 'Tobias Fenn', email: 'tobias.fenn@example.com' },
        { name: 'platform-team', email: 'platform-team@example.com', group: true },
      ],
    });
    expect(meeting.transcript.map((turn) => turn.writtenSpeaker)).toEqual([
      'Mara Quill',
      'Tobias Fenn',
      'Mara Quill',
    ]);
    expect(meeting.nextSteps).toHaveLength(1);
  });

  it('writes the file n8n’s mapper writes for the same meeting, byte for byte', async () => {
    const api = vault();
    await send(api, SENT);
    const mapped = mapMeeting(fieldsOf(SENT), { timeZone: 'America/Los_Angeles' });
    expect(api.files.get(PATH)?.text).toBe(mapped.content);
  });

  it('reads instants on this Mac’s clock, unless the request names a zone', async () => {
    const onEastern = vault();
    onEastern.timeZone = 'America/New_York';
    await send(onEastern, SENT);
    expect(frontmatterOf(onEastern.files.get(PATH)?.text ?? '')).toMatchObject({ start: '13:46' });

    const named = vault();
    await send(named, { ...SENT, timeZone: 'Europe/London' });
    expect(frontmatterOf(named.files.get(PATH)?.text ?? '')).toMatchObject({ start: '18:46' });
  });

  it('writes no stamp of its own; the import stamps it as it does any arrival', async () => {
    const api = vault();
    await send(api, SENT);
    expect(frontmatterOf(api.files.get(PATH)?.text ?? '')).not.toHaveProperty(
      'atlas_import_outcome',
    );

    const outcome = await catchUpMeetings({
      ports: {
        fs: api.fs,
        index: api.deps.index,
        markdown: remarkMarkdown,
        editors: api.deps.movingNotes,
      },
      today: '2026-10-10',
      activity: recordingActivity(),
    });
    expect(outcome.wrote).toBe(true);
    expect(frontmatterOf(api.files.get(PATH)?.text ?? '')).toMatchObject({
      atlas_import_outcome: 'imported',
    });
  });

  it('says the write in Activity by its route and note, not by what it carried', async () => {
    const api = vault();
    await send(api, SENT);
    expect(api.activity.reports).toEqual([
      expect.objectContaining({
        kind: 'api',
        level: 'info',
        message: 'POST v1/meetings — 2026-10-06 Larkspur Payroll onboarding sync',
      }),
    ]);
    expect(JSON.stringify(api.activity.reports)).not.toContain('go-live');
  });

  it('writes into the month’s folder as the vault spells it', async () => {
    const api = vault({ 'meetings/2026/10/Older.md': '# Older\n' });
    const response = await send(api, SENT);
    expect(bodyOf(response)).toEqual({
      meeting: { path: `meetings/2026/10/${PATH.split('/').at(-1)}`, outcome: 'written' },
    });
  });
});

describe('POST /v1/meetings: a meeting the vault already holds', () => {
  it('answers 200 in-vault with the note holding it, writes nothing, and logs nothing', async () => {
    const filed = 'Projects/Larkspur/Onboarding sync.md';
    const api = vault({ [filed]: imported(otherMeeting('19a2b3c4d5e6f701')) });
    const response = await send(api, SENT);

    expect(response.status).toBe(200);
    expect(bodyOf(response)).toEqual({ meeting: { path: filed, outcome: 'in-vault' } });
    expect(api.writes).toEqual([]);
    expect(api.folders.size).toBe(0);
    expect(api.activity.reports).toEqual([]);
  });

  it('is sent twice and written once, though the index has not read the first yet', async () => {
    const api = vault();
    expect((await send(api, SENT)).status).toBe(201);
    const again = await send(api, SENT);

    expect(again.status).toBe(200);
    expect(bodyOf(again)).toEqual({ meeting: { path: PATH, outcome: 'in-vault' } });
    expect(api.writes.map((write) => write.path)).toEqual([PATH]);
  });

  it('does not count a copy the import marked a duplicate', async () => {
    const copy = 'Archive/Inbox/Meetings/2026-10-06 Larkspur Payroll onboarding sync.md';
    const marked = otherMeeting('19a2b3c4d5e6f701').replace(
      'atlas_import: meeting/v1\n',
      'atlas_import: meeting/v1\natlas_import_outcome: duplicate\n',
    );
    const api = vault({ [copy]: marked });
    const response = await send(api, SENT);
    expect(bodyOf(response)).toEqual({ meeting: { path: PATH, outcome: 'written' } });
  });
});

describe('POST /v1/meetings: another meeting at its path', () => {
  it('writes at the collision path when another meeting holds the plain one', async () => {
    const api = vault({ [PATH]: otherMeeting('another-meeting-01') });
    const response = await send(api, SENT);

    expect(response.status).toBe(201);
    expect(bodyOf(response)).toEqual({ meeting: { path: COLLISION_PATH, outcome: 'written' } });
    expect(api.files.get(PATH)?.text).toBe(otherMeeting('another-meeting-01'));
    accepted(api.files.get(COLLISION_PATH)?.text ?? '');
  });

  it('finds itself at the collision path when sent again', async () => {
    const api = vault({ [PATH]: otherMeeting('another-meeting-01') });
    await send(api, SENT);
    const again = await send(api, SENT);
    expect(bodyOf(again)).toEqual({ meeting: { path: COLLISION_PATH, outcome: 'in-vault' } });
    expect(api.writes).toHaveLength(1);
  });

  it('is refused with exists when other meetings hold both paths, and writes nothing', async () => {
    const api = vault({
      [PATH]: otherMeeting('another-meeting-01'),
      [COLLISION_PATH]: otherMeeting('another-meeting-02'),
    });
    const response = await send(api, SENT);

    expect(codeOf(response)).toBe('exists');
    expect(api.writes).toEqual([]);
  });
});

describe('POST /v1/meetings: refused', () => {
  it('refuses a meeting with no trustworthy start, with the reason (issue #80)', async () => {
    const api = vault();
    const response = await send(api, { ...SENT, transcriptMd: undefined });

    expect(codeOf(response)).toBe('invalid');
    expect(JSON.stringify(response.body)).toContain('start: the meeting has no start time');
    expect(api.writes).toEqual([]);
    expect(api.folders.size).toBe(0);
    expect(api.activity.reports).toEqual([
      expect.objectContaining({ level: 'warning', message: 'POST v1/meetings refused (invalid).' }),
    ]);
  });

  it.each([
    ['a body that is not an object', ['a', 'list'], 'the body must be a JSON object'],
    ['no provider', { ...SENT, provider: undefined }, 'provider must be a string'],
    ['an empty sourceId', { ...SENT, sourceId: '  ' }, 'sourceId must not be empty'],
    ['no title', { ...SENT, title: undefined }, 'title must be a string'],
    ['a subject that is not text', { ...SENT, subject: 6 }, 'subject must be a string'],
    ['attendees that are not a list', { ...SENT, attendees: 'Mara' }, 'attendees must be an array'],
    ['an attendee that is not an object', { ...SENT, attendees: ['Mara'] }, 'attendees[0] must be'],
    [
      'an attendee’s email that is not text',
      { ...SENT, attendees: [{ name: 'Mara Quill', email: 7 }] },
      'attendees[0].email must be a string',
    ],
    ['a zone that is not one', { ...SENT, timeZone: 'Mars/Olympus' }, 'is not a time zone'],
    ['a provider name with spaces', { ...SENT, provider: 'note taker' }, 'is not a provider name'],
    ['a subject with no date', { ...SENT, subject: 'Notes for you' }, 'stated'],
  ])('refuses %s as invalid', async (_, body, message) => {
    const api = vault();
    const response = await send(api, body);
    expect(codeOf(response)).toBe('invalid');
    expect(JSON.stringify(response.body)).toContain(message);
    expect(api.writes).toEqual([]);
  });
});

describe('POST /v1/meetings: the fields n8n sends', () => {
  it('takes null as left out, for every optional field', async () => {
    const api = vault();
    const optional = ['attendees', 'category', 'timeZone', 'groupAddresses'] as const;
    const response = await send(api, {
      ...SENT,
      ...Object.fromEntries(optional.map((field) => [field, null])),
    });
    expect(response.status).toBe(201);
    expect(frontmatterOf(api.files.get(PATH)?.text ?? '')).not.toHaveProperty('kind');
  });

  it('still requires provider, sourceId and title when they are null', async () => {
    for (const field of ['provider', 'sourceId', 'title']) {
      const response = await send(vault(), { ...SENT, [field]: null });
      expect(codeOf(response)).toBe('invalid');
      expect(JSON.stringify(response.body)).toContain(`${field} must be a string`);
    }
  });

  it('refuses a key it does not read, naming it, rather than write the meeting without it', async () => {
    const api = vault();
    const response = await send(api, { ...SENT, transcriptMD: GEMINI_TRANSCRIPT });
    expect(codeOf(response)).toBe('invalid');
    expect(JSON.stringify(response.body)).toContain('\\"transcriptMD\\" is not a field');
    expect(api.writes).toEqual([]);
  });

  it('marks as groups the addresses groupAddresses names, as n8n’s OPTIONS does', async () => {
    const api = vault();
    await send(api, { ...SENT, groupAddresses: ['tobias.fenn@example.com'] });
    expect(frontmatterOf(api.files.get(PATH)?.text ?? '')).toMatchObject({
      attendees: [
        { name: 'Mara Quill' },
        { name: 'Tobias Fenn', email: 'tobias.fenn@example.com', group: true },
        { email: 'platform-team@example.com', group: true },
      ],
    });
  });

  it.each([
    [
      'groupAddresses that are not a list',
      { groupAddresses: 'leads@example.com' },
      'groupAddresses must be an array',
    ],
    [
      'a group address that is not text',
      { groupAddresses: [5] },
      'groupAddresses[0] must be a string',
    ],
    [
      'an attendee’s group that is not true or false',
      { attendees: [{ name: 'Mara Quill', group: 'yes' }] },
      'attendees[0].group must be true or false',
    ],
  ])('refuses %s as invalid', async (_, fields, message) => {
    const response = await send(vault(), { ...SENT, ...fields });
    expect(codeOf(response)).toBe('invalid');
    expect(JSON.stringify(response.body)).toContain(message);
  });
});

describe('POST /v1/meetings: the vault is switched mid-request', () => {
  const OTHER = { absolutePath: '/Users/j/Other', name: 'Other' };

  it('writes into neither vault when the switch comes before the write', async () => {
    let api: ApiFixture | null = null;
    api = vault(
      {},
      {
        query: (base) => async (sql, parameters) => {
          if (api !== null) api.open = OTHER;
          return base(sql, parameters);
        },
      },
    );
    const response = await send(api, SENT);

    expect(codeOf(response)).toBe('no_vault');
    expect(api.writes).toEqual([]);
  });

  it('never says a meeting is held once the vault it found it in is closed', async () => {
    const filed = 'Projects/Larkspur/Onboarding sync.md';
    let api: ApiFixture | null = null;
    api = vault(
      { [filed]: imported(otherMeeting('19a2b3c4d5e6f701')) },
      {
        query: (base) => async (sql, parameters) => {
          const found = await base(sql, parameters);
          if (api !== null) api.open = OTHER;
          return found;
        },
      },
    );
    const response = await send(api, SENT);
    expect(codeOf(response)).toBe('no_vault');
  });
});

describe('POST /v1/meetings: a day but no time, placed by the calendar (#582)', () => {
  /** The payload from the report: Gemini states the day, no time, and no transcript is sent. */
  const DAY_ONLY = {
    ...SENT,
    sourceId: '19a2b3c4d5e6f799',
    subject: 'Notes: “Larkspur Payroll onboarding sync” Oct 24, 2026',
    arrived: '2026-10-24T17:40:00Z',
    transcriptMd: undefined,
    timeZone: 'America/Los_Angeles',
  };
  const DAY_ONLY_PATH = 'Meetings/2026/10/2026-10-24 Larkspur Payroll onboarding sync.md';

  /** An event note a meetings sync wrote (ADR-0046), ended ten minutes before the notes arrived. */
  const EVENT_NOTE = [
    '---',
    'type: event',
    "title: 'Larkspur Payroll onboarding sync'",
    "date: '2026-10-24T10:00'",
    "ends: '2026-10-24T10:30'",
    "gcal_event_id: 'ev-larkspur-sync'",
    "gcal_calendar: 'primary'",
    "gcal_response: 'accepted'",
    '---',
    '',
    'Prep notes.',
    '',
  ].join('\n');

  it('takes the start and end of the meeting’s event, not approximate, and says where from', async () => {
    const api = vault({ 'Calendar/2026-10-24 Larkspur Payroll onboarding sync.md': EVENT_NOTE });
    const response = await send(api, DAY_ONLY);

    expect(response.status).toBe(201);
    expect(bodyOf(response)).toEqual({ meeting: { path: DAY_ONLY_PATH, outcome: 'written' } });
    const text = api.files.get(DAY_ONLY_PATH)?.text ?? '';
    expect(accepted(text)).toMatchObject({ date: '2026-10-24', start: '10:00', end: '10:30' });
    expect(frontmatterOf(text)).toMatchObject({ start_source: 'calendar' });
    expect(frontmatterOf(text)).not.toHaveProperty('start_approximate');
  });

  it('refuses with what to send when DFAI has no calendar events that day', async () => {
    const api = vault();
    const response = await send(api, DAY_ONLY);

    expect(response.status).toBe(400);
    expect(codeOf(response)).toBe('invalid');
    expect(JSON.stringify(response.body)).toContain(
      'and DFAI has no calendar events on 2026-10-24; send `start`, a time in the subject, or a transcript with its times, or connect Google Calendar so DFAI can take the start from the meeting’s event',
    );
    expect(api.writes).toEqual([]);
  });

  it('takes a `start` and `end` the sender gives, as the message says it may', async () => {
    const api = vault();
    const response = await send(api, { ...DAY_ONLY, start: '10:05', end: '10:35' });

    expect(response.status).toBe(201);
    const text = api.files.get(DAY_ONLY_PATH)?.text ?? '';
    expect(accepted(text)).toMatchObject({ start: '10:05', end: '10:35' });
    expect(frontmatterOf(text)).not.toHaveProperty('start_source');
  });
});
