import { beforeEach, describe, expect, it } from 'vitest';
import type { IndexedNote } from '@dfai/application';
import { sqliteWasm } from './in-memory-web-index.ts';
import { memoryIndexFiles, type MemoryIndexFiles } from './memory-index-files.ts';
import { MAX_QUERY_ROWS } from './wasm-index-query.ts';
import { createWasmIndexHost, type WasmIndexHost } from './wasm-index-host.ts';
import { WEB_INDEX } from './web-index-schema.ts';
import { cellOf } from './wasm-index-reads.ts';

/**
 * The browser index's host on SQLite's WebAssembly build (#666), the rules
 * it holds as the Rust host does (`index.rs`): which vault a write is for,
 * that a query only reads, the result limits, the views, highlights.
 */

const VAULT = 'github:example/garden';

function note(path: string, more: Partial<IndexedNote> = {}): IndexedNote {
  return {
    path,
    title: path.replace(/^.*\//, '').replace(/\.md$/, ''),
    modified: 0x1234,
    modifiedAt: null,
    size: 10,
    digest: 'd',
    type: null,
    body: '',
    summary: '',
    properties: [],
    links: [],
    tags: [],
    relations: [],
    blocks: [],
    checks: [],
    progress: null,
    highlights: [],
    ...more,
  };
}

const highlight = (id: string, quote: string, comment = '') => ({
  id,
  kind: 'pdf' as const,
  quote,
  comment,
  mark: 'highlight' as const,
  color: 'yellow',
  anchor: '{}',
});

let files: MemoryIndexFiles;
let host: WasmIndexHost;
beforeEach(async () => {
  files = memoryIndexFiles(await sqliteWasm());
  host = createWasmIndexHost({ sqlite3: await sqliteWasm(), files, shape: WEB_INDEX });
});

describe('the index host, opening (#666)', () => {
  it('answers nothing before an index is open', () => {
    expect(() => host.manifest()).toThrow('the index is not open');
    expect(() => host.clear()).toThrow('the index is not open');
  });

  it('says an index is fresh only when it was made just now', () => {
    expect(host.open(VAULT)).toEqual({ fresh: true });
    host.put(VAULT, [note('A.md')]);
    expect(host.open(VAULT)).toEqual({ fresh: false });
    expect(host.stats().notes).toBe(1);
  });

  it('throws away an index of another shape', async () => {
    host.open(VAULT);
    host.put(VAULT, [note('A.md')]);
    const other = createWasmIndexHost({
      sqlite3: await sqliteWasm(),
      files,
      shape: { schema: WEB_INDEX.schema, version: WEB_INDEX.version + 1 },
    });
    expect(other.open(VAULT)).toEqual({ fresh: true });
    expect(other.stats().notes).toBe(0);
  });

  it('clears the open index, and keeps another vault’s', () => {
    host.open('github:example/other');
    host.put(null, [note('Kept.md')]);
    host.open(VAULT);
    host.put(VAULT, [note('A.md')]);
    host.clear();
    expect(host.stats().notes).toBe(0);
    expect(host.open('github:example/other')).toEqual({ fresh: false });
    expect(host.stats().notes).toBe(1);
  });

  it('refuses a write meant for a vault that is no longer the one open', () => {
    host.open(VAULT);
    expect(() => host.put('github:example/other', [note('A.md')])).toThrow(
      'another vault was opened before this could be indexed',
    );
    expect(() => host.remove('github:example/other', ['A.md'])).toThrow(/another vault/);
    expect(host.stats().notes).toBe(0);
  });
});

describe('the index host, writing (#666)', () => {
  beforeEach(() => void host.open(VAULT));

  it('keeps every row a note brings, and takes them all when it goes', () => {
    host.put(VAULT, [
      note('A.md', {
        properties: [
          { key: 'status', index: 0, text: 'open', number: null, date: null, json: null },
        ],
        links: [{ target: 'B', leaf: 'b', path: 'B.md', kind: 'wikilink' }],
        tags: [{ key: 'garden', name: 'Garden' }],
        relations: [{ key: 'project', index: 0, target: 'B', name: 'b', path: 'B.md' }],
        blocks: [{ id: 'x1', text: 'a block' }],
        checks: [{ done: true, text: 'sow' }],
        highlights: [highlight('h1', 'a larkspur quote', 'a comment')],
      }),
    ]);
    const count = (table: string) => host.query(`SELECT count(*) FROM ${table}`, []).rows[0]?.[0];
    const tables = ['props', 'links', 'tags', 'relations', 'blocks', 'checks', 'highlights'];
    expect(tables.map(count)).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(host.query('SELECT done FROM checks', []).rows).toEqual([[1]]);
    host.remove(VAULT, ['A.md']);
    expect(tables.map(count)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(host.search('larkspur', 10, { highlights: true })).toEqual([]);
  });

  it('finds a highlight by its quote or comment, named by its block, after the notes', () => {
    host.put(VAULT, [
      note('Library/Book.md', {
        body: 'larkspur',
        highlights: [highlight('q1', 'quote', 'larkspur seen')],
      }),
    ]);
    const hits = host.search('larkspur', 10, { highlights: true });
    expect(hits.map((hit) => [hit.path, hit.block])).toEqual([
      ['Library/Book.md', undefined],
      ['Library/Book.md', 'q1'],
    ]);
    expect(host.search('larkspur', 10, {}).map((hit) => hit.block)).toEqual([undefined]);
  });

  it('searches a file name without its folders or extension', () => {
    host.put(VAULT, [note('Projects/2026-11-02 Standup.md')]);
    expect(host.search('projects', 10, {})).toEqual([]);
    expect(host.search('standup', 10, {}).map((hit) => hit.path)).toEqual([
      'Projects/2026-11-02 Standup.md',
    ]);
    expect(host.search('md', 10, {})).toEqual([]);
  });

  it('says a malformed search is a bad search', () => {
    expect(() => host.search('"open', 10, {})).toThrow(/^bad search: /);
  });
});

describe('the index host, queries only read (#666)', () => {
  beforeEach(() => void host.open(VAULT));

  it.each([
    ['a write', 'DELETE FROM files'],
    ['a second statement', 'SELECT 1; DELETE FROM files'],
    ['an attach', "ATTACH DATABASE ':memory:' AS other"],
    ['a transaction', 'BEGIN'],
    ['a pragma that sets', 'PRAGMA query_only = 0'],
    ['the file behind the database', 'PRAGMA database_list'],
    ['the file behind the database, as a table', 'SELECT * FROM pragma_database_list'],
  ])('refuses %s', (_, sql) => {
    expect(() => host.query(sql, [])).toThrow();
  });

  it('lets a statement read with a comment after it, and a pragma that describes', () => {
    expect(host.query('SELECT 1 AS one; -- the end', []).rows).toEqual([[1]]);
    expect(host.query("PRAGMA table_info('files')", []).rows.length).toBeGreaterThan(0);
  });

  it('cuts a long result short and says so', () => {
    const result = host.query(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n LIMIT ${MAX_QUERY_ROWS + 5}) SELECT i FROM n`,
      [],
    );
    expect(result.rows).toHaveLength(MAX_QUERY_ROWS);
    expect(result.truncated).toBe(true);
  });

  it('refuses a result larger than DFAI will read', () => {
    expect(() =>
      host.query(
        'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n LIMIT 20) SELECT zeroblob(1000000) || hex(zeroblob(500000)) FROM n',
        [],
      ),
    ).toThrow('the result is larger than DFAI will read');
  });

  it('hands back an integer, a real and text as themselves, and a blob as nothing', () => {
    expect(host.query("SELECT 2, 2.5, 'x', x'00'", []).rows).toEqual([[2, 2.5, 'x', null]]);
    expect(cellOf(5n)).toBe(5);
  });
});

describe('the index host, views (#666)', () => {
  beforeEach(() => void host.open(VAULT));
  const views = () =>
    host.query("SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name", []).rows.flat();

  it('makes a view per type, and none for two spelt alike, a bad name, or text that is no SELECT', () => {
    host.rebuildViews([
      { name: 'task', select: 'SELECT path FROM files' },
      { name: 'Twin', select: 'SELECT path FROM files' },
      { name: 'twin', select: 'SELECT path FROM files' },
      { name: 'bad name', select: 'SELECT path FROM files' },
      { name: 'sneaky', select: 'DROP TABLE files' },
    ]);
    expect(views()).toEqual(['v_task']);
    host.rebuildViews([{ name: 'project', select: 'SELECT path FROM files' }]);
    expect(views()).toEqual(['v_project']);
  });

  it('says which type a view could not be built for', () => {
    expect(() => host.rebuildViews([{ name: 'task', select: 'SELECT FROM WHERE' }])).toThrow(
      /cannot build the view for task/,
    );
  });
});

describe('the index host, what the desktop cannot read (#666)', () => {
  beforeEach(() => void host.open(VAULT));

  // The WebAssembly build has these tables the desktop's does not; the raw pages hold deleted text.
  it.each([
    ['raw pages', 'SELECT data FROM sqlite_dbpage'],
    ['page statistics', 'SELECT name, pgsize FROM dbstat'],
    ['a statement’s bytecode', "SELECT opcode FROM bytecode('SELECT 1')"],
    ['the tables a statement uses', "SELECT name FROM tables_used('SELECT 1')"],
    ['the statements open', 'SELECT sql FROM sqlite_stmt'],
  ])('refuses %s', (_, sql) => {
    expect(() => host.query(sql, [])).toThrow();
  });
});

describe('the index host, opening a file it cannot read (#666)', () => {
  /** Files whose next open fails with SQLite's `code`. */
  function failingOnce(code: number) {
    const discarded: string[] = [];
    let fail = true;
    const failing: MemoryIndexFiles = {
      ...files,
      open: (vault) => {
        if (fail) {
          fail = false;
          throw Object.assign(new Error(`result code ${code}`), { resultCode: code });
        }
        return files.open(vault);
      },
      discard: (vault) => {
        discarded.push(vault);
        files.discard(vault);
      },
    };
    return { failing, discarded };
  }

  it('keeps an index it could not open for a passing reason, and says why', async () => {
    host.open(VAULT);
    host.put(VAULT, [note('A.md')]);
    files.keep();
    const { failing, discarded } = failingOnce(10); // SQLITE_IOERR
    const again = createWasmIndexHost({
      sqlite3: await sqliteWasm(),
      files: failing,
      shape: WEB_INDEX,
    });
    expect(() => again.open(VAULT)).toThrow('result code 10');
    expect(discarded).toEqual([]);
    expect(again.open(VAULT)).toEqual({ fresh: false });
  });

  it('throws away a file that is not a database, and makes it again', async () => {
    const { failing, discarded } = failingOnce(26); // SQLITE_NOTADB
    const again = createWasmIndexHost({
      sqlite3: await sqliteWasm(),
      files: failing,
      shape: WEB_INDEX,
    });
    expect(again.open(VAULT)).toEqual({ fresh: true });
    expect(discarded.length).toBeGreaterThan(0);
  });
});
