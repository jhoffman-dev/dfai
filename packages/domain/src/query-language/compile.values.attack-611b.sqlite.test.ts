import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { indexablePropertiesOf, type IndexableProperty } from '../index/property-value.ts';
import { correlatedReads } from '../testing/query-plan.ts';
import { compileAtlasQuery } from './compile.ts';
import { parseAtlasQuery } from './parse.ts';
import { QUERY_TEST_TYPES } from './query-fixtures.ts';
import { typeViewSelectSql } from './type-view.ts';

/**
 * Second attack on PR #611 (#110, commit df3eee78): the query language now
 * reads a single-valued field by the value its cell shows, a date field by
 * the days it holds, and FROM by the type in any case. Here a seeded oracle
 * written from those three rules — the cell is the first row, a date's rows
 * are its real dates — is held against SQLite over generated vaults, for
 * every operator and for AND / OR / NOT trees.
 */

type Frontmatter = Readonly<Record<string, unknown>>;

const SCHEMA = `
  CREATE TABLE files (path TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
                      modified INTEGER NOT NULL, size INTEGER NOT NULL, digest TEXT NOT NULL DEFAULT '',
                      note_type TEXT, progress INTEGER);
  CREATE TABLE props (path TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0,
                      value_text TEXT, value_num REAL, value_date TEXT, value_json TEXT);
  CREATE INDEX props_path ON props(path, key, value_text);
  CREATE INDEX props_key ON props(key, value_text);
  CREATE TABLE relations (src TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL,
                          target TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', dst TEXT);
  CREATE INDEX relations_src ON relations(src, key);
  CREATE TABLE tags (path TEXT NOT NULL, idx INTEGER NOT NULL, tag TEXT NOT NULL, name TEXT NOT NULL);`;

function index(notes: Readonly<Record<string, Frontmatter>>): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec(SCHEMA);
  const file = database.prepare("INSERT INTO files VALUES (?, ?, '', 0, 1, '', NULL, NULL)");
  const prop = database.prepare('INSERT INTO props VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const [title, frontmatter] of Object.entries(notes)) {
    const path = `Tasks/${title}.md`;
    file.run(path, title);
    for (const row of indexablePropertiesOf(frontmatter)) {
      prop.run(path, row.key, row.index, row.text, row.number, row.date, row.json);
    }
  }
  return database;
}

function run(database: DatabaseSync, text: string): Record<string, unknown>[] {
  const compiled = compileAtlasQuery(parseAtlasQuery(text), {
    types: QUERY_TEST_TYPES,
    resolveLink: () => null,
  });
  return database.prepare(compiled.sql).all(...(compiled.parameters as never[])) as Record<
    string,
    unknown
  >[];
}

const titlesOf = (rows: readonly Record<string, unknown>[]) =>
  rows.map((row) => String(row['title'])).sort();

/** A small seeded generator (mulberry32): the same seed gives the same vaults. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(random: () => number, items: readonly T[]): T =>
  items[Math.floor(random() * items.length)] as T;

/** Values a field may hold, of its kind or not: what hand-edited frontmatter carries. */
const POOL: readonly unknown[] = [
  null,
  '',
  '   ',
  'TBD',
  '2026-02-30',
  '2026-10-01',
  '2026-09-30',
  '2026-10-02',
  '2026-10-01T23:30:00-07:00',
  '2026-10-01 09:00',
  3,
  '3',
  2.5,
  'abc',
  true,
  'true',
  'false',
  'alpha',
  'Alpha beta',
  'doing',
  'done',
  'backlog',
];

const TYPE_SPELLINGS: readonly unknown[] = ['task', 'Task', ' TASK ', 'tAsK', 'tasks', 'project'];

/** The single-valued own fields of QUERY_TEST_TYPES' task, by kind. */
const SINGLE_FIELDS = {
  status: 'select',
  due: 'date',
  estimate: 'number',
  notes: 'text',
} as const;
type SingleField = keyof typeof SINGLE_FIELDS;

function written(random: () => number): unknown {
  const shape = random();
  if (shape < 0.25) return undefined;
  if (shape < 0.65) return pick(random, POOL);
  const count = 1 + Math.floor(random() * 3);
  return Array.from({ length: count }, () => pick(random, POOL));
}

function vault(random: () => number): Record<string, Frontmatter> {
  const notes: Record<string, Frontmatter> = {};
  const count = 4 + Math.floor(random() * 14);
  for (let at = 0; at < count; at += 1) {
    const note: Record<string, unknown> = { type: pick(random, TYPE_SPELLINGS) };
    for (const key of Object.keys(SINGLE_FIELDS)) {
      const value = written(random);
      if (value !== undefined) note[key] = value;
    }
    notes[`Note ${at}`] = note;
  }
  return notes;
}

// ---- The oracle: the PR's three rules, read off the index rows in TypeScript.

/** FROM task, as the Today page reads a type (`lower(trim(..))`; ASCII spellings here). */
const isTask = (rows: readonly IndexableProperty[]) =>
  rows.some((row) => row.key === 'type' && row.text?.trim().toLowerCase() === 'task');

/**
 * The rows that hold the field's value, as Today reads them (the rule settled
 * after this attack, in place of "the first row"): a date's first real date
 * (`firstDay`); any other single field's value only when it is written as one
 * (`singleText`), and a number's only when it is a number.
 */
function rowsOf(rows: readonly IndexableProperty[], key: SingleField): IndexableProperty[] {
  const own = rows.filter((row) => row.key === key).sort((left, right) => left.index - right.index);
  if (SINGLE_FIELDS[key] === 'date') return own.filter((row) => row.date !== null).slice(0, 1);
  if (own.length !== 1) return [];
  return SINGLE_FIELDS[key] === 'number' ? own.filter((row) => row.number !== null) : own;
}

/** What the cell shows: the first row's value as the query reads it, null for none. */
function cellOf(rows: readonly IndexableProperty[], key: SingleField): string | number | null {
  const first = rowsOf(rows, key)[0];
  if (first === undefined) return null;
  if (SINGLE_FIELDS[key] === 'number') return first.number;
  if (SINGLE_FIELDS[key] === 'date') return first.date;
  return first.text;
}

type Leaf =
  | { key: SingleField; op: string; operand: string }
  | { key: SingleField; op: 'empty' | 'notEmpty' };

function holds(rows: readonly IndexableProperty[], leaf: Leaf): boolean {
  const cell = cellOf(rows, leaf.key);
  if (leaf.op === 'empty') return cell === null || cell === '';
  if (leaf.op === 'notEmpty') return !(cell === null || cell === '');
  const { op, operand } = leaf as { op: string; operand: string };
  const kind = SINGLE_FIELDS[leaf.key];
  const left =
    cell === null
      ? null
      : kind === 'date'
        ? String(cell).slice(0, 10)
        : kind === 'number'
          ? Number(cell)
          : String(cell);
  const right = kind === 'number' ? Number(operand) : operand;
  if (op === '!=') return !(left !== null && left === right);
  if (left === null) return false;
  switch (op) {
    case '=':
      return left === right;
    case '<':
      return left < right;
    case '<=':
      return left <= right;
    case '>':
      return left > right;
    case '>=':
      return left >= right;
    case 'CONTAINS':
      return String(left).toLowerCase().includes(String(right).toLowerCase());
    case 'STARTS WITH':
      return String(left).toLowerCase().startsWith(String(right).toLowerCase());
    default:
      throw new Error(`no oracle for ${op}`);
  }
}

const OPS: Readonly<Record<string, readonly string[]>> = {
  select: ['=', '!=', 'CONTAINS', 'STARTS WITH'],
  text: ['=', '!=', 'CONTAINS', 'STARTS WITH'],
  date: ['=', '!=', '<', '<=', '>', '>='],
  number: ['=', '!=', '<', '<=', '>', '>='],
};
const OPERANDS: Readonly<Record<string, readonly string[]>> = {
  select: ['backlog', 'doing', 'done'],
  text: ['alpha', 'abc', 'a', '3', 'TBD'],
  date: ['2026-10-01', '2026-09-30', '2026-10-02'],
  number: ['3', '2.5', '0'],
};

function comparisonLeaf(random: () => number): Leaf {
  const key = pick(random, Object.keys(SINGLE_FIELDS) as SingleField[]);
  const kind = SINGLE_FIELDS[key];
  return { key, op: pick(random, OPS[kind] ?? []), operand: pick(random, OPERANDS[kind] ?? []) };
}

function leafText(leaf: Leaf): string {
  if (leaf.op === 'empty') return `${leaf.key} IS EMPTY`;
  if (leaf.op === 'notEmpty') return `${leaf.key} IS NOT EMPTY`;
  const { operand } = leaf as { operand: string };
  const quoted = SINGLE_FIELDS[leaf.key] === 'text' ? `"${operand}"` : operand;
  return `${leaf.key} ${leaf.op} ${quoted}`;
}

/** A condition tree, its query text and its oracle together. */
interface Tree {
  readonly text: string;
  readonly test: (rows: readonly IndexableProperty[]) => boolean;
}

function tree(random: () => number, depth: number, leaf: (random: () => number) => Leaf): Tree {
  const shape = random();
  if (depth === 0 || shape < 0.4) {
    const one = leaf(random);
    return { text: leafText(one), test: (rows) => holds(rows, one) };
  }
  if (shape < 0.55) {
    const inner = tree(random, depth - 1, leaf);
    return { text: `NOT (${inner.text})`, test: (rows) => !inner.test(rows) };
  }
  const [left, right] = [tree(random, depth - 1, leaf), tree(random, depth - 1, leaf)];
  const and = shape < 0.8;
  return {
    text: `(${left.text}) ${and ? 'AND' : 'OR'} (${right.text})`,
    test: and
      ? (rows) => left.test(rows) && right.test(rows)
      : (rows) => left.test(rows) || right.test(rows),
  };
}

/** The first query whose rows differ from the oracle's, over `vaults` seeded vaults. */
function firstDisagreement(
  seed: number,
  leaf: (random: () => number) => Leaf,
  vaults = 60,
): { query: string; notes: Record<string, Frontmatter>; sql: string[]; oracle: string[] } | null {
  const random = rng(seed);
  for (let at = 0; at < vaults; at += 1) {
    const notes = vault(random);
    const database = index(notes);
    for (let ask = 0; ask < 12; ask += 1) {
      const condition = tree(random, 2, leaf);
      const query = `FROM task WHERE ${condition.text}`;
      const sql = titlesOf(run(database, query));
      const oracle = Object.entries(notes)
        .filter(([, note]) => {
          const rows = indexablePropertiesOf(note);
          return isTask(rows) && condition.test(rows);
        })
        .map(([title]) => title)
        .sort();
      if (JSON.stringify(sql) !== JSON.stringify(oracle)) {
        const differ = new Set(
          [...sql, ...oracle].filter((t) => sql.includes(t) !== oracle.includes(t)),
        );
        return {
          query,
          notes: Object.fromEntries(Object.entries(notes).filter(([title]) => differ.has(title))),
          sql,
          oracle,
        };
      }
    }
  }
  return null;
}

describe('#611b attack: the oracle reads cells as the query shows them', () => {
  // A guard on the oracle itself: its cell is the cell `SHOW` draws.
  it("the oracle's cell is the query's own cell, for every single-valued field, over seeded vaults", () => {
    const random = rng(6110);
    for (let at = 0; at < 40; at += 1) {
      const notes = vault(random);
      const rows = run(index(notes), 'FROM task SHOW status, due, estimate, notes');
      for (const row of rows) {
        const own = indexablePropertiesOf(notes[String(row['title'])] ?? {});
        for (const key of Object.keys(SINGLE_FIELDS) as SingleField[]) {
          expect({ note: row['title'], key, cell: row[key] ?? null }).toEqual({
            note: row['title'],
            key,
            cell: cellOf(own, key),
          });
        }
      }
    }
  });
});

describe('#611b attack: a single-valued field is compared on the value its cell shows', () => {
  it('every comparison, in AND / OR / NOT trees, lists what the cells say (seeded, 60 vaults)', () => {
    expect(firstDisagreement(611, comparisonLeaf)).toBeNull();
  });

  it('IS EMPTY and IS NOT EMPTY, in trees, list what the cells say (seeded, 60 vaults)', () => {
    const emptiness = (random: () => number): Leaf => ({
      key: pick(random, Object.keys(SINGLE_FIELDS) as SingleField[]),
      op: random() < 0.5 ? 'empty' : 'notEmpty',
    });
    expect(firstDisagreement(612, emptiness)).toBeNull();
  });
});

describe('#611b attack: a value the cell shows blank is empty', () => {
  // The first row is what the cell shows and what `=` asks about; IS EMPTY
  // still asks whether any row holds something (compile.ts conditionSql).
  it('a single text whose first item is blank is empty, as its cell is', () => {
    const database = index({ 'Brief Tobias Fenn': { type: 'task', notes: ['', 'alpha'] } });
    const [row] = run(database, 'FROM task SHOW notes');
    // Written as a list, a single text holds no value (singleText), so its cell is blank.
    expect(row?.['notes']).toBeNull();
    expect(titlesOf(run(database, 'FROM task WHERE notes = alpha'))).toEqual([]);
    expect(titlesOf(run(database, 'FROM task WHERE notes IS EMPTY'))).toEqual([
      'Brief Tobias Fenn',
    ]);
  });

  // A date that is words is no date (the PR's rule 1); a number that is
  // words is still a value, though its cell (p.value_num) shows none.
  it('a number field holding words is empty, as its cell is', () => {
    const database = index({ 'Size the Larkspur launch': { type: 'task', estimate: 'lots' } });
    const [row] = run(database, 'FROM task SHOW estimate');
    expect(row?.['estimate']).toBeNull();
    expect(titlesOf(run(database, 'FROM task WHERE estimate IS EMPTY'))).toEqual([
      'Size the Larkspur launch',
    ]);
  });
});

describe('#611b attack: a checkbox is a single-valued own field too', () => {
  // conditionSql sends a checkbox to checkboxCondition, which asks any row,
  // so `flagged: [false, true]` shows false and is `flagged = true`.
  it('a checkbox written as [false, true] is compared on the false its cell shows', () => {
    const database = index({ 'Ring Mara Quill': { type: 'task', flagged: [false, true] } });
    const [row] = run(database, 'FROM task SHOW flagged');
    // Written as a list, a single checkbox holds no value, so its cell is blank.
    expect(row?.['flagged']).toBeNull();
    expect(titlesOf(run(database, 'FROM task WHERE flagged = true'))).toEqual([]);
  });
});

describe('#611b attack: the type field reads a type as FROM does', () => {
  const database = index({
    'Plain task': { type: 'task' },
    'Capital task': { type: 'Task' },
  });

  // FROM task lists `type: Task` (lower(trim)); `type = task` compares
  // value_text exactly, so the same query drops the note it just listed.
  it('type = task keeps every note FROM task lists', () => {
    expect(titlesOf(run(database, 'FROM task WHERE type = task'))).toEqual(
      titlesOf(run(database, 'FROM task')),
    );
  });

  it('type != task drops every note FROM task lists', () => {
    expect(titlesOf(run(database, 'FROM task WHERE type != task'))).toEqual([]);
  });
});

describe('#611b attack: FROM in any case costs no more reads per note', () => {
  // Before the PR, FROM's type test sought props_path by (path, key,
  // value_text): one index probe per note. lower(trim(value_text)) cannot be
  // sought, so each note's every type row is read and tested instead.
  it("FROM's type test seeks the note's type rows by the type's value", () => {
    const database = new DatabaseSync(':memory:');
    database.exec(SCHEMA);
    const compiled = compileAtlasQuery(parseAtlasQuery('FROM task WHERE status = doing'), {
      types: QUERY_TEST_TYPES,
      resolveLink: () => null,
    });
    const plan = database
      .prepare(`EXPLAIN QUERY PLAN ${compiled.sql}`)
      .all(...(compiled.parameters as never[])) as { detail: string }[];
    const typeTest = plan.map((step) => step.detail).filter((detail) => /^SEARCH t\b/.test(detail));
    expect(typeTest.length).toBeGreaterThan(0);
    // Matched in any case, the type cannot be sought by its exact value_text.
    // It is sought by the note and the key instead — the note's own type
    // rows, one for nearly every note — never a scan of other notes' rows.
    for (const detail of typeTest) {
      expect(detail).toContain('(path=? AND key=?)');
    }
    // Every per-note read still seeks by the note's path: no scan was introduced.
    for (const detail of correlatedReads(database, compiled)) expect(detail).toMatch(/\(path=\?/);
  });
});

describe("#611b attack: a type's table and a FROM query read one note alike", () => {
  // The type table, the sidebar's quick-view counts and dashboard widgets
  // read `v_<type>` through compileViewQuery. This is that view as
  // apps/desktop/src-tauri/src/index.rs replace_views builds it (and
  // e2e/host.ts mirrors it): the type matched exactly, a single value as the
  // MAX of its rows. The PR moved FROM and the cell to "any case" and "the
  // first row"; the view kept the old rule.
  function withTaskView(notes: Readonly<Record<string, Frontmatter>>): DatabaseSync {
    const database = index(notes);
    // The view as the index builds it now: from typeViewSelectSql, which the
    // Rust builder is pinned to (type-view.pin.test.ts).
    const select = typeViewSelectSql({
      name: 'task',
      columns: [{ key: 'due', kind: 'date', many: false }],
      progress: false,
    });
    database.exec(`CREATE VIEW "v_task" AS ${select ?? ''};`);
    return database;
  }

  it('the Task table lists the note FROM task lists for type: Task', () => {
    const database = withTaskView({ 'Capital task': { type: 'Task', due: '2026-10-01' } });
    const table = database.prepare('SELECT "title" FROM "v_task"').all();
    expect(titlesOf(table)).toEqual(titlesOf(run(database, 'FROM task')));
  });

  it("the Task table's due cell is the due FROM task shows, for a due written as two days", () => {
    const database = withTaskView({
      'Two dues': { type: 'task', due: ['2026-10-01', '2026-11-30'] },
    });
    const table = database.prepare('SELECT "due" FROM "v_task"').get();
    const [query] = run(database, 'FROM task SHOW due');
    expect(table?.['due']).toBe(query?.['due']);
  });
});

describe('#611b attack: SORT BY reads the value the cell shows', () => {
  const sortKey = (key: SingleField, cell: unknown): string | number => {
    const kind = SINGLE_FIELDS[key];
    if (kind === 'number') return Number(cell);
    if (kind === 'date') return String(cell).replace(' ', 'T');
    return String(cell).toLowerCase();
  };

  it('rows sorted by a single-valued field run in the order of their cells, blanks last (seeded)', () => {
    const random = rng(6115);
    for (let at = 0; at < 40; at += 1) {
      const database = index(vault(random));
      for (const key of Object.keys(SINGLE_FIELDS) as SingleField[]) {
        const cells = run(database, `FROM task SORT BY ${key} SHOW ${key}`).map((row) => row[key]);
        const blank = (cell: unknown) => cell === null || cell === '';
        const firstBlank = cells.findIndex(blank);
        const filled = firstBlank === -1 ? cells : cells.slice(0, firstBlank);
        expect({ key, blanksLast: cells.slice(filled.length).every(blank) }).toEqual({
          key,
          blanksLast: true,
        });
        const keys = filled.map((cell) => sortKey(key, cell));
        expect({ key, keys }).toEqual({
          key,
          keys: [...keys].sort((l, r) => (l < r ? -1 : l > r ? 1 : 0)),
        });
      }
    }
  });
});
