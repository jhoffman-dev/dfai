import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  compileImportOutcomesQuery,
  compileMeetingHoldersQuery,
  compileMeetingListQuery,
  IMPORT_OUTCOMES_PAGE,
  importOutcomesOf,
} from './meeting-queries.ts';

/**
 * The meeting statements run for real against SQLite, over the index's own
 * `files` and `props` tables: what is asserted is the rows, not the text.
 */
function meetingIndex(notes: readonly { path: string; props: Record<string, string> }[]) {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE files (path TEXT PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE props (path TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0,
      value_text TEXT, value_num REAL, value_date TEXT, value_json TEXT);
  `);
  const file = database.prepare('INSERT INTO files VALUES (?, ?)');
  const prop = database.prepare(
    'INSERT INTO props (path, key, idx, value_text, value_date) VALUES (?, ?, 0, ?, ?)',
  );
  for (const note of notes) {
    file.run(note.path, note.path.replace(/^.*\//, '').replace(/\.md$/, ''));
    for (const [key, value] of Object.entries(note.props)) {
      // A day is indexed as a date as well as text, as the index does.
      prop.run(note.path, key, value, /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null);
    }
  }
  const run = ({ sql, parameters }: { sql: string; parameters: readonly (string | number)[] }) =>
    database.prepare(sql).all(...parameters);
  return {
    outcomes: () =>
      importOutcomesOf(run(compileImportOutcomesQuery()).map((row) => Object.values(row))),
    outcomePage: (page: number) => run(compileImportOutcomesQuery(page)).map((row) => row['path']),
    holders: (provider: string, externalId: string) =>
      run(compileMeetingHoldersQuery({ provider, externalId })).map((row) => row['path']),
    list: (
      options: Partial<Parameters<typeof compileMeetingListQuery>[0]> = {},
    ): Record<string, unknown>[] =>
      run(
        compileMeetingListQuery({
          since: null,
          includeArchived: false,
          limit: 50,
          offset: 0,
          ...options,
        }),
      ),
  };
}

const meeting = (externalId: string, more: Record<string, string> = {}) => ({
  type: 'meeting',
  provider: 'gemini',
  external_id: externalId,
  ...more,
});

const vault = meetingIndex([
  { path: 'Inbox/Meetings/Standup.md', props: meeting('g-1', { date: '2026-10-06' }) },
  { path: 'Projects/Larkspur/Standup.md', props: meeting('g-1', { date: '2026-10-06' }) },
  {
    path: 'Archive/Inbox/Meetings/Standup 2.md',
    props: meeting('g-1', { date: '2026-10-06', atlas_duplicate_of: '[[Standup]]' }),
  },
  {
    path: 'Inbox/Meetings/Broken.md',
    props: meeting('g-1', { date: '2026-10-07', atlas_import_error: 'title is required' }),
  },
  { path: 'Inbox/Meetings/Other provider.md', props: meeting('g-1', { provider: 'granola' }) },
  { path: 'Notes/Not a meeting.md', props: { provider: 'gemini', external_id: 'g-1' } },
  {
    path: 'Archive/Projects/Retro.md',
    props: meeting('g-2', { date: '2026-09-01', start: '09:00' }),
  },
  { path: 'Inbox/Meetings/Retro copy.md', props: meeting('g-2', { date: '2026-09-01' }) },
  {
    path: 'Inbox/Meetings/No type.md',
    props: { atlas_import_error: 'type is required' },
  },
  {
    path: 'Inbox/Meetings/Early call.md',
    props: meeting('g-4', { date: '2026-10-06', start: '08:00' }),
  },
  {
    path: 'Inbox/Meetings/Planning.md',
    props: meeting('g-3', {
      date: '2026-10-06',
      start: '14:00',
      title: 'Q4: planning',
      atlas_import_outcome: 'imported',
    }),
  },
]);

describe('compileImportOutcomesQuery (#92)', () => {
  it('says how the import settled each note that holds a stamp, and of no other', () => {
    const stamped = meetingIndex([
      { path: 'Inbox/Meetings/In.md', props: meeting('g-1', { atlas_import_outcome: 'imported' }) },
      { path: 'Inbox/Meetings/Bad.md', props: meeting('g-2', { atlas_import_outcome: 'error' }) },
      { path: 'Inbox/Meetings/Odd.md', props: meeting('g-3', { atlas_import_outcome: 'maybe' }) },
      { path: 'Inbox/Meetings/Waiting.md', props: meeting('g-4') },
    ]);
    expect(stamped.outcomes()).toEqual(
      new Map([
        ['Inbox/Meetings/Bad.md', 'error'],
        ['Inbox/Meetings/In.md', 'imported'],
        // A stamp the import does not know is a stamp all the same, read as it reads one.
        ['Inbox/Meetings/Odd.md', 'imported'],
      ]),
    );
  });
});

describe('compileMeetingHoldersQuery', () => {
  it('finds the meetings holding a provider and external id, archived and marked ones too', () => {
    expect(vault.holders('gemini', 'g-1')).toEqual([
      'Archive/Inbox/Meetings/Standup 2.md',
      'Inbox/Meetings/Broken.md',
      'Inbox/Meetings/Standup.md',
      'Projects/Larkspur/Standup.md',
    ]);
    expect(vault.holders('gemini', 'g-2')).toEqual([
      'Archive/Projects/Retro.md',
      'Inbox/Meetings/Retro copy.md',
    ]);
  });

  it('matches an id whatever spaces are around it, on either side', () => {
    const spaced = meetingIndex([
      { path: 'Inbox/Meetings/A.md', props: meeting(' g-9  ') },
      { path: 'Inbox/Meetings/B.md', props: meeting('g-9') },
    ]);
    expect(spaced.holders('gemini', 'g-9 ')).toEqual([
      'Inbox/Meetings/A.md',
      'Inbox/Meetings/B.md',
    ]);
  });

  // Follow-up to #110: a type in any case, as FROM meeting finds it.
  it('finds a meeting whose type is written in capitals or with spaces', () => {
    const spelt = meetingIndex([
      { path: 'Inbox/Meetings/A.md', props: meeting('g-7', { type: 'Meeting' }) },
      { path: 'Inbox/Meetings/B.md', props: meeting('g-7', { type: ' MEETING ' }) },
      { path: 'Inbox/Meetings/C.md', props: meeting('g-7', { type: 'meetings' }) },
    ]);
    expect(spelt.holders('gemini', 'g-7')).toEqual(['Inbox/Meetings/A.md', 'Inbox/Meetings/B.md']);
  });

  it('leaves out another provider, another id, and notes of no meeting type', () => {
    expect(vault.holders('gemini', 'g-1')).not.toContain('Notes/Not a meeting.md');
    expect(vault.holders('granola', 'g-1')).toEqual(['Inbox/Meetings/Other provider.md']);
    expect(vault.holders('gemini', 'nobody')).toEqual([]);
  });
});

describe('compileMeetingListQuery', () => {
  it('lists meetings and files failing import, newest first by day then start, archived left out', () => {
    expect(vault.list().map((row) => row['path'])).toEqual([
      'Inbox/Meetings/Broken.md',
      'Inbox/Meetings/Planning.md',
      'Inbox/Meetings/Early call.md',
      'Inbox/Meetings/Standup.md',
      'Projects/Larkspur/Standup.md',
      'Inbox/Meetings/Retro copy.md',
      'Inbox/Meetings/No type.md',
      'Inbox/Meetings/Other provider.md',
    ]);
  });

  it('reads each meeting as the contract wrote it, its own title over the file name', () => {
    const [planning] = vault.list({ since: '2026-10-06' }).filter((row) => {
      return row['path'] === 'Inbox/Meetings/Planning.md';
    });
    expect(planning).toEqual({
      path: 'Inbox/Meetings/Planning.md',
      title: 'Q4: planning',
      date: '2026-10-06',
      start: '14:00',
      end: null,
      kind: null,
      provider: 'gemini',
      external_id: 'g-3',
      atlas_import_outcome: 'imported',
      atlas_import_error: null,
      atlas_duplicate_of: null,
      stamped: 1,
      declared: 0,
    });
    const broken = vault.list().find((row) => row['path'] === 'Inbox/Meetings/Broken.md');
    expect(broken?.['atlas_import_error']).toBe('title is required');
    expect(broken?.['stamped']).toBe(0);
  });

  it('keeps meetings on or after `since`, and none without a day', () => {
    expect(vault.list({ since: '2026-10-07' }).map((row) => row['path'])).toEqual([
      'Inbox/Meetings/Broken.md',
    ]);
    expect(vault.list({ since: '2026-10-06' }).map((row) => row['path'])).toEqual([
      'Inbox/Meetings/Broken.md',
      'Inbox/Meetings/Planning.md',
      'Inbox/Meetings/Early call.md',
      'Inbox/Meetings/Standup.md',
      'Projects/Larkspur/Standup.md',
    ]);
  });

  it('lists archived meetings, duplicates among them, when asked', () => {
    const paths = vault.list({ includeArchived: true }).map((row) => row['path']);
    expect(paths).toContain('Archive/Inbox/Meetings/Standup 2.md');
    expect(paths).toContain('Archive/Projects/Retro.md');
    const copy = vault
      .list({ includeArchived: true })
      .find((row) => row['path'] === 'Archive/Inbox/Meetings/Standup 2.md');
    expect(copy?.['atlas_duplicate_of']).toBe('[[Standup]]');
  });

  it('pages by limit and offset without reshuffling', () => {
    const all = vault.list().map((row) => row['path']);
    const first = vault.list({ limit: 3 }).map((row) => row['path']);
    const rest = vault.list({ limit: 50, offset: 3 }).map((row) => row['path']);
    expect([...first, ...rest]).toEqual(all);
    expect(first).toHaveLength(3);
  });
});

describe('compileImportOutcomesQuery: where it looks, and how much at a time (#92 review)', () => {
  const stamp = { atlas_import_outcome: 'imported' };

  it('asks only of notes where meeting files land, so stamps kept elsewhere cost nothing', () => {
    const index = meetingIndex([
      { path: 'Inbox/Meetings/In.md', props: stamp },
      { path: 'inbox/meetings/Lower.md', props: stamp },
      { path: 'Projects/Elsewhere.md', props: stamp },
      { path: 'Archive/Inbox/Meetings/Old.md', props: stamp },
    ]);
    expect([...index.outcomes().keys()]).toEqual([
      'Inbox/Meetings/In.md',
      'inbox/meetings/Lower.md',
    ]);
  });

  it('pages: a page holds at most the page size, and the next picks up after it', () => {
    const notes = Array.from({ length: IMPORT_OUTCOMES_PAGE + 3 }, (_, n) => ({
      path: `Inbox/Meetings/${String(n).padStart(5, '0')}.md`,
      props: stamp,
    }));
    const index = meetingIndex(notes);
    expect(index.outcomePage(0)).toHaveLength(IMPORT_OUTCOMES_PAGE);
    expect(index.outcomePage(1)).toEqual(notes.slice(IMPORT_OUTCOMES_PAGE).map((n) => n.path));
  });
});
