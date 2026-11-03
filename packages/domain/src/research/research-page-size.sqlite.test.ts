import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { compileHighlightsQuery, HIGHLIGHTS_PAGE_SIZE } from './research-query.ts';

/**
 * Test for the research area (#507): one page of All highlights must fit the
 * host's answer. `run_query` (src-tauri/src/index.rs) adds up the UTF-8 bytes
 * of every text value and fails the whole statement past MAX_QUERY_BYTES
 * (16 MiB) — so a page that does not fit is not a short page, it is "The
 * highlights could not be read". The page size assumes three bytes a
 * character; a character outside the BMP (an emoji, a historic script) is
 * four, and the path is counted on every row too.
 */
const MAX_QUERY_BYTES = 16 * 1024 * 1024;

let open: DatabaseSync[] = [];
afterEach(() => {
  open.forEach((database) => database.close());
  open = [];
});

describe('a page of All highlights', () => {
  it('fits the host answer when every quote and comment is 500 four-byte characters', () => {
    const database = new DatabaseSync(':memory:');
    open.push(database);
    database.exec(`CREATE TABLE files (path TEXT PRIMARY KEY, title TEXT NOT NULL,
      modified INTEGER);
      CREATE TABLE props (path TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0,
      value_text TEXT);
      CREATE TABLE highlights (path TEXT NOT NULL, idx INTEGER NOT NULL, id TEXT NOT NULL,
      kind TEXT NOT NULL, quote TEXT NOT NULL, comment TEXT NOT NULL, mark TEXT NOT NULL,
      color TEXT NOT NULL, anchor TEXT NOT NULL);`);
    // A source note named for a long title (a file name takes 255 bytes): 226 bytes of path.
    const path = `Library/${'Kōan'.repeat(43)}.md`;
    database.prepare("INSERT INTO files VALUES (?, 'A long title', 0)").run(path);
    database.prepare("INSERT INTO props VALUES (?, 'type', 0, 'literature')").run(path);
    const text = '\u{1F4D6}'.repeat(600);
    const insert = database.prepare(
      "INSERT INTO highlights VALUES (?, ?, ?, 'kindle', ?, ?, 'highlight', 'yellow', '{}')",
    );
    database.exec('BEGIN');
    for (let at = 0; at < HIGHLIGHTS_PAGE_SIZE; at += 1) {
      insert.run(path, at, `h${at.toString(36).padStart(5, '0')}`, text, text);
    }
    database.exec('COMMIT');

    const { sql, parameters } = compileHighlightsQuery();
    const rows = database.prepare(sql).all(...parameters) as Record<string, unknown>[];
    expect(rows).toHaveLength(HIGHLIGHTS_PAGE_SIZE);
    const bytes = rows
      .flatMap((row) => Object.values(row))
      .reduce<number>(
        (sum, value) => sum + (typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0),
        0,
      );
    expect(bytes).toBeLessThanOrEqual(MAX_QUERY_BYTES);
  });
});
