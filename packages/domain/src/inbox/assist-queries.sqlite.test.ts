import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { indexablePropertiesOf } from '../index/property-value.ts';
import { foldedPersonName } from '../people/person-match.ts';
import {
  ASSIST_TITLES_MAX,
  assistTaskCandidate,
  compileAssistTasksQuery,
  compileTitledNotesQuery,
  takenTitles,
} from './assist-queries.ts';

/**
 * #907: what Inbox assist reads on the press, run against the index as the
 * host makes it (`index_schema.sql`).
 */

const HOST_SCHEMA = readFileSync(
  new URL('../../../../apps/desktop/src-tauri/src/index_schema.sql', import.meta.url),
  'utf8',
);

function indexOf(notes: Readonly<Record<string, Readonly<Record<string, unknown>>>>) {
  const database = new DatabaseSync(':memory:');
  database.exec(HOST_SCHEMA);
  const file = database.prepare(
    'INSERT INTO files (path, title, modified, size) VALUES (?, ?, 0, 0)',
  );
  const prop = database.prepare(
    'INSERT INTO props (path, key, idx, value_text, value_num, value_date, value_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const [path, frontmatter] of Object.entries(notes)) {
    file.run(path, path.replace(/^.*\//u, '').replace(/\.md$/u, ''));
    for (const row of indexablePropertiesOf(frontmatter)) {
      prop.run(path, row.key, row.index, row.text, row.number, row.date, row.json);
    }
  }
  return database;
}

function candidates(notes: Readonly<Record<string, Readonly<Record<string, unknown>>>>) {
  const { sql, parameters } = compileAssistTasksQuery();
  const rows = indexOf(notes)
    .prepare(sql)
    .all(...(parameters as string[])) as Record<string, unknown>[];
  return rows.map(assistTaskCandidate);
}

describe('compileAssistTasksQuery', () => {
  it('reads every open task with what is written on it, in any form', () => {
    const [task, ...rest] = candidates({
      'Tasks/Renew.md': {
        type: 'task',
        status: 'next-action',
        due: 'next Friday',
        defer: '2026-12-01',
        recurrence: ['weekly', 'monthly'],
        waiting_on: '[[Mara Quill]]',
        contexts: ['@phone', '@desk'],
        people: ['[[Tobias Fenn]]'],
      },
      'Tasks/Done.md': { type: 'task', status: 'archive' },
      'Notes/Idea.md': { type: 'note' },
    });
    expect(rest).toEqual([]);
    expect(task).toMatchObject({
      path: 'Tasks/Renew.md',
      title: 'Renew',
      status: 'next-action',
      due: null,
      dueUnread: true,
      defer: '2026-12-01',
      recurrence: 'weekly\u001fmonthly',
      waitingOn: 'Mara Quill',
      contexts: ['@phone', '@desk'],
      people: ['Tobias Fenn'],
    });
  });

  it('reads a plain task as holding nothing', () => {
    expect(candidates({ 'Tasks/Call.md': { type: 'task', due: '2026-12-01' } })[0]).toMatchObject({
      due: '2026-12-01',
      dueUnread: false,
      defer: null,
      recurrence: null,
      waitingOn: '',
      contexts: [],
      people: [],
    });
  });
});

describe('compileTitledNotesQuery and takenTitles', () => {
  const titled = (stored: string[], names: string[]) => {
    const notes = Object.fromEntries(stored.map((title) => [`Notes/${title}.md`, {}]));
    const { sql, parameters } = compileTitledNotesQuery(names);
    const rows = indexOf(notes)
      .prepare(sql)
      .all(...(parameters as number[])) as { title: string }[];
    return takenTitles(
      names,
      rows.map((row) => row.title),
      { cut: false },
    );
  };

  it('finds a title the names fold to, however it is spelt, and none that differs', () => {
    const taken = titled(
      ['ÉLODIE FENN', 'Renée Quill', 'Tobias'],
      ['élodie fenn', 'Renee Quill', 'Tobias Fenn'],
    );
    expect([...taken]).toEqual([foldedPersonName('élodie fenn'), foldedPersonName('Renee Quill')]);
  });

  it('calls every name taken when the read was cut short', () => {
    expect(takenTitles(['Tobias Fenn'], [], { cut: true })).toEqual(new Set(['tobiasfenn']));
    const many = Array.from({ length: ASSIST_TITLES_MAX + 1 }, (_, at) => `Note ${at}`);
    expect(takenTitles(['Tobias Fenn'], many, { cut: false }).size).toBe(1);
  });
});
