import { describe, expect, it } from 'vitest';
import { createVaultPath, type ActivityEvent } from '@dfai/domain';
import { activityEntries, subjectOf } from './activity-rows.ts';

const TODAY = '2026-10-06';
const at = (minute: number) => new Date(2026, 9, 6, 9, minute).getTime();
const MEETING = createVaultPath('Inbox/Meetings/2026-10-06 Standup.md');
const RULE = createVaultPath('.atlas/automations/After a meeting.md');

// Newest first, as the log is shown.
const EVENTS: ActivityEvent[] = [
  {
    at: at(3),
    level: 'info',
    kind: 'automation',
    message: 'After a meeting: Ran by hand (2026-10-06 Standup).',
    subject: { kind: 'rule', path: RULE },
    notes: [MEETING],
  },
  { at: at(2), level: 'info', kind: 'sync', message: 'Pulled.', subject: null },
  {
    at: at(1),
    level: 'info',
    kind: 'meeting',
    message: 'linked Mara Quill.',
    subject: { kind: 'note', path: MEETING },
  },
  {
    at: at(0),
    level: 'info',
    kind: 'meeting',
    message: 'imported.',
    subject: { kind: 'note', path: MEETING },
  },
];

describe('activityEntries (#192)', () => {
  it('shows a meeting’s lines under it, with their ids, and the rest as lines', () => {
    const entries = activityEntries(EVENTS, TODAY);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      group: 'meeting',
      title: '2026-10-06 Standup',
      rows: [{ id: '3' }, { id: '1' }, { id: '0' }],
    });
    expect(entries[1]).toMatchObject({ id: '2', message: 'Pulled.' });
  });

  it('opens the meeting by its newest line about it, not by the rule’s line', () => {
    const [meeting] = activityEntries(EVENTS, TODAY);
    if (meeting === undefined || !('group' in meeting)) throw new Error('a meeting first');
    expect(meeting.id).toBe('1');
    expect(subjectOf(EVENTS, meeting.id)).toEqual({ kind: 'note', path: MEETING });
  });

  it('is a line for each event when no meeting has two', () => {
    const entries = activityEntries(EVENTS.slice(1, 3), TODAY);
    expect(entries.map((entry) => 'group' in entry)).toEqual([false, false]);
  });
});
