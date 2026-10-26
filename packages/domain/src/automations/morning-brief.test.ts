/** The morning brief's rules (#39): which meetings, which day, the brief's key, name and data. */
import { describe, expect, it } from 'vitest';
import type { LoopTask } from '../assistant/assistant-items.ts';
import type { DayMeeting } from '../google-calendar/todays-meetings.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import { describePlan } from './automation-plan.ts';
import { AUTOMATION_PRESETS } from './presets.ts';
import {
  BRIEF_SECTION_ITEMS,
  briefDayOf,
  briefFolder,
  briefItem,
  briefNoteName,
  meetingBriefData,
  meetingsToBrief,
  type PageBrief,
} from './morning-brief.ts';

const at = createVaultPath;
const cite = (path: string) => ({ link: `[[${path}]]`, kind: 'note' as const, path });

const meeting = (fields: Partial<DayMeeting> = {}): DayMeeting => ({
  path: at('Calendar/2026-10-26 Larkspur sync.md'),
  title: 'Larkspur sync',
  start: '09:30',
  end: '10:00',
  people: [at('People/Mara Quill.md')],
  companies: [],
  meeting: null,
  unanswered: false,
  ...fields,
});

const task = (title: string, fields: Partial<LoopTask> = {}): LoopTask => ({
  path: `Tasks/${title}.md`,
  title,
  cite: cite(`Tasks/${title}.md`),
  status: 'next-action',
  due: null,
  overdue: false,
  waitingOn: null,
  waitingDays: null,
  source: null,
  ...fields,
});

const page = (fields: Partial<PageBrief> = {}): PageBrief => ({
  page: { path: 'People/Mara Quill.md', title: 'Mara Quill', type: 'person' },
  openTasks: [],
  waitingFor: [],
  followUps: [],
  lastTouch: null,
  lastMeeting: null,
  decisions: [],
  mentions: [],
  truncated: false,
  ...fields,
});

const about = (data: ReturnType<typeof meetingBriefData>, label: string) =>
  data.data.find((section) => section.about === label)?.text;

describe('briefDayOf', () => {
  it('is the slot’s day while it is still that day', () => {
    expect(briefDayOf({ slot: '2026-10-26T07:00:00', now: '2026-10-26T07:00:00' })).toBe(
      '2026-10-26',
    );
    expect(briefDayOf({ slot: '2026-10-26T07:00:00', now: '2026-10-26T23:59:59' })).toBe(
      '2026-10-26',
    );
  });

  it('is none for a slot caught up the next day: those meetings are over', () => {
    expect(briefDayOf({ slot: '2026-10-25T07:00:00', now: '2026-10-26T06:30:00' })).toBeNull();
  });
});

describe('meetingsToBrief', () => {
  it('keeps the meetings with a linked person or company, in order', () => {
    const company = meeting({
      title: 'Vendor',
      people: [],
      companies: [at('Companies/Larkspur Payroll.md')],
    });
    const alone = meeting({ title: 'Focus', people: [], companies: [] });
    const both = meeting({ title: 'Sync' });
    expect(meetingsToBrief([company, alone, both])).toEqual([company, both]);
  });
});

describe('briefItem', () => {
  const path = at('Calendar/2026-10-26 Larkspur sync.md');

  it('is the Google event’s id, which both Macs’ event notes carry', () => {
    expect(briefItem({ path, properties: { gcal_event_id: ' ev-sync ' } })).toBe('gcal:ev-sync');
  });

  it('is the event note’s path when it names no event', () => {
    expect(briefItem({ path, properties: {} })).toBe(path);
    expect(briefItem({ path, properties: { gcal_event_id: '  ' } })).toBe(path);
    expect(briefItem({ path, properties: { gcal_event_id: 7 } })).toBe(path);
  });
});

describe('briefFolder and briefNoteName', () => {
  it('puts a day’s briefs in a folder of the day', () => {
    expect(briefFolder('Inbox/Briefs', '2026-10-26')).toBe('Inbox/Briefs/2026-10-26');
    expect(briefFolder('Inbox/Briefs//', '2026-10-26')).toBe('Inbox/Briefs/2026-10-26');
  });

  it('names a brief by its start and title, with no colon or link in it', () => {
    expect(briefNoteName(meeting())).toBe('09.30 Larkspur sync');
    expect(briefNoteName({ start: '14:05', title: '  [[Sneaky]]\nlink ' })).toBe(
      '14.05 [ [Sneaky] ] link',
    );
    expect(briefNoteName({ start: '08:00', title: '   ' })).toBe('08.00 Meeting');
  });

  it('names a brief "Meeting" when its title cleans away to nothing, never the time alone', () => {
    expect(briefNoteName({ start: '09:30', title: '.' })).toBe('09.30 Meeting');
    expect(briefNoteName({ start: '09:30', title: '..' })).toBe('09.30 Meeting');
    expect(briefNoteName({ start: '09:30', title: ' / ? ' })).toBe('09.30 Meeting');
    expect(briefNoteName({ start: '09:30', title: '.plan.' })).toBe('09.30 plan');
  });
});

describe('meetingBriefData', () => {
  it('opens with the meeting, its time and its meeting note, each cited', () => {
    const data = meetingBriefData({
      meeting: meeting({ meeting: at('Meetings/Larkspur sync.md'), unanswered: true }),
      briefs: [],
    });
    expect(about(data, 'The meeting')).toBe(
      [
        '- [[Calendar/2026-10-26 Larkspur sync.md]] Larkspur sync — today 09:30–10:00, not answered yet',
        '- [[Meetings/Larkspur sync.md]] Larkspur sync — its meeting note',
      ].join('\n'),
    );
    expect(data.sources).toEqual([
      'Calendar/2026-10-26 Larkspur sync.md',
      'Meetings/Larkspur sync.md',
    ]);
  });

  it('says a meeting with no end by its start', () => {
    const data = meetingBriefData({ meeting: meeting({ end: null }), briefs: [] });
    expect(about(data, 'The meeting')).toContain('— today at 09:30');
  });

  it('hands what brief() says of each person, every line linking its note', () => {
    const lastMeeting = {
      meeting: {
        path: 'Meetings/Kickoff.md',
        title: 'Kickoff',
        cite: cite('Meetings/Kickoff.md'),
        date: '2026-10-12',
      },
      tasks: [task('Send the contract')],
      decisions: [
        { path: 'Decisions/Go live.md', title: 'Go live', cite: cite('Decisions/Go live.md') },
      ],
    };
    const data = meetingBriefData({
      meeting: meeting(),
      briefs: [
        page({
          lastTouch: lastMeeting.meeting,
          openTasks: [task('Draft the plan', { due: '2026-10-24', overdue: true })],
          waitingFor: [
            task('Chase the quote', { status: 'waiting', waitingOn: 'Mara Quill', waitingDays: 9 }),
          ],
          followUps: [{ ...task('Ask about the bank'), via: 'direct', meeting: null }],
          lastMeeting,
          decisions: [{ ...lastMeeting.decisions[0]!, date: '2026-10-12', source: null }],
          mentions: [
            { path: 'Notes/Payroll.md', title: 'Payroll', cite: cite('Notes/Payroll.md') },
          ],
        }),
      ],
    });
    expect(about(data, 'person Mara Quill')).toBe(
      '- [[People/Mara Quill.md]] Mara Quill — last met 2026-10-12',
    );
    expect(about(data, 'Open tasks with Mara Quill')).toBe(
      '- [[Tasks/Draft the plan.md]] Draft the plan — status next-action, due 2026-10-24, overdue',
    );
    expect(about(data, 'Waiting for, with Mara Quill')).toBe(
      '- [[Tasks/Chase the quote.md]] Chase the quote — status waiting, waiting on Mara Quill, for 9 days',
    );
    expect(about(data, 'Follow-ups with Mara Quill')).toContain('[[Tasks/Ask about the bank.md]]');
    expect(about(data, 'The last meeting with Mara Quill, and what came of it')).toBe(
      [
        '- [[Meetings/Kickoff.md]] Kickoff — 2026-10-12',
        '- [[Tasks/Send the contract.md]] Send the contract — status next-action',
        '- [[Decisions/Go live.md]] Go live — decided',
      ].join('\n'),
    );
    expect(about(data, 'Decisions with Mara Quill')).toBe(
      '- [[Decisions/Go live.md]] Go live — 2026-10-12',
    );
    expect(about(data, 'Notes lately mentioning Mara Quill')).toBe(
      '- [[Notes/Payroll.md]] Payroll',
    );
    // One note, one citation, however often it is listed.
    expect(data.sources.filter((source) => source === 'Decisions/Go live.md')).toHaveLength(1);
    expect(data.sources).toContain('Tasks/Chase the quote.md');
  });

  it('says "None." for an empty list, and that a person was never met', () => {
    const data = meetingBriefData({ meeting: meeting(), briefs: [page()] });
    expect(about(data, 'person Mara Quill')).toBe(
      '- [[People/Mara Quill.md]] Mara Quill — not met before',
    );
    expect(about(data, 'Open tasks with Mara Quill')).toBe('None.');
    expect(about(data, 'The last meeting with Mara Quill, and what came of it')).toBe('None.');
  });

  it('lists at most a section’s share, and counts the rest', () => {
    const tasks = Array.from({ length: BRIEF_SECTION_ITEMS + 3 }, (_, n) => task(`Task ${n}`));
    const text = about(
      meetingBriefData({ meeting: meeting(), briefs: [page({ openTasks: tasks })] }),
      'Open tasks with Mara Quill',
    )!;
    expect(text.split('\n')).toHaveLength(BRIEF_SECTION_ITEMS + 1);
    expect(text.endsWith('And 3 more.')).toBe(true);
  });

  it('says when the vault held more than was read', () => {
    const data = meetingBriefData({ meeting: meeting(), briefs: [page({ truncated: true })] });
    expect(about(data, 'More about Mara Quill')).toContain('a list may be short');
    expect(
      about(meetingBriefData({ meeting: meeting(), briefs: [page()] }), 'More about Mara Quill'),
    ).toBeUndefined();
  });

  it('cites a note no link can name by an id, shown as its title', () => {
    const odd = task('Pay #1', { path: 'Tasks/Pay #1.md', title: 'Pay #1' });
    const data = meetingBriefData({ meeting: meeting(), briefs: [page({ openTasks: [odd] })] });
    expect(about(data, 'Open tasks with Mara Quill')).toBe(
      '- [[src:3]] Pay #1 — status next-action',
    );
    expect(data.sources).toContain('src:3');
    expect(data.plain.get('src:3')).toBe('Pay #1');
  });

  it('names the linked pages it could not read, linking none of them', () => {
    const data = meetingBriefData({
      meeting: meeting(),
      briefs: [],
      unread: [{ path: at('People/Gone [[x]].md'), problem: 'No note at\nPeople/Gone.md' }],
    });
    expect(about(data, 'Linked from the meeting, and could not be read')).toBe(
      '- Gone [ [x] ]: No note at People/Gone.md',
    );
    expect(data.sources).not.toContain('People/Gone [[x]].md');
  });
});

describe('what a dry run of the morning brief says', () => {
  it('says it would brief today’s meetings, not that it writes one note', () => {
    const { action } = AUTOMATION_PRESETS.find((each) => each.name === 'Morning brief')!;
    const plan = { action, paths: [], passedOver: [], capped: false };
    expect(describePlan(plan)).toBe(
      'Would write a brief for each of today’s meetings with a linked person or company that has none yet.',
    );
  });
});
