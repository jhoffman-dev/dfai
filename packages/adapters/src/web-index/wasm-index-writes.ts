import type { Database } from '@sqlite.org/sqlite-wasm';
import { writtenAt, type IndexedNote } from '@dfai/application';

/**
 * Putting notes in the browser's index and taking them out, as the host's
 * `write_note` and `remove_paths` do (`index.rs`): the same statements, so a
 * query reads the same rows on either. Nothing is decided here; every row is
 * one TypeScript already worked out (ADR-0005).
 */

/** The tables keyed by a note's path, and the column that holds it. */
const NOTE_ROWS: readonly (readonly [table: string, column: string])[] = [
  ['props', 'path'],
  ['links', 'src'],
  ['tags', 'path'],
  ['relations', 'src'],
  ['blocks', 'path'],
  ['checks', 'path'],
];

/** Adds or replaces a batch of notes in one transaction. */
export function putNotes(database: Database, notes: readonly IndexedNote[]): void {
  database.transaction(() => {
    for (const note of notes) writeNote(database, note);
  });
}

/** Removes a batch of notes, and every row of theirs, in one transaction. */
export function removeNotes(database: Database, paths: readonly string[]): void {
  database.transaction(() => {
    for (const path of paths) {
      // Before the note's own row goes: the search row is found through it.
      const row = searchRow(database, path);
      if (row !== null) database.exec({ sql: 'DELETE FROM fts WHERE rowid = ?', bind: [row] });
      deleteHighlights(database, path);
      database.exec({ sql: 'DELETE FROM files WHERE path = ?', bind: [path] });
      database.exec({ sql: 'DELETE FROM manifest WHERE path = ?', bind: [path] });
      deleteNoteRows(database, path);
    }
  });
}

function writeNote(database: Database, note: IndexedNote): void {
  deleteNoteRows(database, note.path);
  deleteHighlights(database, note.path);
  writeFile(database, note);
  writeSearchRow(database, note);
  writeRows(database, note);
  writeHighlights(database, note);
}

function deleteNoteRows(database: Database, path: string): void {
  for (const [table, column] of NOTE_ROWS) {
    database.exec({ sql: `DELETE FROM ${table} WHERE ${column} = ?`, bind: [path] });
  }
}

/**
 * The note's row in `files`, whose `modified` is when it was written —
 * `writtenAt`, NULL when the vault cannot tell (ADR-0053) — and its version
 * in `manifest`, which is what a refresh compares to tell what changed.
 */
function writeFile(database: Database, note: IndexedNote): void {
  database.exec({
    sql: `INSERT INTO files (path, title, summary, modified, size, digest, note_type, progress)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
          ON CONFLICT(path) DO UPDATE SET
            title = ?2, summary = ?3, modified = ?4, size = ?5, digest = ?6,
            note_type = ?7, progress = ?8`,
    bind: [
      note.path,
      note.title,
      note.summary,
      writtenAt(note),
      note.size,
      note.digest,
      note.type,
      note.progress,
    ],
  });
  database.exec({
    sql: `INSERT INTO manifest (path, version) VALUES (?1, ?2)
          ON CONFLICT(path) DO UPDATE SET version = ?2`,
    bind: [note.path, note.modified],
  });
}

/**
 * A note's search row has the rowid of its row in `files` (the host's schema
 * 14): one lookup by rowid, never a scan of the search table by path.
 */
function writeSearchRow(database: Database, note: IndexedNote): void {
  const row = searchRow(database, note.path);
  database.exec({ sql: 'DELETE FROM fts WHERE rowid = ?', bind: [row] });
  database.exec({
    sql: 'INSERT INTO fts (rowid, path, title, body) VALUES (?, ?, ?, ?)',
    bind: [row, searchableFileStem(note.path), note.title, note.body],
  });
}

function writeRows(database: Database, note: IndexedNote): void {
  const insert = (sql: string, bind: (string | number | null)[]) => database.exec({ sql, bind });
  for (const row of note.properties) {
    insert(
      'INSERT INTO props (path, key, idx, value_text, value_num, value_date, value_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [note.path, row.key, row.index, row.text, row.number, row.date, row.json],
    );
  }
  for (const link of note.links) {
    insert('INSERT INTO links (src, dst, target, kind, leaf) VALUES (?, ?, ?, ?, ?)', [
      note.path,
      link.path,
      link.target,
      link.kind,
      link.leaf,
    ]);
  }
  for (const row of note.relations) {
    insert('INSERT INTO relations (src, key, idx, target, name, dst) VALUES (?, ?, ?, ?, ?, ?)', [
      note.path,
      row.key,
      row.index,
      row.target,
      row.name,
      row.path,
    ]);
  }
  note.tags.forEach((tag, at) =>
    insert('INSERT INTO tags (path, idx, tag, name) VALUES (?, ?, ?, ?)', [
      note.path,
      at,
      tag.key,
      tag.name,
    ]),
  );
  note.blocks.forEach((block, at) =>
    insert('INSERT INTO blocks (path, idx, id, text) VALUES (?, ?, ?, ?)', [
      note.path,
      at,
      block.id,
      block.text,
    ]),
  );
  note.checks.forEach((check, at) =>
    insert('INSERT INTO checks (path, idx, done, text) VALUES (?, ?, ?, ?)', [
      note.path,
      at,
      check.done ? 1 : 0,
      check.text,
    ]),
  );
}

/** Each highlight, and its search row at the rowid of its row in `highlights` (#507). */
function writeHighlights(database: Database, note: IndexedNote): void {
  note.highlights.forEach((row, at) => {
    database.exec({
      sql: `INSERT INTO highlights (path, idx, id, kind, quote, comment, mark, color, anchor)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      bind: [
        note.path,
        at,
        row.id,
        row.kind,
        row.quote,
        row.comment,
        row.mark,
        row.color,
        row.anchor,
      ],
    });
    database.exec({
      sql: 'INSERT INTO highlights_fts (rowid, quote, comment) VALUES (last_insert_rowid(), ?, ?)',
      bind: [row.quote, row.comment],
    });
  });
}

/** A note's highlights and their search rows: the search rows first, found by the highlights' rowids. */
function deleteHighlights(database: Database, path: string): void {
  database.exec({
    sql: 'DELETE FROM highlights_fts WHERE rowid IN (SELECT rowid FROM highlights WHERE path = ?)',
    bind: [path],
  });
  database.exec({ sql: 'DELETE FROM highlights WHERE path = ?', bind: [path] });
}

/** The rowid of a note's row in `files`, which is its search row's too; null for a note not held. */
function searchRow(database: Database, path: string): number | null {
  const row = database.selectValue('SELECT rowid FROM files WHERE path = ?', [path]);
  return row === undefined || row === null ? null : Number(row);
}

/**
 * The part of a path worth searching: the file name without its extension
 * (#211), as the host's `searchable_file_stem` takes it.
 */
export function searchableFileStem(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  // Rust's file_stem keeps a name that is only an extension (`.md`) whole.
  return dot > 0 ? name.slice(0, dot) : name;
}
