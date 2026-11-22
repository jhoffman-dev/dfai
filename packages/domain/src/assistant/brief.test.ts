import { describe, expect, it } from 'vitest';
import type { BoardRow } from '../query/group-rows.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import type { AnsweredSection, ItemContext, TaskStatusWords } from './assistant-items.ts';
import { notListed, onOrBefore } from './assistant-items.ts';
import type { FollowUpRow } from './assistant-queries.ts';
import {
  BRIEF_DECISIONS,
  BRIEF_MEETINGS,
  BRIEF_MENTIONS,
  briefPartsOf,
  lastMeetingRow,
  LOOP_LIMIT,
  openLoopsOf,
} from './brief.ts';
import { linkingAmong } from './citation.ts';

const DAY = '2026-10-20';
const STATUS: TaskStatusWords = { key: 'status', done: 'archive' };

const row = (path: string, values: Record<string, unknown> = {}): BoardRow => ({
  path,
  title: path.replace(/^.*\//, '').replace(/\.md$/, ''),
  values,
});

const section = (
  id: AnsweredSection['id'],
  rows: readonly BoardRow[],
  more: Partial<AnsweredSection> = {},
): AnsweredSection => ({ id, rows, truncated: false, problem: null, ...more });

const PATHS = [
  'Meetings/Kickoff.md',
  'Meetings/Sync.md',
  'Tasks/Draft.md',
  'Tasks/Quote.md',
  'Tasks/Chase.md',
  'Decisions/Two-step.md',
].map(createVaultPath);

function context(sources: Record<string, string> = {}): ItemContext {
  return {
    ...linkingAmong(PATHS),
    sources: new Map(Object.entries(sources)),
    hasBlock: () => true,
    day: DAY,
    time: null,
  };
}

const followUp = (path: string, more: Partial<FollowUpRow> = {}): FollowUpRow => ({
  path,
  title: path.replace(/^.*\//, '').replace(/\.md$/, ''),
  status: 'inbox',
  due: null,
  source: null,
  waitingOn: null,
  modified: null,
  direct: true,
  meeting: null,
  meetingTitle: null,
  ...more,
});

describe('openLoopsOf', () => {
  const sections = [
    section('waiting', [
      row('Tasks/Quote.md', {
        status: 'waiting',
        waiting_on: '[[Mara Quill]]',
        modified: '2026-10-10',
      }),
    ]),
    section('tasks', [
      row('Tasks/Draft.md', { status: 'next-action', due: '2026-10-19' }),
      row('Tasks/Chase.md', { status: 'inbox' }),
    ]),
  ];

  it('cites every item, and the turn a task says it came from', () => {
    const loops = openLoopsOf({
      sections,
      followUps: [],
      status: STATUS,
      context: context({ 'Tasks/Draft.md': '[[Kickoff#^t0003]]' }),
    });
    expect(loops.openTasks[0]).toEqual({
      path: 'Tasks/Draft.md',
      title: 'Draft',
      cite: { link: '[[Draft]]', kind: 'note', path: 'Tasks/Draft.md' },
      status: 'next-action',
      due: '2026-10-19',
      overdue: true,
      waitingOn: null,
      waitingDays: null,
      source: { link: '[[Kickoff#^t0003]]', kind: 'block', path: 'Meetings/Kickoff.md' },
    });
    expect(loops.waitingFor[0]).toMatchObject({
      path: 'Tasks/Quote.md',
      waitingOn: '[[Mara Quill]]',
      waitingDays: 10,
      overdue: false,
      source: null,
    });
  });

  it('takes a waiting section’s rows as waiting though the section does not show their status', () => {
    const loops = openLoopsOf({
      sections: [
        section('waiting', [
          row('Tasks/Quote.md', { project: '[[Migration]]', modified: '2026-10-19' }),
        ]),
      ],
      followUps: [],
      status: STATUS,
      context: context(),
    });
    expect(loops.waitingFor[0]).toMatchObject({
      status: 'waiting',
      waitingDays: 1,
      waitingOn: null,
    });
  });

  it('lists a follow-up once, under follow-ups and not under open tasks', () => {
    const loops = openLoopsOf({
      sections,
      followUps: [followUp('Tasks/Chase.md', { source: '[[Sync#^t0001]]' })],
      status: STATUS,
      context: context(),
    });
    expect(loops.openTasks.map((task) => task.path)).toEqual(['Tasks/Draft.md']);
    expect(loops.followUps.map((task) => task.source?.link)).toEqual(['[[Sync#^t0001]]']);
  });

  it('says how a follow-up was reached: by the page itself, or only through a meeting', () => {
    const loops = openLoopsOf({
      sections,
      followUps: [
        followUp('Tasks/Chase.md'),
        followUp('Tasks/Draft2.md', {
          direct: false,
          meeting: 'Meetings/Kickoff.md',
          meetingTitle: 'Kickoff',
        }),
      ],
      status: STATUS,
      context: context(),
    });
    expect(loops.followUps.map(({ via, meeting }) => [via, meeting?.cite.link ?? null])).toEqual([
      ['direct', null],
      ['meeting', '[[Kickoff]]'],
    ]);
  });

  it('keeps who a waiting follow-up waits on and how long, to the day asked about', () => {
    const loops = openLoopsOf({
      sections,
      followUps: [
        followUp('Tasks/Chase.md', {
          status: 'waiting',
          waitingOn: 'the bank',
          modified: '2026-10-17',
        }),
      ],
      status: STATUS,
      context: context(),
    });
    expect(loops.followUps[0]).toMatchObject({ waitingOn: 'the bank', waitingDays: 3 });
  });

  it('keeps a follow-up that is waiting under waiting-fors only', () => {
    const loops = openLoopsOf({
      sections,
      followUps: [followUp('Tasks/Quote.md')],
      status: STATUS,
      context: context(),
    });
    expect(loops.followUps).toEqual([]);
    expect(loops.waitingFor.map((task) => task.path)).toEqual(['Tasks/Quote.md']);
  });

  it('splits a meeting’s tasks — one section of every status — into waiting and open, leaving the finished out', () => {
    const loops = openLoopsOf({
      sections: [
        section('tasks', [
          row('Tasks/Draft.md', { status: 'archive', due: '2026-01-01' }),
          row('Tasks/Quote.md', { status: 'waiting' }),
          row('Tasks/Chase.md', { status: 'inbox' }),
        ]),
      ],
      followUps: [],
      status: STATUS,
      context: context(),
    });
    expect(loops.openTasks.map((task) => task.path)).toEqual(['Tasks/Chase.md']);
    expect(loops.waitingFor.map((task) => task.path)).toEqual(['Tasks/Quote.md']);
  });

  it('keeps every task when the Task type has no finished status', () => {
    const loops = openLoopsOf({
      sections: [section('tasks', [row('Tasks/Draft.md', { status: 'archive' })])],
      followUps: [],
      status: { key: 'status', done: null },
      context: context(),
    });
    expect(loops.openTasks).toHaveLength(1);
  });

  it('says it was cut when a list passes its cap or the index held rows back', () => {
    const many = Array.from({ length: LOOP_LIMIT + 1 }, (_, at) =>
      row(`Tasks/T${at}.md`, { status: 'inbox' }),
    );
    const cut = openLoopsOf({
      sections: [section('tasks', many)],
      followUps: [],
      status: STATUS,
      context: context(),
    });
    expect(cut.openTasks).toHaveLength(LOOP_LIMIT);
    expect(cut.truncated).toBe(true);
    const held = openLoopsOf({
      sections: [section('waiting', [], { truncated: true })],
      followUps: [],
      status: STATUS,
      context: context(),
    });
    expect(held.truncated).toBe(true);
    // Follow-ups are found through the meetings listed: held-back meetings may hold more.
    const heldMeetings = openLoopsOf({
      sections: [section('meetings', [], { truncated: true })],
      followUps: [],
      status: STATUS,
      context: context(),
    });
    expect(heldMeetings.truncated).toBe(true);
    const whole = openLoopsOf({ sections, followUps: [], status: STATUS, context: context() });
    expect(whole.truncated).toBe(false);
  });
});

describe('lastMeetingRow', () => {
  const meetings = section('meetings', [
    row('Meetings/Undated.md', {}),
    row('Meetings/Later.md', { date: '2026-10-25' }),
    row('Meetings/Sync.md', { date: '2026-10-20' }),
    row('Meetings/Kickoff.md', { date: '2026-10-01' }),
  ]);

  it('is the newest meeting dated on or before the day, never an undated one', () => {
    expect(lastMeetingRow([meetings], DAY)?.path).toBe('Meetings/Sync.md');
    expect(lastMeetingRow([meetings], '2026-10-19')?.path).toBe('Meetings/Kickoff.md');
    expect(lastMeetingRow([meetings], '2026-09-01')).toBeNull();
  });

  it('is the first listed of two on the same day', () => {
    const same = section('meetings', [
      row('Meetings/A.md', { date: DAY }),
      row('Meetings/B.md', { date: DAY }),
    ]);
    expect(lastMeetingRow([same], DAY)?.path).toBe('Meetings/A.md');
  });

  it('is none for a page with no meetings', () => {
    expect(lastMeetingRow([], DAY)).toBeNull();
  });
});

describe('briefPartsOf', () => {
  const sections = [
    section('people', [row('People/Mara Quill.md')]),
    section('meetings', [
      row('Meetings/Later.md', { date: '2026-10-25' }),
      row('Meetings/Sync.md', { date: '2026-10-20' }),
      row('Meetings/Kickoff.md', { date: '2026-10-01' }),
      row('Meetings/Undated.md', {}),
    ]),
    section('decisions', [
      row('Decisions/After.md', { date: '2026-10-30' }),
      row('Decisions/Two-step.md', { date: '2026-10-01' }),
    ]),
    section('notes', [row('Resources/Runbook.md', { type: 'Resource' })]),
    section('projects', [row('Projects/Migration.md')]),
  ];

  it('says when the page was last met, what was met and decided by the day, and what links it', () => {
    const parts = briefPartsOf({
      sections,
      lastMeetingSections: [
        section('tasks', [
          row('Tasks/Draft.md', { status: 'archive', due: '2026-01-01' }),
          row('Tasks/Quote.md', { status: 'inbox', due: '2026-01-01' }),
        ]),
        section('decisions', [row('Decisions/Two-step.md')]),
      ],
      status: STATUS,
      context: context({ 'Decisions/Two-step.md': '[[Kickoff#^t0004]]' }),
    });
    expect(parts.lastTouch).toEqual({
      path: 'Meetings/Sync.md',
      title: 'Sync',
      date: '2026-10-20',
      cite: { link: '[[Sync]]', kind: 'note', path: 'Meetings/Sync.md' },
    });
    expect(parts.meetings.map((meeting) => meeting.path)).toEqual([
      'Meetings/Sync.md',
      'Meetings/Kickoff.md',
      'Meetings/Undated.md',
    ]);
    expect(parts.decisions.map((decision) => [decision.path, decision.source?.link])).toEqual([
      ['Decisions/Two-step.md', '[[Kickoff#^t0004]]'],
    ]);
    expect(parts.lastMeeting?.meeting.path).toBe('Meetings/Sync.md');
    // The last meeting's tasks are all of them, finished ones too: what came of it.
    expect(parts.lastMeeting?.tasks.map((task) => task.status)).toEqual(['archive', 'inbox']);
    // A finished task is never overdue, however long ago it was due.
    expect(parts.lastMeeting?.tasks.map((task) => task.overdue)).toEqual([false, true]);
    expect(parts.lastMeeting?.decisions.map((decision) => decision.cite.link)).toEqual([
      '[[Two-step]]',
    ]);
    expect(parts.mentions.map((note) => note.path)).toEqual(['Resources/Runbook.md']);
    expect(parts.related.map((note) => [note.path, note.relation])).toEqual([
      ['People/Mara Quill.md', 'person'],
      ['Projects/Migration.md', 'project'],
    ]);
    expect(parts.truncated).toBe(false);
  });

  it('has no last meeting for a page that has not met by the day', () => {
    const parts = briefPartsOf({
      sections,
      lastMeetingSections: [],
      status: STATUS,
      context: { ...context(), day: '2026-09-01' },
    });
    expect(parts.lastTouch).toBeNull();
    expect(parts.lastMeeting).toBeNull();
    expect(parts.meetings.map((meeting) => meeting.path)).toEqual(['Meetings/Undated.md']);
  });

  it('caps meetings, decisions and mentions, and says so', () => {
    const dated = (folder: string, count: number) =>
      Array.from({ length: count }, (_, at) => row(`${folder}/N${at}.md`, { date: '2026-10-01' }));
    const parts = briefPartsOf({
      sections: [
        section('meetings', dated('Meetings', BRIEF_MEETINGS + 1)),
        section('decisions', dated('Decisions', BRIEF_DECISIONS)),
        section('notes', dated('Notes', BRIEF_MENTIONS)),
      ],
      lastMeetingSections: [],
      status: STATUS,
      context: context(),
    });
    expect(parts.meetings).toHaveLength(BRIEF_MEETINGS);
    expect(parts.decisions).toHaveLength(BRIEF_DECISIONS);
    expect(parts.mentions).toHaveLength(BRIEF_MENTIONS);
    expect(parts.truncated).toBe(true);
  });

  it('says it was cut when a section was held back', () => {
    const parts = briefPartsOf({
      sections: [section('notes', [], { truncated: true })],
      lastMeetingSections: [],
      status: STATUS,
      context: context(),
    });
    expect(parts.truncated).toBe(true);
  });
});

describe('listing helpers', () => {
  const notes = PATHS.slice(0, 3).map((path) => ({
    path,
    title: path,
    cite: { link: '', kind: 'note' as const, path },
    date: null,
  }));

  it('leaves out what another list holds', () => {
    expect(notListed(notes, notes.slice(1)).map((note) => note.path)).toEqual([
      'Meetings/Kickoff.md',
    ]);
  });

  it('keeps the dated on or before a day, and the undated, up to a limit', () => {
    const dated = [
      { ...notes[0]!, date: '2026-10-21' },
      { ...notes[1]!, date: '2026-10-20' },
      { ...notes[2]!, date: null },
    ];
    expect(onOrBefore(dated, DAY, 5).map((note) => note.date)).toEqual(['2026-10-20', null]);
    expect(onOrBefore(dated, DAY, 1)).toHaveLength(1);
  });
});
