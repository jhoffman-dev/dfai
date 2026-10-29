/**
 * The series rule reads every meeting from the index (#227): its title, day,
 * start and provider, whether its `project` holds anything, and what the
 * note it links is — so a closed, archived or resource project never votes —
 * then who was at the meetings that share a title or a day with the one asked
 * about. These run the statements against SQLite, as the host does.
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  compileSeriesMeetingsQuery,
  compileSeriesParticipantsQuery,
  meetingsOnRecord,
  seriesNeighbours,
  type SeriesMeetingRow,
  type SeriesParticipantRow,
} from './meeting-series-queries.ts';
import { createVaultPath } from '../vault/vault-path.ts';

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
    'INSERT INTO props (path, key, idx, value_text, value_json) VALUES (?, ?, ?, ?, ?)',
  );
  const relation = database.prepare(
    "INSERT INTO relations (src, key, idx, target, dst) VALUES (?, ?, ?, '', ?)",
  );
  const note = (
    path: string,
    properties: Record<string, string>,
    links: Record<string, (string | null)[]> = {},
  ) => {
    file.run(path, path.replace(/^.*\//, '').replace(/\.md$/, ''));
    for (const [key, value] of Object.entries(properties)) prop.run(path, key, 0, value, null);
    for (const [key, dsts] of Object.entries(links)) {
      dsts.forEach((dst, at) => {
        relation.run(path, key, at, dst);
        prop.run(path, key, at, `[[${dst ?? 'Nowhere'}]]`, null);
      });
    }
  };
  const attendee = (path: string, at: number, entry: Record<string, string>) =>
    prop.run(path, 'attendees', at, null, JSON.stringify(entry));
  const all = (sql: string, parameters: readonly (string | number)[]) =>
    database.prepare(sql).all(...parameters) as Record<string, unknown>[];
  return { note, attendee, all };
}

const meetingRows = (rows: Record<string, unknown>[]): SeriesMeetingRow[] =>
  rows.map((row) => ({
    path: String(row['path']),
    title: String(row['title']),
    date: row['date'] as string | null,
    start: row['start'] as string | null,
    provider: row['provider'] as string | null,
    filed: Number(row['filed']) === 1,
    project: row['project'] as string | null,
    projectTitle: row['project_title'] as string | null,
    projectType: row['project_type'] as string | null,
    projectPara: row['project_para'] as string | null,
    projectStatus: row['project_status'] as string | null,
  }));

const MEETING = { type: 'meeting', title: 'Larkspur Standup', provider: 'gemini' };
const OWNER = {
  selfName: 'Mara Quill',
  names: ['Mara Quill'],
  selfEmails: [],
  notes: [createVaultPath('People/Mara Quill.md')],
};

describe('compileSeriesMeetingsQuery', () => {
  it('reads each meeting with its first project link and what that note is', () => {
    const { note, all } = index();
    note('Projects/Ledger.md', { type: 'project', status: 'active' });
    note('Projects/Old.md', { type: 'project', para: 'archive' });
    note(
      'Meetings/a.md',
      { ...MEETING, date: '2026-10-01', start: '09:30' },
      {
        project: ['Projects/Ledger.md', 'Projects/Old.md'],
      },
    );
    note('Meetings/b.md', { ...MEETING, date: '2026-10-02' }, { project: ['Projects/Old.md'] });
    note('Meetings/c.md', { ...MEETING, date: '2026-10-03', title: 'Retitled' });
    note('Meetings/d.md', { ...MEETING, date: '2026-10-04' }, { project: [null] });
    note('Projects/Not a meeting.md', { type: 'project' });

    const { sql, parameters } = compileSeriesMeetingsQuery(0);
    const rows = meetingRows(all(sql, parameters));
    expect(
      rows.map((row) => [row.path, row.title, row.filed, row.project, row.projectPara]),
    ).toEqual([
      ['Meetings/a.md', 'Larkspur Standup', true, 'Projects/Ledger.md', null],
      ['Meetings/b.md', 'Larkspur Standup', true, 'Projects/Old.md', 'archive'],
      ['Meetings/c.md', 'Retitled', false, null, null],
      ['Meetings/d.md', 'Larkspur Standup', true, null, null],
    ]);
    expect(rows[0]).toMatchObject({ start: '09:30', provider: 'gemini', projectStatus: 'active' });
  });

  // Follow-up to #110: a type in any case, as FROM finds it.
  it('reads a meeting whose type is written in capitals or with spaces', () => {
    const { note, all } = index();
    note('Meetings/a.md', { ...MEETING, type: 'Meeting', date: '2026-10-01' });
    note('Meetings/b.md', { ...MEETING, type: ' MEETING ', date: '2026-10-02' });
    note('Meetings/c.md', { ...MEETING, type: 'meetings', date: '2026-10-03' });
    const { sql, parameters } = compileSeriesMeetingsQuery(0);
    expect(meetingRows(all(sql, parameters)).map((row) => row.path)).toEqual([
      'Meetings/a.md',
      'Meetings/b.md',
    ]);
  });

  it('pages: a page past the last is empty', () => {
    const { note, all } = index();
    note('Meetings/a.md', { ...MEETING, date: '2026-10-01' });
    const { sql, parameters } = compileSeriesMeetingsQuery(1);
    expect(all(sql, parameters)).toEqual([]);
  });
});

describe('compileSeriesParticipantsQuery and meetingsOnRecord', () => {
  it('reads who was at the meetings asked about, and only an open project votes', () => {
    const { note, attendee, all } = index();
    note('Projects/Ledger.md', { type: 'project' });
    note('Resources/Guide.md', { type: 'project', para: 'resource' });
    note('Projects/Done.md', { type: 'project', status: 'done' });
    note(
      'Meetings/a.md',
      { ...MEETING, date: '2026-10-01' },
      {
        project: ['Projects/Ledger.md'],
        people: ['People/Mara Quill.md', 'People/Tobias Fenn.md'],
      },
    );
    note('Meetings/b.md', { ...MEETING, date: '2026-10-02' }, { project: ['Resources/Guide.md'] });
    note('Meetings/c.md', { ...MEETING, date: '2026-10-03' }, { project: ['Projects/Done.md'] });
    note('Meetings/elsewhere.md', { ...MEETING, date: '2026-10-04' });
    attendee('Meetings/a.md', 0, { name: 'Mara Quill', email: 'mara@larkspur.example' });
    attendee('Meetings/a.md', 1, { name: 'Ada Venn', email: 'Ada@Larkspur.example' });
    attendee('Meetings/b.md', 0, { name: 'Ada Venn' });

    const rows = meetingRows(all(...queryOf(compileSeriesMeetingsQuery(0))));
    const asked = ['Meetings/a.md', 'Meetings/b.md', 'Meetings/c.md'];
    const participants = all(
      ...queryOf(compileSeriesParticipantsQuery({ paths: asked, page: 0 })),
    ) as unknown as SeriesParticipantRow[];
    expect(participants.map((row) => row.path)).not.toContain('Meetings/elsewhere.md');

    const meetings = meetingsOnRecord({ meetings: rows, participants, owner: OWNER });
    const byPath = new Map(meetings.map((meeting) => [meeting.path, meeting]));
    expect(byPath.get(createVaultPath('Meetings/a.md'))).toMatchObject({
      project: { path: 'Projects/Ledger.md', title: 'Ledger' },
      participants: ['email:ada@larkspur.example', 'note:people/tobias fenn.md'],
      filed: true,
    });
    expect(byPath.get(createVaultPath('Meetings/b.md'))).toMatchObject({
      project: null,
      participants: ['name:ada venn'],
      filed: true,
    });
    expect(byPath.get(createVaultPath('Meetings/c.md'))?.project).toBeNull();
  });
});

describe('seriesNeighbours', () => {
  it('keeps the meetings sharing a title, in any spelling, or a day with a target', () => {
    const row = (path: string, title: string, date: string | null) => ({ path, title, date });
    const rows = [
      row('a', 'Larkspur standup!', '2026-09-01'),
      row('b', 'Other', '2026-10-01'),
      row('c', 'Other', '2026-10-02'),
      row('d', '', null),
    ];
    expect(
      seriesNeighbours(rows, [{ title: 'Larkspur Standup', date: '2026-10-01' }]).map(
        (each) => each.path,
      ),
    ).toEqual(['a', 'b']);
  });
});

function queryOf({ sql, parameters }: { sql: string; parameters: readonly (string | number)[] }) {
  return [sql, parameters] as const;
}
