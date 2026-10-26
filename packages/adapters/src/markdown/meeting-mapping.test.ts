import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  fitFileNameStem,
  mapMeeting,
  MeetingMappingError,
  noteFileName,
  splitFrontmatter,
  validateMeetingImport,
  type MappingOptions,
  type MeetingFields,
  type MeetingImport,
} from '@dfai/domain';
import { remarkMarkdown } from './markdown-port.ts';

/*
 * The mapper's output is held to the contract by both of its checks: the
 * validator DFAI runs (with the YAML reader it reads every note with) and the
 * JSON Schema n8n could check the frontmatter against. All names here are
 * made up.
 */

const schemaFile = new URL(
  '../../../../vault/docs/contracts/meeting-import-v1.schema.json',
  import.meta.url,
);
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const schemaAccepts = ajv.compile(JSON.parse(readFileSync(schemaFile, 'utf8')) as object);

/** The meeting as DFAI reads it; fails the test with every problem when the file breaks the contract. */
function accepted(content: string): MeetingImport {
  const result = validateMeetingImport({
    text: content,
    selfName: 'James Hoffman',
    readFrontmatter: (frontmatter) => ({
      properties: remarkMarkdown.frontmatterProperties(frontmatter),
      problem: remarkMarkdown.frontmatterProblem(frontmatter),
    }),
  });
  if (!result.ok)
    throw new Error(`refused:\n${JSON.stringify(result.errors, null, 2)}\n${content}`);
  const frontmatter = remarkMarkdown.frontmatterProperties(splitFrontmatter(content).frontmatter);
  expect(schemaAccepts(frontmatter), ajv.errorsText(schemaAccepts.errors)).toBe(true);
  return result.meeting;
}

const mapped = (fields: MeetingFields, options?: MappingOptions) => {
  const file = mapMeeting(fields, options);
  return { file, meeting: accepted(file.content) };
};

const GEMINI_TRANSCRIPT = [
  '📖 Transcript',
  'Oct 6, 2026',
  '### 00:00:12',
  'Mara Quill: Morning. Shall we start with the cache?',
  'Tobias Fenn: Yes. It is ready,',
  'but I would like a flag on it first.',
  '### 00:09:44',
  'Mara Quill: Fine by me.',
  '### Transcription ended after 00:11:49',
  'This editable transcript was computer generated and might contain errors. People can also change the text after it was created.',
].join('\n');

const GEMINI: MeetingFields = {
  title: 'Platform weekly sync',
  date: '2026-10-06',
  start: '10:00',
  end: '10:30',
  attendees: [
    '- Mara Quill — [mara.quill@example.com](mailto:mara.quill@example.com)',
    '- Tobias Fenn — tobias.fenn@example.com',
    '- Platform Team — platform-team@example.com',
  ].join('\n'),
  summary: 'Mara and Tobias agreed to ship the cache behind a flag.',
  decisions: 'Ship behind a flag.',
  nextSteps: [
    '- \\[Tobias Fenn\\] Flag the cache: put it behind a flag before Friday.',
    '- \\[The group\\] Review the rollout: look at it together next week.',
  ].join('\n'),
  details: '- Cache rollout: the cache is ready.',
  transcript: GEMINI_TRANSCRIPT,
  category: 'Standup',
  source: 'gemini',
  sourceId: 'fake-meeting-0001',
};

const GRANOLA: MeetingFields = {
  title: 'Vendor contract call',
  date: '2026-10-01',
  attendees: [{ name: 'Lena Hart', email: 'lena.hart@example.org' }],
  summary: 'The renewal terms are agreed in principle.',
  nextSteps: [
    {
      owner: 'Lena Hart',
      title: 'Send the contract',
      description: 'the renewal',
      confidence: 'High',
    },
    { owner: 'You', title: 'Review the contract', confidence: 'medium' },
  ],
  transcript: [
    '**\\[14:14:22\\] You:** Thanks for making the time, Lena.',
    '**[14:14:40] Remote Speaker:** Of course.',
    'Chat with meeting transcript: https://notes.example.com/t/abc',
  ].join('\n'),
  category: '1:1',
  source: 'Granola',
  sourceId: 'not_0b52e8d4',
};

describe('a Gemini meeting', () => {
  it('becomes a contract file at Meetings/<YYYY>/<MM>/<date> <title>.md', () => {
    const { file, meeting } = mapped(GEMINI);
    expect(file.path).toBe('Meetings/2026/10/2026-10-06 Platform weekly sync.md');
    expect(file.commitMessage).toBe('Meeting: Platform weekly sync (gemini)');
    expect(meeting).toMatchObject({
      title: 'Platform weekly sync',
      date: '2026-10-06',
      start: '10:00',
      end: '10:30',
      kind: 'Standup',
      provider: 'gemini',
      externalId: 'fake-meeting-0001',
      transcriptClock: 'elapsed',
    });
  });

  it('splits Name — email attendees, and keeps a group address as a group', () => {
    const { meeting } = mapped(GEMINI);
    expect(meeting.attendees).toEqual([
      { name: 'Mara Quill', email: 'mara.quill@example.com', group: false },
      { name: 'Tobias Fenn', email: 'tobias.fenn@example.com', group: false },
      { name: 'Platform Team', email: 'platform-team@example.com', group: true },
    ]);
  });

  it('turns each line into a turn at its section’s time, a line without a speaker joining the turn before', () => {
    const { meeting } = mapped(GEMINI);
    expect(
      meeting.transcript.map((turn) => [turn.writtenSpeaker, turn.time, turn.words, turn.blockId]),
    ).toEqual([
      [
        'Mara Quill',
        { kind: 'section', text: '00:00:12', seconds: 12 },
        'Morning. Shall we start with the cache?',
        't0001',
      ],
      [
        'Tobias Fenn',
        { kind: 'section', text: '00:00:12', seconds: 12 },
        'Yes. It is ready, but I would like a flag on it first.',
        't0002',
      ],
      ['Mara Quill', { kind: 'section', text: '00:09:44', seconds: 584 }, 'Fine by me.', 't0003'],
    ]);
  });

  it('drops the date line, the end mark and the disclaimer', () => {
    const { file } = mapped(GEMINI);
    expect(file.content).not.toMatch(/Oct 6, 2026|Transcription ended|computer generated|📖/);
  });

  it('keeps next steps with their owners, Notion’s escapes undone', () => {
    const { meeting } = mapped(GEMINI);
    expect(meeting.nextSteps.map((step) => [step.owner, step.text])).toEqual([
      ['Tobias Fenn', 'Flag the cache: put it behind a flag before Friday.'],
      ['The group', 'Review the rollout: look at it together next week.'],
    ]);
  });

  it('puts Details in Notes, with Decisions under them', () => {
    const { file } = mapped(GEMINI);
    expect(file.content).toContain(
      '## Notes\n\n- Cache rollout: the cache is ready.\n\n### Decisions\n\nShip behind a flag.\n\n## Provider next steps',
    );
  });
});

describe('a Granola meeting', () => {
  it('stamps each turn with its own time of day, You and Unknown as speakers', () => {
    const { meeting } = mapped(GRANOLA);
    expect(meeting.transcriptClock).toBe('wall');
    expect(meeting.provider).toBe('granola');
    expect(meeting.kind).toBe('1:1');
    expect(meeting.transcript.map((turn) => [turn.writtenSpeaker, turn.time])).toEqual([
      ['You', { kind: 'turn', text: '14:14:22', seconds: 51262 }],
      ['Unknown', { kind: 'turn', text: '14:14:40', seconds: 51280 }],
    ]);
  });

  it('starts when the first word was spoken when no start is given', () => {
    expect(mapped(GRANOLA).meeting.start).toBe('14:14');
  });

  it('keeps an owner and a confidence from step records', () => {
    const { meeting } = mapped(GRANOLA);
    expect(meeting.nextSteps.map((step) => [step.owner, step.text, step.confidence])).toEqual([
      ['Lena Hart', 'Send the contract: the renewal', 'high'],
      ['You', 'Review the contract', 'medium'],
    ]);
  });

  it('drops the "Chat with meeting transcript" link', () => {
    expect(mapped(GRANOLA).file.content).not.toMatch(/Chat with meeting transcript/);
  });

  it('reads an item with an indented description as one step', () => {
    const { meeting } = mapped({
      ...GRANOLA,
      nextSteps: '- **Add a field**\n\tSo audits show who sent it.',
    });
    expect(meeting.nextSteps.map((step) => step.text)).toEqual([
      '**Add a field** So audits show who sent it.',
    ]);
  });
});

describe('frontmatter every YAML reader takes as text', () => {
  it.each([
    'Retro: Q3',
    '#1 priority',
    '[WIP] plan',
    '*starred* sync',
    '&anchor review',
    'James\'s "big" idea',
    '- dash first',
    'yes',
    '2026-10-06',
    '1:1',
  ])('a title of %s', (title) => {
    const { meeting } = mapped({ ...GEMINI, title });
    expect(meeting.title).toBe(title);
  });

  it.each(['1:1', '1on1', 'yes', 'null', '#team', "O'Brien's"])('a kind of %s', (kind) => {
    expect(mapped({ ...GEMINI, category: kind }).meeting.kind).toBe(kind);
  });

  it('quotes an id of digits, which would otherwise be a number', () => {
    const { file, meeting } = mapped({ ...GEMINI, sourceId: 12345 });
    expect(file.content).toContain("external_id: '12345'");
    expect(meeting.externalId).toBe('12345');
  });

  it('quotes attendee names and addresses with YAML characters in them', () => {
    const attendees = [{ name: "Dana O'Neil: #1", email: "dana'o@example.com" }];
    expect(mapped({ ...GEMINI, attendees }).meeting.attendees).toEqual([
      { ...attendees[0], group: false },
    ]);
  });
});

describe('the time of the meeting', () => {
  it('takes the start from a date-time with no offset, as written, in any zone', () => {
    for (const timeZone of [null, 'America/Los_Angeles']) {
      const { meeting } = mapped(
        { ...GEMINI, date: '2026-10-06T11:59:00', start: '' },
        { timeZone },
      );
      expect([meeting.date, meeting.start]).toEqual(['2026-10-06', '11:59']);
    }
  });

  it('refuses an instant (Z or an offset) when it has no time zone to read it in', () => {
    for (const date of ['2026-10-07T00:02:00.000Z', '2026-10-06T17:02:00-07:00']) {
      expect(() => mapMeeting({ ...GEMINI, date, start: '' }, { timeZone: null })).toThrow(
        /date: .*no time zone/,
      );
    }
    expect(() => mapMeeting({ ...GEMINI, date: new Date(0) })).toThrow(/no time zone/);
  });

  it('reads 17:02 PDT, stored as 00:02Z the next day, on the day it happened', () => {
    const { meeting } = mapped(
      { ...GEMINI, date: '2026-10-07T00:02:00.000Z', start: null },
      { timeZone: 'America/Los_Angeles' },
    );
    expect([meeting.date, meeting.start]).toEqual(['2026-10-06', '17:02']);
  });

  it('refuses an offset no clock has, and a date that is not text', () => {
    const zone = { timeZone: 'America/Los_Angeles' };
    expect(() => mapMeeting({ ...GEMINI, date: '2026-10-06T10:00+99:99' }, zone)).toThrow(
      /date: cannot read .* as an instant/,
    );
    expect(() => mapMeeting({ ...GEMINI, date: 20261006 })).toThrow(/date: expected text/);
  });

  it('reads an offset written without a colon', () => {
    const { meeting } = mapped(
      { ...GEMINI, date: '2026-10-06T17:02:00-0700', start: null },
      { timeZone: 'America/Los_Angeles' },
    );
    expect([meeting.date, meeting.start]).toEqual(['2026-10-06', '17:02']);
  });

  it('refuses a day or a time the calendar does not have inside a date-time', () => {
    expect(() => mapMeeting({ ...GEMINI, date: '2026-02-30T10:00' })).toThrow(
      /date: 2026-02-30 is not a real day/,
    );
    expect(() => mapMeeting({ ...GEMINI, date: '2026-10-06T25:00' })).toThrow(
      /date: .*not a time of day/,
    );
  });

  it('converts a UTC date-time into the time zone it is given, day and all', () => {
    const { meeting } = mapped(
      { ...GEMINI, date: '2026-07-01T00:01:00.000Z', start: null },
      { timeZone: 'America/Los_Angeles' },
    );
    expect([meeting.date, meeting.start]).toEqual(['2026-06-30', '17:01']);
  });

  it('reads a 12-hour start and a Date object', () => {
    const date = new Date(Date.UTC(2026, 9, 6, 15, 0));
    const { meeting } = mapped(
      { ...GEMINI, date, start: '2:30 PM', end: '3:05 pm' },
      { timeZone: 'America/Los_Angeles' },
    );
    expect([meeting.date, meeting.start, meeting.end]).toEqual(['2026-10-06', '14:30', '15:05']);
  });

  it('refuses a meeting with no start rather than inventing one', () => {
    expect(() => mapMeeting({ ...GEMINI, start: undefined })).toThrow(/start: .*no start time/);
  });

  it('refuses a day the calendar does not have, a date it cannot read, and an unknown zone', () => {
    expect(() => mapMeeting({ ...GEMINI, date: '2026-02-30' })).toThrow(MeetingMappingError);
    expect(() => mapMeeting({ ...GEMINI, date: 'next Tuesday' })).toThrow(/cannot read/);
    expect(() =>
      mapMeeting({ ...GEMINI, date: '2026-10-06T10:00Z' }, { timeZone: 'Mars/Base' }),
    ).toThrow(/not a time zone/);
  });
});

describe('the start of a Gemini meeting, from its email', () => {
  const zone = { timeZone: 'America/Los_Angeles' };
  // The Notion Date for a Gemini meeting: when the notes arrived, not when the meeting began.
  const fromEmail: MeetingFields = { ...GEMINI, date: '2026-10-06T10:52:00.000Z', start: '' };
  const subject = 'Notes: “Platform weekly sync” Oct 6, 2026';

  it('takes the day and time the email states, over the Notion date', () => {
    const { file, meeting } = mapped(
      { ...fromEmail, stated: 'Platform weekly sync - 2026/10/06 09:30 PDT - Notes by Gemini' },
      zone,
    );
    expect([meeting.date, meeting.start]).toEqual(['2026-10-06', '09:30']);
    expect(file.content).not.toMatch(/start_approximate/);
  });

  it('reads a subject that states only the day, a 12-hour time, and a title holding a date', () => {
    const day = mapped({ ...fromEmail, stated: subject, start: '10:00' }, zone).meeting;
    expect([day.date, day.start]).toEqual(['2026-10-06', '10:00']);
    const twelve = mapped(
      { ...fromEmail, stated: 'Notes: “Plan for Oct 9, 2026” Oct 6, 2026 2:30 PM' },
      zone,
    ).meeting;
    expect([twelve.date, twelve.start]).toEqual(['2026-10-06', '14:30']);
    for (const [stated, day] of [
      ['Notes: “Retro” Sept 30, 2026', '2026-09-30'],
      ['Notes: “Retro” Wednesday, September 30 2026', '2026-09-30'],
      ['Notes: “Retro” 2026-05-04', '2026-05-04'],
    ]) {
      expect(mapped({ ...fromEmail, stated, start: '10:00' }, zone).meeting.date).toBe(day);
    }
    expect(() => mapMeeting({ ...fromEmail, stated: 'Notes: Feb 30, 2026' }, zone)).toThrow(
      /stated: 2026-02-30 is not a real day/,
    );
  });

  it('works the start out as arrival less the transcript’s length, and marks it approximate', () => {
    // Arrived 10:52:30 PDT; the transcript ran 00:51:49, so the meeting began about 10:00.
    const { file, meeting } = mapped(
      {
        ...fromEmail,
        stated: subject,
        arrived: '2026-10-06T17:52:30Z',
        transcript: [
          '### 00:00:12',
          'Mara Quill: Morning.',
          '### 00:48:00',
          'Tobias Fenn: Done.',
          '### Transcription ended after 00:51:49',
        ].join('\n'),
      },
      zone,
    );
    expect([meeting.date, meeting.start]).toEqual(['2026-10-06', '10:00']);
    expect(file.content).toMatch(/^start: '10:00'\nstart_approximate: true$/m);
  });

  it('uses the last section stamp when the transcript has no end mark', () => {
    const { meeting } = mapped(
      {
        ...fromEmail,
        stated: subject,
        arrived: '2026-10-06T17:52:00Z',
        transcript: '### 00:00:01\nAnn: Hi.\n### 00:42:00\nBo: Bye.',
      },
      zone,
    );
    expect(meeting.start).toBe('10:10');
  });

  it('refuses, never taking the arrival itself, when there is no transcript to measure', () => {
    const noLength = { ...fromEmail, stated: subject, arrived: '2026-10-06T17:52:00Z' };
    expect(() => mapMeeting({ ...noLength, transcript: '' }, zone)).toThrow(
      new MeetingMappingError(
        'start: the meeting has no start time: the email states none, and with no transcript length the arrival (about when it ended) cannot give one; send `start`, a time in the subject, or a transcript with its times',
      ),
    );
    expect(() => mapMeeting({ ...noLength, transcript: 'Ann Lee: Hi.' }, zone)).toThrow(/^start: /);
  });

  it('keeps a start it is given over the email’s', () => {
    const { file, meeting } = mapped(
      {
        ...fromEmail,
        start: '09:00',
        stated: 'Weekly - 2026/10/06 09:30',
        arrived: '2026-10-06T17:52:00Z',
      },
      zone,
    );
    expect(meeting.start).toBe('09:00');
    expect(file.content).not.toMatch(/start_approximate/);
  });

  it('shows a stated time in another zone on the local clock, moving the day with it', () => {
    const at = (stated: string) => mapped({ ...fromEmail, stated }, zone);
    const late = at('Weekly - 2026/10/07 01:00 EDT - Notes by Gemini');
    expect([late.meeting.date, late.meeting.start]).toEqual(['2026-10-06', '22:00']);
    expect(late.file.content).not.toMatch(/start_approximate/);
    for (const stated of [
      'Weekly - 2026/10/06 18:00 UTC+1',
      'Weekly - 2026/10/06 13:00 -04:00',
      'Weekly - 2026/10/06 13:00 edt',
      'Weekly - 2026/10/06 10:00 PDT',
    ]) {
      expect(at(stated).meeting.start, stated).toBe('10:00');
    }
  });

  it('keeps a time in a zone it cannot convert as written, marked approximate', () => {
    const unknown = mapped({ ...fromEmail, stated: 'Weekly - 2026/10/06 13:00 ACWT' }, zone);
    expect(unknown.meeting.start).toBe('13:00');
    expect(unknown.file.content).toMatch(/^start: '13:00'\nstart_approximate: true$/m);
    const noLocal = mapped({ ...fromEmail, date: '', stated: 'Weekly - 2026/10/06 13:00 EDT' });
    expect(noLocal.file.content).toMatch(/^start: '13:00'\nstart_approximate: true$/m);
  });

  it('reads a word after the time that is no zone as no zone', () => {
    const { file, meeting } = mapped({ ...fromEmail, stated: 'Oct 6, 2026 10:00 Team sync' }, zone);
    expect(meeting.start).toBe('10:00');
    expect(file.content).not.toMatch(/start_approximate/);
  });

  it('refuses stated words with no date in them, and an arrival with no time', () => {
    expect(() => mapMeeting({ ...fromEmail, stated: 'Notes: “Weekly”' }, zone)).toThrow(
      /stated: no date/,
    );
    expect(() =>
      mapMeeting({ ...fromEmail, stated: subject, arrived: '2026-10-06' }, zone),
    ).toThrow(/arrived: /);
  });
});

describe('what a meeting may lack', () => {
  it('without a transcript, has no Transcript section and no transcript clock', () => {
    const { file, meeting } = mapped({ ...GEMINI, transcript: '' });
    expect(file.content).not.toContain('## Transcript');
    expect(file.content).not.toContain('transcript_clock');
    expect(meeting.transcript).toEqual([]);
  });

  it('with only boilerplate where the transcript would be, still has none', () => {
    const transcript = '📖 Transcript\nOct 6, 2026\n### Transcription ended after 00:00:01';
    expect(mapped({ ...GEMINI, transcript }).file.content).not.toContain('## Transcript');
  });

  it('with nothing but the required fields, is still a valid file', () => {
    const { file } = mapped({
      title: 'Quick chat',
      date: '2026-10-06',
      start: '09:00',
      source: 'gemini',
      sourceId: 'a1',
    });
    expect(file.content).not.toContain('## ');
  });

  it.each([
    ['title', { title: '  ' }],
    ['source', { source: undefined }],
    ['source', { source: 'Notes by Gemini' }],
    ['sourceId', { sourceId: null }],
    ['date', { date: undefined, start: '10:00' }],
  ])('refuses a meeting whose %s is missing or unusable', (field, change) => {
    expect(() => mapMeeting({ ...GEMINI, ...change })).toThrow(new RegExp(`^${field}:`));
  });

  it('refuses a field given as a record where text belongs', () => {
    expect(() => mapMeeting({ ...GEMINI, title: { text: 'x' } })).toThrow(/expected text/);
    expect(() => mapMeeting({ ...GEMINI, summary: 42 })).toThrow(/summary: expected text/);
    expect(() => mapMeeting({ ...GEMINI, attendees: 42 })).toThrow(/attendees: expected/);
  });
});

describe('attendees', () => {
  const attendeesOf = (attendees: unknown, options?: MappingOptions) =>
    mapped({ ...GEMINI, attendees }, options).meeting.attendees;

  it('reads Name <email>, a bare address, and a name alone', () => {
    expect(attendeesOf(['Ann Lee <ann@example.com>', 'bo@example.com', 'Cy Park'])).toEqual([
      { name: 'Ann Lee', email: 'ann@example.com', group: false },
      { name: 'bo', email: 'bo@example.com', group: false },
      { name: 'Cy Park', email: null, group: false },
    ]);
  });

  it('takes an address written as the name, with no address given, as the address', () => {
    expect(attendeesOf([{ name: 'mailto:dee.ray@example.com' }])).toEqual([
      { name: 'dee.ray', email: 'dee.ray@example.com', group: false },
    ]);
  });

  // A display name never makes a group: "Staff Sergeant Rivera" is a person.
  it('marks group addresses by their address, a flag or the options, never by the name', () => {
    expect(
      attendeesOf(
        [
          'Design Team — design@example.com',
          'Design — design-team@example.com',
          'Engineering — eng-all@example.com',
          { name: 'Leads', email: 'leads@example.com', group: true },
          'Ops — ops@example.com',
          'Hanna — hanna@example.com',
        ],
        { groupAddresses: ['OPS@example.com'] },
      ).map((each) => [each.name, each.group]),
    ).toEqual([
      ['Design Team', false],
      ['Design', true],
      ['Engineering', true],
      ['Leads', true],
      ['Ops', true],
      ['Hanna', false],
    ]);
  });

  it('reads a group address by its local part, but not a person’s first.last', () => {
    expect(
      attendeesOf(
        'staff@example.com\nall_hands@example.com\nkim.team@example.com\nkim@team.example.com',
      ).map((each) => [each.email, each.group]),
    ).toEqual([
      ['staff@example.com', true],
      ['all_hands@example.com', true],
      ['kim.team@example.com', false],
      ['kim@team.example.com', false],
    ]);
  });

  it('lists the same address once, and skips blank lines and rules', () => {
    expect(attendeesOf('- Ann — ann@example.com\n\n---\n- Ann Lee — ANN@example.com')).toEqual([
      { name: 'Ann', email: 'ann@example.com', group: false },
    ]);
  });
});

describe('next steps', () => {
  const stepsOf = (nextSteps: unknown) =>
    mapped({ ...GEMINI, nextSteps }).meeting.nextSteps.map((step) => [step.owner, step.text]);

  it('never writes a checkbox or a blank owner as an owner', () => {
    expect(stepsOf('- [ ] Do one thing\n- [x] Did another\n- [X] And a third')).toEqual([
      [null, 'Do one thing'],
      [null, 'Did another'],
      [null, 'And a third'],
    ]);
    expect(mapMeeting({ ...GEMINI, nextSteps: [{ owner: 'x', title: 'Plan' }] }).content).toContain(
      '- Plan',
    );
  });

  it('skips items that say nothing, and starts an item from a stray first line', () => {
    expect(stepsOf('Call the vendor\n- \n1. [Ann] Write it up')).toEqual([
      [null, 'Call the vendor'],
      ['Ann', 'Write it up'],
    ]);
  });

  it('drops a records list’s empty steps', () => {
    expect(stepsOf([{ owner: 'Ann' }, { text: 'Follow up' }])).toEqual([[null, 'Follow up']]);
  });
});

describe('prose sections', () => {
  it('turns # and ## headings into ### so they stay in their section', () => {
    const { file } = mapped({ ...GEMINI, summary: '# Big\n## Topic\ntext\n### Kept' });
    expect(file.content).toContain('## Summary\n\n### Big\n### Topic\ntext\n### Kept\n\n## Notes');
  });

  it('closes a code fence the provider left open, so it cannot swallow the next section', () => {
    const { file, meeting } = mapped({ ...GEMINI, summary: '```\n## not a heading' });
    expect(file.content).toContain('```\n## not a heading\n```\n\n## Notes');
    expect(meeting.nextSteps).toHaveLength(2);
  });

  it('drops Gemini’s review and survey lines', () => {
    const summary =
      'Real summary.\nYou should review Gemini’s notes to make sure they’re accurate.\nPlease provide feedback about using Gemini to take notes';
    const { file } = mapped({ ...GEMINI, summary: summary.replace(/’/g, "'") });
    expect(file.content).toContain('## Summary\n\nReal summary.\n\n## Notes');
  });
});

describe('notes handed over as one text, by their headings', () => {
  const GEMINI_NOTES = [
    '## Summary',
    '',
    'Mara and Tobias agreed to ship the cache behind a flag.',
    '',
    '## Decisions',
    '',
    'Ship behind a flag.',
    '',
    '## Next steps',
    '',
    '* [Tobias Fenn] Flag the cache: put it behind a flag before Friday.',
    '* [The group] Review the rollout: look at it together next week.',
    '',
    '## Details',
    '',
    '- Cache rollout: the cache is ready.',
  ].join('\n');
  const together: MeetingFields = {
    ...GEMINI,
    summary: '',
    decisions: '',
    nextSteps: '',
    details: '',
    sections: GEMINI_NOTES,
  };

  it('puts Summary, Decisions, Next steps and Details where the separate fields go', () => {
    expect(mapped(together).file.content).toBe(mapped(GEMINI).file.content);
  });

  it('keeps a field given on its own over its part of the text', () => {
    const { file } = mapped({ ...together, summary: 'Said separately.' });
    expect(file.content).toContain('## Summary\n\nSaid separately.\n\n## Notes');
    expect(file.content).toContain('### Decisions\n\nShip behind a flag.');
  });

  it('reads text before any heading as summary, gathers a heading named twice, keeps others in place', () => {
    const { file, meeting } = mapped({
      ...together,
      sections: [
        'Opening words.',
        '# Details',
        'First detail.',
        '## Topic',
        'Under the topic.',
        '### next steps ###',
        '- [Ann Lee] Plan: write it',
        '## Details',
        'Second detail.',
      ].join('\n'),
    });
    expect(file.content).toContain('## Summary\n\nOpening words.\n\n## Notes');
    expect(file.content).toContain(
      '## Notes\n\nFirst detail.\n### Topic\nUnder the topic.\nSecond detail.\n\n## Provider next steps',
    );
    expect(meeting.nextSteps.map((step) => step.owner)).toEqual(['Ann Lee']);
  });

  it('opens no section at a heading inside a code fence', () => {
    const { file } = mapped({
      ...together,
      sections: '## Summary\n```\n## Details\n```\nAfter the fence.',
    });
    expect(file.content).toContain(
      '## Summary\n\n```\n## Details\n```\nAfter the fence.\n\n## Transcript',
    );
  });

  it('reads notes with none of the headings as all summary, and none at all as nothing', () => {
    const plain = mapped({ ...together, sections: 'Only a paragraph.' }).file.content;
    expect(plain).toContain('## Summary\n\nOnly a paragraph.\n\n## Transcript');
    expect(mapped({ ...together, sections: '' }).file.content).not.toMatch(/## (Summary|Notes)/);
  });

  it('refuses notes that are not text', () => {
    expect(() => mapMeeting({ ...together, sections: { summary: 'x' } })).toThrow(
      /sections: expected text/,
    );
  });
});

describe('transcripts', () => {
  it('drops the title a Gemini transcript doc opens with, above its first stamp only', () => {
    const turnsOf = (transcript: string) =>
      mapped({ ...GEMINI, transcript }).meeting.transcript.map((turn) => [
        turn.writtenSpeaker,
        turn.words,
      ]);
    expect(
      turnsOf(
        [
          '## Platform weekly sync - Transcript',
          '# Retro – Transcript',
          '### 00:00:12',
          'Mara Quill: Next up - transcript tooling.',
          '## Retro – Transcript',
        ].join('\n'),
      ),
    ).toEqual([['Mara Quill', 'Next up - transcript tooling. ## Retro – Transcript']]);
    // A fence line, or a line in a fence, is never the doc's title, even when it reads like one.
    expect(
      turnsOf('``` - Transcript\n## Transcript\n```\n### 00:00:12\nMara Quill: Hi.')[0],
    ).toEqual(['Unknown', '``` - Transcript ## Transcript ```']);
  });

  const turnsOf = (transcript: string) =>
    mapped({ ...GEMINI, transcript }).meeting.transcript.map((turn) => [
      turn.writtenSpeaker,
      turn.time.kind,
      turn.words,
    ]);

  it('keeps two people with the same name, and one person’s consecutive turns, as separate turns', () => {
    expect(turnsOf('### 00:00:01\nSam Lee: One.\nSam Lee: Two.\nSam Lee: Three.')).toEqual([
      ['Sam Lee', 'section', 'One.'],
      ['Sam Lee', 'section', 'Two.'],
      ['Sam Lee', 'section', 'Three.'],
    ]);
  });

  it('never writes a turn with no words, and joins the words that follow to it', () => {
    expect(turnsOf('### 00:01:00\nAnn:\nBo: \nAnn: Hello.')).toEqual([
      ['Ann', 'section', 'Hello.'],
    ]);
    expect(turnsOf('Ann: \nwords after')).toEqual([['Ann', 'none', 'words after']]);
    expect(mapMeeting({ ...GEMINI, transcript: '### 00:01:00\nAnn:\nBo:' }).content).not.toMatch(
      /\^t0001/,
    );
  });

  it('gives words before any speaker to Unknown, with no time before the first section', () => {
    expect(turnsOf('Somebody spoke first.\n### 00:00:05\nAnn: Then me.')).toEqual([
      ['Unknown', 'none', 'Somebody spoke first.'],
      ['Ann', 'section', 'Then me.'],
    ]);
  });

  it('escapes words that open with a time when the turn has none', () => {
    const [turn] = mapped({ ...GEMINI, transcript: 'Ann: [12:30] was the plan' }).meeting
      .transcript;
    expect([turn?.time.kind, turn?.words]).toEqual(['none', '\\[12:30] was the plan']);
    const [other] = mapped({ ...GEMINI, transcript: 'Ann: [-00:00:01] early' }).meeting.transcript;
    expect(other?.words).toBe('\\[-00:00:01] early');
  });

  it('reads **Name:** turns and a bare section time', () => {
    expect(turnsOf('0:09:44\n**Ann Lee:** Hi.')).toEqual([['Ann Lee', 'section', 'Hi.']]);
  });

  it('leaves a Granola time out when it is not a time', () => {
    expect(turnsOf('**[14:75:00] You:** Odd.')).toEqual([['You', 'none', 'Odd.']]);
  });

  it('never stamps a section time a clock cannot show: minutes past 59, or past 23h on a wall clock', () => {
    expect(turnsOf('### 00:59:60\nAnn: Odd.')).toEqual([['Ann', 'none', 'Odd.']]);
    expect(turnsOf('### 30:00:00\nAnn: Long call.')).toEqual([['Ann', 'section', 'Long call.']]);
    const wall = '**[09:00:00] You:** Hi.\n### 30:00:00\nAnn: Later.';
    expect(turnsOf(wall)).toEqual([
      ['You', 'turn', 'Hi.'],
      ['Ann', 'none', 'Later.'],
    ]);
  });

  describe('who a `Label: words` line is spoken by', () => {
    const roster = 'Ann Lee — ann@example.com\nBo Park — bo@example.com';
    const speakers = (transcript: string, attendees: string | undefined = roster) =>
      mapped({ ...GEMINI, attendees, transcript }).meeting.transcript.map((turn) => [
        turn.writtenSpeaker,
        turn.words,
      ]);

    it('starts a turn for an attendee, a speaker already heard, or a provider’s own label', () => {
      expect(
        speakers(
          'Ann Lee: One.\nbo park: Two.\nAnn Lee: Three.\nRemote Speaker: Four.\nYou: Five.',
        ),
      ).toEqual([
        ['Ann Lee', 'One.'],
        ['bo park', 'Two.'],
        ['Ann Lee', 'Three.'],
        ['Unknown', 'Four.'],
        ['You', 'Five.'],
      ]);
    });

    it('gives a Gemini speaker who is no attendee and was never heard a turn of their own', () => {
      expect(
        speakers('### 00:00:01\nAnn Lee: The plan.\nCy Guest: A question.\nAnn Lee: Go on.'),
      ).toEqual([
        ['Ann Lee', 'The plan.'],
        ['Cy Guest', 'A question.'],
        ['Ann Lee', 'Go on.'],
      ]);
      expect(speakers('Ann Lee: The plan.\nPhase two: the rollout.')).toEqual([
        ['Ann Lee', 'The plan.'],
        ['Phase two', 'the rollout.'],
      ]);
    });

    it('writes one turn per labelled line of a Gemini transcript, attendee or not', () => {
      const people = ['Ann Lee', 'Bo Park', 'Cy Guest', 'Dee Room', 'Eli Visitor'];
      const lines = Array.from({ length: 20 }, (_, at) => `${people[at % 5]}: Point ${at}.`);
      const transcript = lines.flatMap((line, at) =>
        at % 6 === 0 ? [`### 00:${String(at).padStart(2, '0')}:00`, line] : [line],
      );
      const turns = speakers(transcript.join('\n'));
      expect(turns).toHaveLength(lines.length);
      expect(turns.map(([speaker]) => speaker)).toEqual(lines.map((line) => line.split(':')[0]));
    });

    it('continues the turn for a known note label, never a speaker', () => {
      expect(
        speakers(
          'Ann Lee: Two things.\nNote: we ship Friday.\nAction item: call Bo.\nTODO: tests.\nLink: the doc.\nURL: https://example.com',
        ),
      ).toEqual([
        [
          'Ann Lee',
          'Two things. Note: we ship Friday. Action item: call Bo. TODO: tests. Link: the doc. URL: https://example.com',
        ],
      ]);
    });

    it('in a Granola transcript, still reads an unstamped label nobody answers to as words', () => {
      expect(speakers('**[14:00:00] Ann Lee:** The plan.\nPhase two: the rollout.')).toEqual([
        ['Ann Lee', 'The plan. Phase two: the rollout.'],
      ]);
    });

    it('takes the first line of a section as a speaker, who is then known', () => {
      expect(speakers('### 00:00:01\nCy Guest: Hello.\nAnn Lee: Hi.\nCy Guest: Thanks.')).toEqual([
        ['Cy Guest', 'Hello.'],
        ['Ann Lee', 'Hi.'],
        ['Cy Guest', 'Thanks.'],
      ]);
    });

    it('with no attendees to check, takes any name, but never a note label', () => {
      expect(
        speakers('Ann: One.\nAction item: call Bo.\nURL: https://example.com\nBo: Two.', ''),
      ).toEqual([
        ['Ann', 'One. Action item: call Bo. URL: https://example.com'],
        ['Bo', 'Two.'],
      ]);
    });
  });

  it('numbers past t9999 without repeating an id', () => {
    const transcript = Array.from({ length: 10001 }, (_, index) => `Ann: Line ${index}.`).join(
      '\n',
    );
    const { meeting } = mapped({ ...GEMINI, transcript });
    expect(meeting.transcript.at(-1)?.blockId).toBe('t10001');
  });
});

describe('the file name', () => {
  const pathOf = (title: string) => mapMeeting({ ...GEMINI, title }).path;

  it('takes out what no filesystem or link accepts', () => {
    expect(pathOf('Chris / James 1:1')).toBe('Meetings/2026/10/2026-10-06 Chris James 1 1.md');
    expect(pathOf('Sprint #42 [draft] ^x')).toBe(
      'Meetings/2026/10/2026-10-06 Sprint 42 draft x.md',
    );
    expect(pathOf('...hidden?')).toBe('Meetings/2026/10/2026-10-06 hidden.md');
    expect(pathOf('///')).toBe('Meetings/2026/10/2026-10-06 Untitled.md');
  });

  it('keeps emoji whole and fits a very long title in 255 bytes', () => {
    expect(pathOf('Launch 🚀 review')).toBe('Meetings/2026/10/2026-10-06 Launch 🚀 review.md');
    const path = pathOf(`Kickoff ${'🚀'.repeat(100)}`);
    const name = path.slice('Meetings/2026/10/'.length);
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(255);
    expect(name).toMatch(/🚀\.md$/);
    expect(
      [...name.replace(/\.md$/, '').replace('2026-10-06 Kickoff ', '')].every(
        (each) => each === '🚀',
      ),
    ).toBe(true);
  });

  it.each(['Weekly sync', 'Chris / James 1:1', 'a*b?c"d<e>f|g', `Long ${'é'.repeat(200)}`])(
    'names %s as the vault would name a note',
    (title) => {
      const stem = `2026-10-06 ${title}`;
      const vault = noteFileName(fitFileNameStem(stem, '.md'));
      expect(pathOf(title)).toBe(`Meetings/2026/10/${noteFileName(vault)}`);
    },
  );

  it('keeps the full title in the frontmatter', () => {
    const title = `Chris / James 1:1 ${'x'.repeat(300)}`;
    expect(mapped({ ...GEMINI, title }).meeting.title).toBe(title);
  });

  it('has a second path naming the provider and a short hash of the id, for when another meeting holds the first', () => {
    const { collisionPath } = mapMeeting({ ...GEMINI, title: '1:1' });
    expect(collisionPath).toMatch(
      /^Meetings\/2026\/10\/2026-10-06 1 1 \(gemini [0-9a-f]{8}\)\.md$/,
    );
    expect(mapMeeting({ ...GEMINI, title: '1:1' }).collisionPath).toBe(collisionPath);
    const other = mapMeeting({ ...GEMINI, title: '1:1', sourceId: 'fake-meeting-0002' });
    expect(other.collisionPath).not.toBe(collisionPath);
    const long = mapMeeting({ ...GEMINI, title: 'y'.repeat(400) }).collisionPath;
    expect(new TextEncoder().encode(long.slice('Meetings/2026/10/'.length)).length).toBe(255);
    expect(long).toMatch(/y \(gemini [0-9a-f]{8}\)\.md$/);
  });

  it('fits a long provider name and keeps the date', () => {
    const provider = 'p'.repeat(300);
    const { collisionPath } = mapMeeting({ ...GEMINI, source: provider });
    const name = collisionPath.slice('Meetings/2026/10/'.length);
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(255);
    expect(name).toMatch(/^2026-10-06 Platform weekly sync \(p+ [0-9a-f]{8}\)\.md$/);
  });

  describe('where n8n’s JavaScript lacks Intl.Segmenter or TextEncoder', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('still cuts by whole characters and fits 255 bytes', () => {
      const title = `Kickoff ${'🚀'.repeat(100)}`;
      const expected = mapMeeting({ ...GEMINI, title }).path;
      vi.stubGlobal('Intl', Object.assign(Object.create(Intl) as object, { Segmenter: undefined }));
      vi.stubGlobal('TextEncoder', undefined);
      expect(mapMeeting({ ...GEMINI, title }).path).toBe(expected);
    });
  });
});

describe('the body’s shape, which the contract reads strictly', () => {
  const tricky: MeetingFields = {
    ...GEMINI,
    summary: 'Summary line ^t0001\n## Summary\n~~~\nopen code',
    details: '- Detail ^abc-1',
    decisions: '^t0002',
    nextSteps: '- [Ann] Ship it ^t0003',
    attendees: 'Ann — ann@example.com\nBo — bo@example.com',
    transcript: '### 00:00:01\nAnn: One ^t0009\nBo: Two.\n**[24:00:01] You:** Three.',
  };

  it('writes exactly the four headings, in order, as ## lines', () => {
    const headings = mapMeeting(tricky)
      .content.split('\n')
      .filter((line) => /^#{1,2} /.test(line));
    expect(headings).toEqual(['## Summary', '## Notes', '## Provider next steps', '## Transcript']);
  });

  it('writes each turn as its own paragraph, a blank line between turns', () => {
    const transcript = mapMeeting(tricky).content.split('## Transcript\n\n')[1] ?? '';
    const paragraphs = transcript.trimEnd().split('\n\n');
    expect(paragraphs).toHaveLength(3);
    for (const paragraph of paragraphs) expect(paragraph).toMatch(/^\*\*[^\n]+ \^t\d{4}$/);
  });

  it('puts block ids only on turns, numbered strictly upward from t0001', () => {
    const { file, meeting } = mapped(tricky);
    const beforeTranscript = file.content.split('## Transcript')[0] ?? '';
    expect(beforeTranscript).not.toMatch(/(^|\s)\^[A-Za-z0-9-]+\s*$/m);
    expect(meeting.transcript.map((turn) => turn.blockId)).toEqual(['t0001', 't0002', 't0003']);
    expect(meeting.nextSteps.map((step) => step.blockId)).toEqual([null]);
  });

  it('never stamps a wall-clock turn past 23:59:59', () => {
    const { meeting } = mapped(tricky);
    expect(meeting.transcript.at(-1)).toMatchObject({
      writtenSpeaker: 'You',
      time: { kind: 'none' },
    });
  });

  it('closes a ~~~ fence left open as well', () => {
    expect(mapMeeting(tricky).content).toContain('~~~\nopen code\n~~~\n\n## Notes');
  });

  it('closes a fence only as CommonMark does: same character, at least as many', () => {
    const summary = '````\n```\n~~~~\n## inside';
    const { file } = mapped({ ...GEMINI, summary });
    expect(file.content).toContain('````\n```\n~~~~\n## inside\n````\n\n## Notes');
  });

  it('writes a provider heading that names a section, at any level, as bold text', () => {
    const summary = '### Notes\n# Transcript ^h1\n#### Provider Next Steps ##\n### Next Steps';
    const { file } = mapped({ ...GEMINI, summary });
    expect(file.content).toContain(
      '## Summary\n\n**Notes**\n**Transcript**\n**Provider Next Steps**\n### Next Steps\n\n## Notes',
    );
  });
});
