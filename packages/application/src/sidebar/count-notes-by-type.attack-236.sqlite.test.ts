import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { ObjectType } from '@dfai/domain';
import type { QueryResult } from '../index/ports.ts';
import { notesInUseOfType } from '../archive/notes-in-use.ts';
import { fakeIndexPort } from '../testing/fake-ports.ts';
import { countNotesByType } from './count-notes-by-type.ts';

/**
 * Adversarial pass on #236: the sidebar's type counts, now one SQL statement,
 * against the per-type counting they replaced (`notesInUseOfType`, still the
 * rule for what a relation offers). Both run over the same real SQLite tables
 * the index keeps, `notesOfType` answered as the Rust index answers it.
 */
type Frontmatter = Readonly<Record<string, string | readonly string[]>>;

function indexOver(notes: Readonly<Record<string, Frontmatter>>) {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE files (path TEXT PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE props (path TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0,
      value_text TEXT, value_num REAL, value_date TEXT, value_json TEXT);
  `);
  const file = database.prepare('INSERT INTO files VALUES (?, ?)');
  const prop = database.prepare(
    'INSERT INTO props (path, key, idx, value_text) VALUES (?, ?, ?, ?)',
  );
  for (const [path, frontmatter] of Object.entries(notes)) {
    file.run(path, path);
    for (const [key, value] of Object.entries(frontmatter)) {
      (typeof value === 'string' ? [value] : value).forEach((each, at) =>
        prop.run(path, key, at, each),
      );
    }
  }
  return fakeIndexPort({
    // As `notes_of_type` in src-tauri/src/index.rs.
    notesOfType: async (type) =>
      database
        .prepare(
          `SELECT files.path, files.title FROM files
           WHERE files.path IN (SELECT path FROM props
                                WHERE key = 'type' AND lower(trim(value_text)) = lower(trim(?)))
           ORDER BY files.title`,
        )
        .all(type) as { path: string; title: string }[],
    query: async (sql, parameters = []): Promise<QueryResult> => {
      const statement = database.prepare(sql);
      const columns = statement.columns().map((column) => column.name);
      const rows = (statement.all(...(parameters as never[])) as Record<string, unknown>[]).map(
        (row) => columns.map((column) => row[column]),
      );
      return { columns, rows, truncated: false };
    },
  });
}

const type = (name: string): ObjectType => ({ name, label: name, properties: [] });

/** The counts as the sidebar drew them before #236: one `notesInUseOfType` per type. */
async function countedTheOldWay(index: ReturnType<typeof indexOver>, names: readonly string[]) {
  return new Map(
    await Promise.all(
      names.map(
        async (name) => [name, (await notesInUseOfType({ index, type: name })).length] as const,
      ),
    ),
  );
}

describe('countNotesByType against the per-type counting it replaced', () => {
  it('counts a Project whose para lists archive after another value as the relation picker does', async () => {
    const index = indexOver({
      'Projects/Garden.md': { type: 'project', para: ['project', 'archive'] },
      'Projects/Shed.md': { type: 'project', para: 'archive' },
      'Projects/DFAI.md': { type: 'project' },
    });
    const names = ['project'];

    expect(await countNotesByType({ index, types: names.map(type) })).toEqual(
      await countedTheOldWay(index, names),
    );
  });

  it('agrees on a generated vault of single-valued notes in every place a note can be', async () => {
    let state = 236;
    const random = () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
    const pick = <T>(of: readonly T[]): T => of[Math.floor(random() * of.length)]!;
    const folders = [
      '',
      'Tasks/',
      '.atlas/types/',
      'Archive/',
      'archive/Old/',
      'Projects/',
      '.atlasish/',
    ];
    const typeNames = ['task', 'project', 'Project', 'person', "O'Brien", 'x) OR 1=1 --'];
    const paras = [undefined, 'project', 'area', 'Archive ', 'archive', 'resource'];
    const notes: Record<string, Frontmatter> = {};
    for (let at = 0; at < 400; at += 1) {
      const frontmatter: Record<string, string> = {};
      const typed = pick([...typeNames, undefined]);
      if (typed !== undefined) frontmatter['type'] = typed;
      const para = pick(paras);
      if (para !== undefined) frontmatter['para'] = para;
      notes[`${pick(folders)}n${at}.md`] = frontmatter;
    }
    const index = indexOver(notes);

    expect(await countNotesByType({ index, types: typeNames.map(type) })).toEqual(
      await countedTheOldWay(index, typeNames),
    );
  });
});
