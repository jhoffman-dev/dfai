import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  compileVocabularyQuery,
  vocabularySourcesOf,
  type VocabularyRow,
} from './vocabulary-query.ts';
import { vocabulary } from './vocabulary.ts';

/*
 * Adversarial (P28-05): the vocabulary's notes against the index's own tables,
 * where the rest of DFAI already disagrees with them about what a note's type is.
 */

/** The index's `files` and `props`, as `apps/desktop/src-tauri/src/index.rs` creates them. */
function index() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE files (path TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
                        modified INTEGER, size INTEGER NOT NULL);
    CREATE TABLE props (path TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0,
                        value_text TEXT, value_num REAL, value_date TEXT, value_json TEXT);`);
  const file = database.prepare(
    'INSERT INTO files (path, title, modified, size) VALUES (?, ?, 1, 1)',
  );
  const prop = database.prepare(
    'INSERT INTO props (path, key, idx, value_text) VALUES (?, ?, ?, ?)',
  );
  const note = (path: string, title: string, properties: Record<string, string | string[]>) => {
    file.run(path, title);
    for (const [key, value] of Object.entries(properties)) {
      (Array.isArray(value) ? value : [value]).forEach((item, at) => prop.run(path, key, at, item));
    }
  };
  const run = () => {
    const { sql, parameters } = compileVocabularyQuery(0);
    return database.prepare(sql).all(...parameters) as unknown as VocabularyRow[];
  };
  return { note, run };
}

describe('a person whose note declares a second type first', () => {
  // `@` mentions (index.rs `notes_of_type`) and the Person type page (the query
  // language's EXISTS over every `type` item) both count `type: [contact, person]`
  // as a person. The vocabulary reads only the first item, so this person's
  // name is never left out.
  it('is still a person in the vocabulary, by name', () => {
    const { note, run } = index();
    note('People/Mara Quill.md', 'Mara Quill', {
      type: ['contact', 'person'],
      aliases: ['Mara Quil'],
    });
    note('People/Tobias Fenn.md', 'Tobias Fenn', { type: 'person' });

    const sources = vocabularySourcesOf(run());
    expect(sources.people.map((person) => person.name)).toEqual(['Mara Quill', 'Tobias Fenn']);
    expect(
      vocabulary(sources).entries.map((entry) => `${entry.form} → ${entry.canonical}`),
    ).toContain('Mara Quill → Mara Quill');
  });
});
