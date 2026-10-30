import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { correlatedReads } from '../testing/query-plan.ts';
import { compileFollowUpsQuery } from './assistant-queries.ts';

/**
 * Attack on PR #616: the assistant's follow-ups ask, for each followed task,
 * whether it names a Person other than the one asked about (`other`). That
 * subquery is correlated, and is not keyed by the task's path: it starts from
 * the Person notes. On main it sought them by `props_key (key, value_text)`;
 * folded with lower(trim(value_text)) it can seek by `key` alone, so for each
 * task it walks every note's type row in the vault.
 */

const ENTITY = 'People/Mara Quill.md';
const MEETING = 'Meetings/Weekly sync.md';

/**
 * `others` notes of no interest, `people` people, and `tasks` follow-ups
 * reached through a meeting Mara attended — so each is asked `other`.
 */
function vault({ others, people, tasks }: { others: number; people: number; tasks: number }) {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE files (path TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
                        modified INTEGER NOT NULL, size INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE props (path TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0,
                        value_text TEXT, value_num REAL, value_date TEXT, value_json TEXT);
    CREATE INDEX props_path ON props(path, key, value_text);
    CREATE INDEX props_key ON props(key, value_text);
    CREATE TABLE tags (path TEXT NOT NULL, idx INTEGER NOT NULL, tag TEXT NOT NULL, name TEXT NOT NULL);
    CREATE INDEX tags_path ON tags(path);
    CREATE INDEX tags_tag ON tags(tag);
    CREATE TABLE relations (src TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL,
                            target TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', dst TEXT);
    CREATE INDEX relations_src ON relations(src, key);
    CREATE INDEX relations_dst ON relations(dst, src);
    CREATE TABLE links (src TEXT NOT NULL, dst TEXT, target TEXT NOT NULL DEFAULT '', leaf TEXT);
    CREATE INDEX links_src ON links(src);
    CREATE INDEX links_dst ON links(dst, src);`);
  const file = database.prepare('INSERT INTO files (path, title, modified) VALUES (?, ?, 0)');
  const type = database.prepare(
    "INSERT INTO props (path, key, idx, value_text) VALUES (?, 'type', 0, ?)",
  );
  const tag = database.prepare("INSERT INTO tags VALUES (?, 0, 'follow-up', 'follow-up')");
  const relation = database.prepare(
    "INSERT INTO relations VALUES (?, 'owner', 0, 'Mara Quill', 'mara quill', ?)",
  );
  database.exec('BEGIN');
  file.run(ENTITY, 'Mara Quill');
  type.run(ENTITY, 'person');
  file.run(MEETING, 'Weekly sync');
  type.run(MEETING, 'meeting');
  for (let at = 0; at < others; at += 1) {
    file.run(`Notes/Note ${at}.md`, `Note ${at}`);
    type.run(`Notes/Note ${at}.md`, 'note');
  }
  for (let at = 0; at < people; at += 1) {
    file.run(`People/Person ${at}.md`, `Person ${at}`);
    type.run(`People/Person ${at}.md`, 'person');
  }
  for (let at = 0; at < tasks; at += 1) {
    const path = `Tasks/Task ${at}.md`;
    file.run(path, `Task ${at}`);
    type.run(path, 'task');
    tag.run(path);
    relation.run(path, MEETING);
  }
  database.exec('COMMIT');
  return database;
}

const query = () =>
  compileFollowUpsQuery({
    entity: ENTITY,
    meetings: [MEETING],
    taskType: 'task',
    personType: 'person',
    statusKey: 'status',
    done: 'done',
  });

/** How many type rows the statement folds: SQLite's lower(), counted. */
function foldsRun(database: DatabaseSync): number {
  let folds = 0;
  database.function('lower', { deterministic: true }, (value) => {
    folds += 1;
    // ASCII only, as SQLite's own lower() folds.
    return typeof value === 'string' ? value.replace(/[A-Z]/g, (c) => c.toLowerCase()) : null;
  });
  const { sql, parameters } = query();
  const rows = database.prepare(sql).all(...(parameters as never[]));
  // The follow-ups were found, so `other` was asked of each.
  expect(rows.length).toBeGreaterThan(0);
  return folds;
}

describe('#616 attack: the follow-ups ask each task about people, not about every note', () => {
  it("the per-task Person subquery seeks people by their type, not every note's type row", () => {
    const database = vault({ others: 50, people: 5, tasks: 5 });
    const reads = correlatedReads(database, query()).filter((detail) => /\bt\b/.test(detail));
    expect(reads.length).toBeGreaterThan(0);
    for (const detail of reads) expect(detail).toMatch(/path=\?|value_text=\?/);
  });

  it('the follow-ups fold no more type rows per task when the vault has more unrelated notes', () => {
    // 100 follow-ups and 20 people, among 2,000 or 4,000 other notes. The type
    // rows are folded once for the whole statement at most (the outer IN):
    // twice the unrelated notes may cost that one pass twice over, never
    // twice per task.
    const small = foldsRun(vault({ others: 2000, people: 20, tasks: 100 }));
    const large = foldsRun(vault({ others: 4000, people: 20, tasks: 100 }));
    expect(large - small).toBeLessThanOrEqual(2 * 2000);
  });
});
