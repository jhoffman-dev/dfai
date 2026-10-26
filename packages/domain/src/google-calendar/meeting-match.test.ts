import { describe, expect, it } from 'vitest';
import { createVaultPath } from '../vault/vault-path.ts';
import { matchMeetingNote, startlessShared, type MeetingCandidate } from './index.ts';

const note = (overrides: Partial<MeetingCandidate> = {}): MeetingCandidate => ({
  path: createVaultPath('Inbox/Meetings/2026-10-24 Payroll sync.md'),
  title: 'Payroll sync',
  date: '2026-10-24',
  start: '09:30',
  ...overrides,
});

const event = { title: 'Payroll sync', start: '2026-10-24T09:30' };

describe('matchMeetingNote', () => {
  it('finds the note written up for the event: its day, its title, near its start', () => {
    expect(matchMeetingNote(event, [note()])).toBe('Inbox/Meetings/2026-10-24 Payroll sync.md');
  });

  it('compares titles the way the Terms page compares spellings', () => {
    expect(matchMeetingNote({ ...event, title: '  payroll   SYNC ' }, [note()])).not.toBeNull();
  });

  it('matches a title carrying an invisible direction mark to the same title without one', () => {
    expect(matchMeetingNote({ ...event, title: 'Payroll sync\u200F' }, [note()])).not.toBeNull();
    expect(matchMeetingNote(event, [note({ title: '\u2067Payroll sync\u2069' })])).not.toBeNull();
  });

  it('allows a notetaker’s start to be some minutes off, and no more', () => {
    expect(matchMeetingNote(event, [note({ start: '09:50' })])).not.toBeNull();
    expect(matchMeetingNote(event, [note({ start: '09:51' })])).toBeNull();
    expect(matchMeetingNote(event, [note({ start: '09:09' })])).toBeNull();
  });

  it('matches a note that gives no start on its day and title alone', () => {
    expect(matchMeetingNote(event, [note({ start: null })])).not.toBeNull();
  });

  it('never matches another day, another title, or a start it cannot read', () => {
    expect(matchMeetingNote(event, [note({ date: '2026-10-23' })])).toBeNull();
    expect(matchMeetingNote(event, [note({ title: 'Payroll sync prep' })])).toBeNull();
    expect(matchMeetingNote(event, [note({ start: 'morning' })])).toBeNull();
  });

  it('guesses nothing when two notes fit', () => {
    const second = note({ path: createVaultPath('Inbox/Meetings/Payroll sync 2.md') });
    expect(matchMeetingNote(event, [note(), second])).toBeNull();
  });

  it('never matches an all-day event or an untitled one', () => {
    expect(matchMeetingNote({ ...event, start: '2026-10-24' }, [note({ start: null })])).toBeNull();
    expect(matchMeetingNote({ ...event, title: '  ' }, [note({ title: '' })])).toBeNull();
  });
});

describe('startlessShared', () => {
  const morning = { title: 'Payroll sync', start: '2026-10-24T09:30' };
  const afternoon = { title: 'payroll  SYNC', start: '2026-10-24T15:00' };

  it('names a note with no start that fits two meetings of its day under its title', () => {
    const startless = note({ start: null });
    expect([...startlessShared([morning, afternoon], [startless])]).toEqual([startless.path]);
  });

  it('leaves a note with a start, one that fits a single meeting, and one of another day', () => {
    const timed = note();
    const other = note({
      path: createVaultPath('Inbox/Meetings/Other.md'),
      start: null,
      date: '2026-10-25',
    });
    expect(startlessShared([morning, afternoon], [timed, other]).size).toBe(0);
    expect(startlessShared([morning], [note({ start: null })]).size).toBe(0);
  });
});
