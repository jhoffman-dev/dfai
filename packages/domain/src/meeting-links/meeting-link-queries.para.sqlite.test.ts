/**
 * The meeting-link step proposes "<project> is open and tied to …" in the
 * Inbox (#213). A project archived by its value stays where it is with
 * `para: archive`, and resources and areas are Project notes: the open
 * projects it ranks are the projects and areas in use, never a resource or
 * an archived one.
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { compileProjectTiesQuery } from './meeting-link-queries.ts';

function index() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE files (path TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
                        modified INTEGER, size INTEGER NOT NULL);
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
    properties: Record<string, string>,
    links: Record<string, string> = {},
  ) => {
    file.run(path, path.replace(/^.*\//, '').replace(/\.md$/, ''));
    for (const [key, value] of Object.entries(properties)) prop.run(path, key, 0, value);
    for (const [key, dst] of Object.entries(links)) relation.run(path, key, 0, dst);
  };
  const all = (sql: string, parameters: readonly (string | number)[]) =>
    database.prepare(sql).all(...parameters) as { project: string }[];
  return { note, all };
}

const MARA = 'People/Mara Quill.md';
const MEETING = 'Meetings/2026-10-01 Sync.md';

describe('compileProjectTiesQuery over PARA values (#213)', () => {
  it('proposes projects and areas, never a Project archived by its value nor a resource', () => {
    const { note, all } = index();
    note(MARA, { type: 'person' });
    note(MEETING, { type: 'meeting' });
    note('Projects/Ledger.md', { type: 'project', status: 'active' }, { owner: MARA });
    note(
      'Projects/Old Payrun.md',
      { type: 'project', status: 'active', para: 'archive' },
      { owner: MARA },
    );
    note('Resources/Style Guide.md', { type: 'project', para: 'resource' }, { owner: MARA });
    note('Areas/Garden.md', { type: 'project', para: 'Area' }, { owner: MARA });
    note('Projects/Payrun.md', { type: 'project', para: ' project ' }, { owner: MARA });
    note('Projects/Someday.md', { type: 'project', para: 'Life admin' }, { owner: MARA });

    const { sql, parameters } = compileProjectTiesQuery({ meeting: MEETING, entities: [MARA] });
    expect(all(sql, parameters).map((row) => row.project)).toEqual([
      'Areas/Garden.md',
      'Projects/Ledger.md',
      'Projects/Payrun.md',
      'Projects/Someday.md',
    ]);
  });
});
