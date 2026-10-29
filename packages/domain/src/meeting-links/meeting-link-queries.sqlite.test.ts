import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  compileLinkDirectoryQuery,
  compileProjectTiesQuery,
  linkDirectoryOf,
  type LinkDirectoryRow,
} from './meeting-link-queries.ts';

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
    links: Record<string, string | string[]> = {},
  ) => {
    file.run(path, path.replace(/^.*\//, '').replace(/\.md$/, ''));
    for (const [key, value] of Object.entries(properties)) {
      (Array.isArray(value) ? value : [value]).forEach((item, at) => prop.run(path, key, at, item));
    }
    for (const [key, value] of Object.entries(links)) {
      (Array.isArray(value) ? value : [value]).forEach((dst, at) =>
        relation.run(path, key, at, dst),
      );
    }
  };
  const all = (sql: string, parameters: readonly (string | number)[]) =>
    database.prepare(sql).all(...parameters) as unknown[];
  return { note, all };
}

describe('the meeting-link directory, read from the index’s tables', () => {
  it('is every person and company with what they are matched by, archived ones too', () => {
    const { note, all } = index();
    note(
      'People/Mara Quill.md',
      {
        type: 'person',
        email: 'mara@larkspur.example',
        other_emails: ['mq@home.example'],
        aliases: 'Mara Quil',
        role: 'Lead',
      },
      { company: 'Companies/Larkspur Payroll.md' },
    );
    note('Archive/2025/Tobias Fenn.md', { type: ['contact', 'person'] });
    note(
      'Companies/Larkspur Payroll.md',
      {
        type: 'company',
        aliases: 'Larkspur',
        domains: ['larkspur.example'],
        site: 'https://larkspur.example',
      },
      { ceo: 'People/Mara Quill.md' },
    );
    note('Companies/Both.md', { type: ['company', 'person'], email: 'both@x.example' });
    note('.atlas/templates/person.md', { type: 'person', email: 'template@x.example' });
    note(
      'Tasks/Call.md',
      { type: 'task', email: 'not-a-person@x.example' },
      { company: 'Companies/Larkspur Payroll.md' },
    );

    const rows = all(compileLinkDirectoryQuery(0).sql, compileLinkDirectoryQuery(0).parameters);
    expect(linkDirectoryOf(rows as LinkDirectoryRow[])).toEqual({
      people: [
        {
          path: 'Archive/2025/Tobias Fenn.md',
          name: 'Tobias Fenn',
          emails: [],
          aliases: [],
          company: null,
        },
        {
          path: 'People/Mara Quill.md',
          name: 'Mara Quill',
          emails: ['mara@larkspur.example', 'mq@home.example'],
          aliases: ['Mara Quil'],
          company: 'Companies/Larkspur Payroll.md',
        },
      ],
      companies: [
        { path: 'Companies/Both.md', name: 'Both', aliases: [], domains: [] },
        {
          path: 'Companies/Larkspur Payroll.md',
          name: 'Larkspur Payroll',
          aliases: ['Larkspur'],
          domains: ['larkspur.example', 'https://larkspur.example'],
        },
      ],
    });
  });

  // Follow-up to #110: a type in any case, as FROM finds it.
  it('takes a person or company whose type is written in capitals or with spaces', () => {
    const { note, all } = index();
    note('People/Mara Quill.md', { type: 'Person' });
    note('Companies/Larkspur Payroll.md', { type: ' COMPANY ' });
    note('Notes/People.md', { type: 'persons' });
    const rows = all(compileLinkDirectoryQuery(0).sql, compileLinkDirectoryQuery(0).parameters);
    const directory = linkDirectoryOf(rows as LinkDirectoryRow[]);
    expect(directory.people.map((person) => person.path)).toEqual(['People/Mara Quill.md']);
    expect(directory.companies.map((company) => company.path)).toEqual([
      'Companies/Larkspur Payroll.md',
    ]);
  });

  it('pages: the second page starts where the first ended', () => {
    const { note, all } = index();
    note('People/Mara Quill.md', { type: 'person' });
    const second = compileLinkDirectoryQuery(1);
    expect(all(second.sql, second.parameters)).toEqual([]);
  });
});

describe('the projects tied to a meeting’s people and companies', () => {
  const MEETING = 'Inbox/Meetings/2026-10-06 Standup.md';
  const MARA = 'People/Mara Quill.md';
  const LARKSPUR = 'Companies/Larkspur Payroll.md';

  function vault() {
    const setup = index();
    setup.note('Projects/Ledger.md', { type: 'project', status: 'active' }, { owner: MARA });
    setup.note('Projects/Payrun.md', { type: 'project' });
    setup.note('Projects/Done.md', { type: 'project', status: 'Done' }, { owner: MARA });
    setup.note('Archive/Old.md', { type: 'project' }, { owner: MARA });
    setup.note('Projects/Elsewhere.md', { type: 'project' }, { owner: 'People/Nobody.md' });
    setup.note(LARKSPUR, { type: 'company' }, { projects: 'Projects/Payrun.md' });
    setup.note(
      'Meetings/Earlier.md',
      { type: 'meeting' },
      { project: 'Projects/Payrun.md', people: MARA },
    );
    setup.note(MEETING, { type: 'meeting' }, { project: 'Projects/Elsewhere.md', people: MARA });
    return setup;
  }

  it('ties an open project its own link, a person’s or company’s link, or another note naming both', () => {
    const { all } = vault();
    const { sql, parameters } = compileProjectTiesQuery({
      meeting: MEETING,
      entities: [MARA, LARKSPUR],
    });
    expect(all(sql, parameters)).toEqual([
      { project: 'Projects/Ledger.md', title: 'Ledger', entity: MARA },
      { project: 'Projects/Payrun.md', title: 'Payrun', entity: LARKSPUR },
      { project: 'Projects/Payrun.md', title: 'Payrun', entity: MARA },
    ]);
  });
});
