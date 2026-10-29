import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { indexablePropertiesOf, type IndexableProperty } from '../index/property-value.ts';
import { relationsOf } from '../index/relation-rows.ts';
import { correlatedReads } from '../testing/query-plan.ts';
import { PROPS_TYPE_FOLD_INDEX } from '../types/note-type-sql.ts';
import { compileAtlasQuery } from './compile.ts';
import { QueryTextError } from './query-text-error.ts';
import { parseAtlasQuery } from './parse.ts';
import { QUERY_TEST_TYPES } from './query-fixtures.ts';
import { typeViewSelectSql } from './type-view.ts';

/**
 * Second attack on PR #616 (follow-up to #110, head 8e0e3ddd): no value now
 * compares as false, not unknown, so NOT keeps a note with no value; a field
 * of one value is read in one subquery (`ownValueSql`), one of many or one
 * through a link by its held rows (`valueRowsSql`); a type's view takes a
 * list's first item by a 19-digit written-order key.
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
  ${PROPS_TYPE_FOLD_INDEX};
  CREATE TABLE relations (src TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL,
                          target TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', dst TEXT);
  CREATE INDEX relations_src ON relations(src, key);
  CREATE INDEX relations_dst ON relations(dst, src);
  CREATE TABLE tags (path TEXT NOT NULL, idx INTEGER NOT NULL, tag TEXT NOT NULL, name TEXT NOT NULL);
  CREATE TABLE links (src TEXT NOT NULL, dst TEXT, target TEXT NOT NULL DEFAULT '', leaf TEXT);`;

const pathOf = (title: string) =>
  `${title.startsWith('Project') ? 'Projects' : 'Tasks'}/${title}.md`;

function index(notes: Readonly<Record<string, Frontmatter>>): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec(SCHEMA);
  const resolve = (target: string) => (target in notes ? pathOf(target) : null);
  const file = database.prepare("INSERT INTO files VALUES (?, ?, '', 0, 1, '', NULL, NULL)");
  const prop = database.prepare('INSERT INTO props VALUES (?, ?, ?, ?, ?, ?, ?)');
  const relation = database.prepare('INSERT INTO relations VALUES (?, ?, ?, ?, ?, ?)');
  for (const [title, frontmatter] of Object.entries(notes)) {
    const path = pathOf(title);
    file.run(path, title);
    for (const row of indexablePropertiesOf(frontmatter)) {
      prop.run(path, row.key, row.index, row.text, row.number, row.date, row.json);
    }
    for (const row of relationsOf(frontmatter, resolve)) {
      relation.run(path, row.key, row.index, row.target, row.name, row.path);
    }
  }
  return database;
}

const compiled = (text: string) =>
  compileAtlasQuery(parseAtlasQuery(text), { types: QUERY_TEST_TYPES, resolveLink: () => null });

function titles(database: DatabaseSync, text: string): string[] {
  const { sql, parameters } = compiled(text);
  const rows = database.prepare(sql).all(...(parameters as never[])) as { title: string }[];
  return rows.map((row) => row.title).sort();
}

/** mulberry32: the same seed gives the same vaults and the same queries. */
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

const POOL: readonly unknown[] = [
  null,
  '',
  'TBD',
  '2026-02-30',
  '2026-10-01',
  '2026-10-02',
  3,
  '3',
  2.5,
  'doing',
  'done',
  'Do it',
  true,
  'false',
  'red',
  'blue',
];

function written(random: () => number): unknown {
  const shape = random();
  if (shape < 0.25) return undefined;
  if (shape < 0.6) return pick(random, POOL);
  if (shape < 0.8)
    return Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(random, POOL));
  if (shape < 0.9) return [pick(random, POOL), ''];
  return [[pick(random, POOL), pick(random, POOL)]];
}

const OWN = {
  status: 'select',
  due: 'date',
  estimate: 'number',
  notes: 'text',
  flagged: 'checkbox',
  labels: 'multiSelect',
} as const;
const HOPS = { 'project.due': 'date', 'project.status': 'select' } as const;
type FieldName = keyof typeof OWN | keyof typeof HOPS;
const FIELDS = [...Object.keys(OWN), ...Object.keys(HOPS)] as FieldName[];
const kindOf = (field: FieldName): string =>
  field in OWN ? OWN[field as keyof typeof OWN] : HOPS[field as keyof typeof HOPS];

function vault(random: () => number): Record<string, Frontmatter> {
  const notes: Record<string, Frontmatter> = {};
  const projects = 1 + Math.floor(random() * 3);
  for (let at = 0; at < projects; at += 1) {
    const project: Record<string, unknown> = { type: 'project' };
    for (const key of ['due', 'status']) {
      const value = written(random);
      if (value !== undefined) project[key] = value;
    }
    notes[`Project ${at}`] = project;
  }
  const tasks = 4 + Math.floor(random() * 10);
  for (let at = 0; at < tasks; at += 1) {
    const task: Record<string, unknown> = { type: pick(random, ['task', 'Task', ' TASK ']) };
    for (const key of Object.keys(OWN)) {
      const value = written(random);
      if (value !== undefined) task[key] = value;
    }
    if (random() < 0.7) task['project'] = `[[Project ${Math.floor(random() * projects)}]]`;
    notes[`Task ${at}`] = task;
  }
  return notes;
}

// ---- The oracle: the guide's rules, two-valued, read off the rows the index is given.

/** The rows that hold a field's value: a date's first real day, a number's one number, one item of anything else, every item of many. */
function heldRows(rows: readonly IndexableProperty[], key: string, kind: string) {
  const own = rows.filter((row) => row.key === key && (row.text ?? row.json ?? '') !== '');
  if (kind === 'multiSelect') return own;
  if (kind === 'date') return own.filter((row) => row.date !== null).slice(0, 1);
  if (own.length !== 1) return [];
  return kind === 'number' ? own.filter((row) => row.number !== null) : own;
}

function heldOf(notes: Readonly<Record<string, Frontmatter>>, title: string, field: FieldName) {
  const note = notes[title] ?? {};
  if (field in OWN) return heldRows(indexablePropertiesOf(note), field, kindOf(field));
  const link = note['project'];
  const project = typeof link === 'string' ? notes[link.slice(2, -2)] : undefined;
  if (project === undefined) return [];
  return heldRows(indexablePropertiesOf(project), field.split('.')[1] ?? '', kindOf(field));
}

type Op = '=' | '!=' | '<' | '<=' | '>' | '>=' | 'CONTAINS' | 'STARTS WITH';

interface Atom {
  readonly kind: 'atom';
  readonly field: FieldName;
  readonly op: Op | 'IS EMPTY' | 'IS NOT EMPTY';
  readonly value: string | number;
}
type Tree =
  | Atom
  | { readonly kind: 'not'; readonly operand: Tree }
  | { readonly kind: 'and' | 'or'; readonly operands: readonly Tree[] };

const VALUES: Readonly<Record<string, readonly (string | number)[]>> = {
  select: ['doing', 'done', 'do', '3'],
  text: ['Do it', 'do', 'doing', '3'],
  multiSelect: ['red', 'blue', 're'],
  number: [2.5, 3, 4],
  date: ['2026-10-01', '2026-10-02'],
  checkbox: ['true', 'false'],
};

function compares(op: Op, held: string | number, value: string | number): boolean {
  if (op === 'CONTAINS') return String(held).toLowerCase().includes(String(value).toLowerCase());
  if (op === 'STARTS WITH')
    return String(held).toLowerCase().startsWith(String(value).toLowerCase());
  if (op === '=' || op === '!=') return held === value;
  if (op === '<') return held < value;
  if (op === '<=') return held <= value;
  if (op === '>') return held > value;
  return held >= value;
}

function oracleAtom(
  notes: Readonly<Record<string, Frontmatter>>,
  title: string,
  atom: Atom,
): boolean {
  const kind = kindOf(atom.field);
  const held = heldOf(notes, title, atom.field);
  if (atom.op === 'IS EMPTY') return held.length === 0;
  if (atom.op === 'IS NOT EMPTY') return held.length > 0;
  if (kind === 'checkbox') {
    const ticked = held.some((row) => row.text === 'true');
    return (atom.op === '=') === (ticked === (atom.value === 'true'));
  }
  const values = held.flatMap((row): (string | number)[] => {
    if (kind === 'number') return row.number === null ? [] : [row.number];
    if (kind === 'date') return row.date === null ? [] : [row.date.slice(0, 10)];
    return row.text === null ? [] : [row.text];
  });
  const op = atom.op;
  if (op === '!=') return !values.some((value) => compares('=', value, atom.value));
  return values.some((value) => compares(op, value, atom.value));
}

function oracle(notes: Readonly<Record<string, Frontmatter>>, title: string, tree: Tree): boolean {
  if (tree.kind === 'atom') return oracleAtom(notes, title, tree);
  if (tree.kind === 'not') return !oracle(notes, title, tree.operand);
  return tree.kind === 'and'
    ? tree.operands.every((operand) => oracle(notes, title, operand))
    : tree.operands.some((operand) => oracle(notes, title, operand));
}

function literal(kind: string, value: string | number): string {
  if (kind === 'number' || kind === 'date' || kind === 'checkbox') return String(value);
  return `"${String(value)}"`;
}

function textOf(tree: Tree): string {
  if (tree.kind === 'atom') {
    if (tree.op === 'IS EMPTY' || tree.op === 'IS NOT EMPTY') return `${tree.field} ${tree.op}`;
    return `${tree.field} ${tree.op} ${literal(kindOf(tree.field), tree.value)}`;
  }
  if (tree.kind === 'not') return `NOT (${textOf(tree.operand)})`;
  return tree.operands
    .map((operand) => `(${textOf(operand)})`)
    .join(` ${tree.kind.toUpperCase()} `);
}

const OPS: readonly Atom['op'][] = [
  '=',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'CONTAINS',
  'STARTS WITH',
  'IS EMPTY',
  'IS NOT EMPTY',
];

function atom(random: () => number): Atom {
  const field = pick(random, FIELDS);
  return {
    kind: 'atom',
    field,
    op: pick(random, OPS),
    value: pick(random, VALUES[kindOf(field)] ?? ['x']),
  };
}

function tree(random: () => number, depth: number): Tree {
  const shape = random();
  if (depth === 0 || shape < 0.35) return atom(random);
  if (shape < 0.55) return { kind: 'not', operand: tree(random, depth - 1) };
  const operands = Array.from({ length: 2 + Math.floor(random() * 2) }, () =>
    tree(random, depth - 1),
  );
  return { kind: shape < 0.8 ? 'and' : 'or', operands };
}

/** Whether the language takes a query: an operator a kind has no use for is refused, not run. */
function accepted(text: string): boolean {
  try {
    compiled(text);
    return true;
  } catch (error) {
    if (error instanceof QueryTextError) return false;
    throw error;
  }
}

interface Disagreement {
  readonly query: string;
  readonly sql: readonly string[];
  readonly oracle: readonly string[];
}

/** Each query's tree, kept beside its text, so a second run can be held to the first. */
const drawn = new Map<string, Tree>();

function firstDisagreement(seed: number, vaults: number, queries: number): Disagreement | null {
  const random = rng(seed);
  for (let at = 0; at < vaults; at += 1) {
    const notes = vault(random);
    const database = index(notes);
    const tasks = Object.keys(notes).filter((title) => title.startsWith('Task '));
    for (let asked = 0; asked < queries; asked += 1) {
      const where = tree(random, 3);
      const query = `FROM task WHERE ${textOf(where)}`;
      if (!accepted(query)) continue;
      drawn.set(query, where);
      const listed = titles(database, query);
      const expected = tasks.filter((title) => oracle(notes, title, where)).sort();
      if (JSON.stringify(listed) !== JSON.stringify(expected)) {
        return { query, sql: listed, oracle: expected };
      }
    }
  }
  return null;
}

describe('#616b attack: no value compares false, through NOT, AND and OR', () => {
  it('NOT, AND and OR trees over missing, blank, listed and nested values list what a two-valued oracle lists (seeded)', () => {
    expect(JSON.stringify(firstDisagreement(6162, 30, 40))).toBe('null');
  });

  it('the seeded trees are drawn alike on a second run', () => {
    drawn.clear();
    const first = firstDisagreement(6163, 2, 10);
    const keys = [...drawn.keys()];
    drawn.clear();
    expect(firstDisagreement(6163, 2, 10)).toEqual(first);
    expect([...drawn.keys()]).toEqual(keys);
    expect(keys.length).toBeGreaterThan(0);
  });
});

describe('#616b attack: a condition and its NOT, and IS EMPTY and IS NOT EMPTY, split the notes in two', () => {
  const random = rng(616_616);
  const vaults = Array.from({ length: 12 }, () => vault(random));

  it('every task is in exactly one of `x op v` and `NOT (x op v)`, for every field and operator', () => {
    const misplaced: string[] = [];
    for (const notes of vaults) {
      const database = index(notes);
      const tasks = titles(database, 'FROM task');
      for (const field of FIELDS) {
        for (const op of OPS.filter((each) => !each.startsWith('IS'))) {
          for (const value of VALUES[kindOf(field)] ?? []) {
            const condition = `${field} ${op} ${literal(kindOf(field), value)}`;
            if (!accepted(`FROM task WHERE ${condition}`)) continue;
            const yes = titles(database, `FROM task WHERE ${condition}`);
            const no = titles(database, `FROM task WHERE NOT (${condition})`);
            const both = yes.filter((title) => no.includes(title));
            const neither = tasks.filter((title) => !yes.includes(title) && !no.includes(title));
            if (both.length + neither.length > 0) misplaced.push(condition);
          }
        }
      }
    }
    expect(misplaced).toEqual([]);
  });

  it('`x != v` lists what `NOT (x = v)` lists, for every field', () => {
    const differ: string[] = [];
    for (const notes of vaults) {
      const database = index(notes);
      for (const field of FIELDS) {
        for (const value of VALUES[kindOf(field)] ?? []) {
          const shown = literal(kindOf(field), value);
          const not = titles(database, `FROM task WHERE ${field} != ${shown}`);
          const negated = titles(database, `FROM task WHERE NOT (${field} = ${shown})`);
          if (JSON.stringify(not) !== JSON.stringify(negated)) differ.push(`${field} ${shown}`);
        }
      }
    }
    expect(differ).toEqual([]);
  });

  it('every task is in exactly one of `x IS EMPTY` and `x IS NOT EMPTY`, and NOT (x IS EMPTY) is IS NOT EMPTY', () => {
    const misplaced: string[] = [];
    for (const notes of vaults) {
      const database = index(notes);
      const tasks = titles(database, 'FROM task');
      for (const field of FIELDS) {
        const empty = titles(database, `FROM task WHERE ${field} IS EMPTY`);
        const full = titles(database, `FROM task WHERE ${field} IS NOT EMPTY`);
        const notEmpty = titles(database, `FROM task WHERE NOT (${field} IS EMPTY)`);
        const split =
          JSON.stringify([...empty, ...full].sort()) === JSON.stringify(tasks) &&
          JSON.stringify(full) === JSON.stringify(notEmpty);
        if (!split) misplaced.push(field);
      }
    }
    expect(misplaced).toEqual([]);
  });
});

describe('#616b attack: a condition through a link seeks by the note, not by the value', () => {
  // FAILING: valueRowsSql's ONLY_ROW / HELD terms on the hop's `p` row turn
  // the planner round. `project.status = doing` is now read as "every props
  // row in the vault with key = status AND value_text = doing" (props_key),
  // each then probed for a link from this task (relations_dst) — once per
  // task. Work grows with tasks × notes holding that value: 8,000 tasks
  // sharing a status took 20 s here, against 14 ms on main (dc230efd), and
  // in the app it runs into QUERY_STEP_BUDGET as "interrupted".
  const database = new DatabaseSync(':memory:');
  database.exec(SCHEMA);
  for (const query of [
    'FROM task WHERE project.status = doing',
    'FROM task WHERE project.status != doing',
    'FROM task WHERE NOT (project.status = doing)',
    'FROM task WHERE project.status STARTS WITH "do"',
    'FROM task WHERE project.due = 2026-10-01',
  ]) {
    it(`${query}: every read per task seeks by a note it links to`, () => {
      const reads = correlatedReads(database, compiled(query));
      expect(reads.filter((detail) => !/\b(path|src|dst)=\?/.test(detail))).toEqual([]);
    });
  }
});

describe("#616b attack: a type's view takes a list's first item by written order", () => {
  const DUE = { key: 'due', kind: 'date', many: false } as const;
  const select = typeViewSelectSql({ name: 'task', columns: [DUE], progress: false }) ?? '';

  function viewed(rows: (database: DatabaseSync) => void): unknown {
    const database = new DatabaseSync(':memory:');
    database.exec(SCHEMA);
    database.exec("INSERT INTO files VALUES ('Tasks/a.md', 'a', '', 0, 1, '', NULL, NULL)");
    database.exec(
      "INSERT INTO props (path, key, idx, value_text) VALUES ('Tasks/a.md', 'type', 0, 'task')",
    );
    rows(database);
    return (database.prepare(select).get() as { due: unknown }).due;
  }

  it('a date list of a million and one items shows its first item, written last of all', () => {
    const due = viewed((database) => {
      database.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000000)
        INSERT INTO props (path, key, idx, value_text, value_date)
        SELECT 'Tasks/a.md', 'due', i, '2026-12-31', '2026-12-31' FROM n`);
      database.exec(
        "INSERT INTO props (path, key, idx, value_text, value_date) VALUES ('Tasks/a.md', 'due', 0, '2026-01-01', '2026-01-01')",
      );
    });
    expect(due).toBe('2026-01-01');
  });

  it('a rowid past 2^32 still orders a nested list by rowid within one idx', () => {
    const due = viewed((database) => {
      const prop = database.prepare(
        "INSERT INTO props (rowid, path, key, idx, value_text, value_date) VALUES (?, 'Tasks/a.md', 'due', ?, ?, ?)",
      );
      prop.run(4294967297, 0, '2026-03-01', '2026-03-01');
      prop.run(4294967298, 0, '2026-02-01', '2026-02-01');
      prop.run(4294967299, 1, '2026-01-01', '2026-01-01');
    });
    expect(due).toBe('2026-03-01');
  });
});

describe("#616b attack: a type's view walks only its type's notes", () => {
  // type-index.plan.sqlite.test.ts asks only that the fold index appears and
  // no step is CORRELATED: a view that asks every file its type — `WHERE
  // EXISTS (… props.path = n.path …)`, which SQLite runs as a walk of files
  // probing the fold index by path — passes it. Here the walk itself is refused.
  it('reads no file and no props row but those of the type it is the view of', () => {
    const select = typeViewSelectSql({
      name: 'task',
      columns: [
        { key: 'status', kind: 'select', many: false },
        { key: 'due', kind: 'date', many: false },
        { key: 'labels', kind: 'multiSelect', many: true },
      ],
      progress: true,
    });
    const database = new DatabaseSync(':memory:');
    database.exec(SCHEMA);
    const plan = (
      database.prepare(`EXPLAIN QUERY PLAN ${select ?? ''}`).all() as { detail: string }[]
    ).map((step) => step.detail);
    expect(plan.some((step) => /props_type_fold \(key=\? AND <expr>=\?\)/.test(step))).toBe(true);
    expect(plan.filter((step) => /^SCAN (n|p)\b/.test(step))).toEqual([]);
  });
});
