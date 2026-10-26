import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  compileDayEventsQuery,
  compileEventNotesQuery,
  compileMeetingCandidatesQuery,
  dayMeetings,
  meetingCandidatesOf,
  type DayEventRow,
} from './index.ts';

/** The index's `files`, `props` and `relations`, as `apps/desktop/src-tauri/src/index.rs` creates them. */
function index() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE files (path TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
                        modified INTEGER NOT NULL, size INTEGER NOT NULL);
    CREATE TABLE props (path TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0,
                        value_text TEXT, value_num REAL, value_date TEXT, value_json TEXT);
    CREATE TABLE relations (src TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL,
                            target TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', dst TEXT);`);
  const file = database.prepare(
    'INSERT INTO files (path, title, modified, size) VALUES (?, ?, 1, 1)',
  );
  const prop = database.prepare(
    'INSERT INTO props (path, key, idx, value_text) VALUES (?, ?, ?, ?)',
  );
  const relation = database.prepare(
    "INSERT INTO relations (src, key, idx, target, dst) VALUES (?, ?, ?, '', ?)",
  );
  const note = (
    path: string,
    properties: Record<string, string | string[]>,
    links: Record<string, string | null> = {},
  ) => {
    file.run(path, path.replace(/^.*\//, '').replace(/\.md$/, ''));
    for (const [key, value] of Object.entries(properties)) {
      (Array.isArray(value) ? value : [value]).forEach((item, at) => prop.run(path, key, at, item));
    }
    Object.entries(links).forEach(([key, dst], at) => relation.run(path, key, at, dst));
  };
  const all = (query: { sql: string; parameters: readonly (string | number | null)[] }) =>
    database.prepare(query.sql).all(...(query.parameters as (string | number | null)[])) as Record<
      string,
      unknown
    >[];
  return { note, all };
}

describe('compileEventNotesQuery', () => {
  it('finds event notes by the ids Google answered with and by the window’s days', () => {
    const { note, all } = index();
    note('Calendar/Moved away.md', { date: '2026-12-01T09:00', gcal_event_id: 'ev-1' });
    note('Calendar/In window.md', { date: '2026-10-25T09:00', gcal_event_id: 'ev-2' });
    note('Calendar/Old.md', { date: '2026-09-01T09:00', gcal_event_id: 'ev-3' });
    note('Notes/Not from Google.md', { date: '2026-10-25T09:00' });
    note('.atlas/hidden.md', { date: '2026-10-25T09:00', gcal_event_id: 'ev-4' });
    const rows = all(
      compileEventNotesQuery({ ids: ['ev-1'], fromDay: '2026-10-23', toDay: '2026-10-30' }),
    );
    expect(rows.map((row) => row['path'])).toEqual([
      'Calendar/In window.md',
      'Calendar/Moved away.md',
    ]);
  });

  it('reads the window alone when Google answered with nothing', () => {
    const { note, all } = index();
    note('Calendar/In window.md', { date: '2026-10-30', gcal_event_id: 'ev-2' });
    const rows = all(
      compileEventNotesQuery({ ids: [], fromDay: '2026-10-23', toDay: '2026-10-30' }),
    );
    expect(rows.map((row) => row['path'])).toEqual(['Calendar/In window.md']);
  });
});

describe('compileMeetingCandidatesQuery', () => {
  it('reads the meeting notes on the window’s days with their start', () => {
    const { note, all } = index();
    note('Inbox/Meetings/Standup.md', { type: 'meeting', date: '2026-10-24', start: '09:00' });
    note('Inbox/Meetings/No start.md', { type: 'meeting', date: '2026-10-24' });
    note('Inbox/Meetings/Long ago.md', { type: 'meeting', date: '2026-01-02', start: '09:00' });
    note('Calendar/Standup.md', { type: 'event', date: '2026-10-24T09:00' });
    const rows = all(compileMeetingCandidatesQuery({ fromDay: '2026-10-23', toDay: '2026-10-30' }));
    expect(meetingCandidatesOf(rows as never)).toEqual([
      { path: 'Inbox/Meetings/No start.md', title: 'No start', date: '2026-10-24', start: null },
      { path: 'Inbox/Meetings/Standup.md', title: 'Standup', date: '2026-10-24', start: '09:00' },
    ]);
  });
});

describe('compileDayEventsQuery', () => {
  it('reads the day’s event notes with their links resolved, and no other note', () => {
    const { note, all } = index();
    note(
      'Calendar/Standup.md',
      {
        date: '2026-10-24T09:00',
        ends: '2026-10-24T09:15',
        gcal_event_id: 'ev-1',
        gcal_response: 'accepted',
      },
      { people: 'People/Mara Quill.md', companies: null, meeting: 'Inbox/Meetings/Standup.md' },
    );
    note('Calendar/Tomorrow.md', { date: '2026-10-25T09:00', gcal_event_id: 'ev-2' });
    note('Notes/Hand made.md', { date: '2026-10-24T10:00' });
    const rows = all(compileDayEventsQuery('2026-10-24')) as unknown as DayEventRow[];
    expect([...new Set(rows.map((row) => row.path))]).toEqual(['Calendar/Standup.md']);
    expect(dayMeetings(rows, '2026-10-24')).toEqual([
      {
        path: 'Calendar/Standup.md',
        title: 'Standup',
        start: '09:00',
        end: '09:15',
        people: ['People/Mara Quill.md'],
        companies: [],
        meeting: 'Inbox/Meetings/Standup.md',
        unanswered: false,
      },
    ]);
  });

  it('keeps an event note retyped by hand, and leaves out a brief and a block carrying an event’s keys', () => {
    const { note, all } = index();
    const keys = { date: '2026-10-24T09:00', gcal_event_id: 'ev-1', gcal_response: 'accepted' };
    // `type` is the person's key (ADR-0046): an event note retyped is still the event's note.
    note('Calendar/Standup.md', { ...keys, type: 'meeting' });
    note('Calendar/Review.md', { ...keys, gcal_event_id: 'ev-2', type: 'Event' });
    note('Calendar/Retro.md', { ...keys, gcal_event_id: 'ev-3', type: ['event'] });
    // A brief that copied an event's keys still carries its period stamps: never a meeting.
    note('Inbox/Briefs/2026-10-24/09.00 Standup.md', {
      ...keys,
      atlas_period: '2026-10-24T07:00:00',
      atlas_period_item: 'gcal:ev-1',
      atlas_period_rule: 'Morning brief',
    });
    note('Notes/Stamped only.md', {
      ...keys,
      gcal_event_id: 'ev-4',
      atlas_period_item: 'gcal:ev-4',
    });
    // A time block a calendar sync wrote carries the event's id, in any case of its type.
    note('Blocks/Focus.md', { ...keys, gcal_event_id: 'ev-5', type: ' Block ' });
    note('Blocks/Deep work.md', { ...keys, gcal_event_id: 'ev-6', type: ['note', 'block'] });
    const rows = all(compileDayEventsQuery('2026-10-24')) as unknown as DayEventRow[];
    expect([...new Set(rows.map((row) => row.path))].sort()).toEqual([
      'Calendar/Retro.md',
      'Calendar/Review.md',
      'Calendar/Standup.md',
    ]);
  });
});
