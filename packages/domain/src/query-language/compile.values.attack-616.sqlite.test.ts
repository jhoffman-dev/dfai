import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { indexablePropertiesOf, type IndexableProperty } from '../index/property-value.ts';
import { relationsOf } from '../index/relation-rows.ts';
import { compileReviewTasksQuery } from '../review/review-query.ts';
import { GTD_STATUSES } from '../gtd/gtd-status.ts';
import { parseObjectType } from '../types/property-def.ts';
import { compileAtlasQuery } from './compile.ts';
import { parseAtlasQuery } from './parse.ts';
import { QUERY_TEST_TYPES } from './query-fixtures.ts';
import { groupResultRows } from './result-groups.ts';
import { typeViewSelectSql } from './type-view.ts';
import { compileTypeCountsQuery } from '../sidebar/type-counts-query.ts';
import { compileParaValuesQuery } from '../types/para-value.ts';

/**
 * Attack on PR #616 (follow-up to #110, head 59683844): one row set,
 * `valueRowsSql`, says which of a note's rows hold a field's value — for a
 * condition, IS EMPTY, a cell, a sort, a hop and the type's view. Here an
 * oracle written from the PR's rules is held against SQLite over seeded
 * vaults, every field kind written as one value, several, none, or junk —
 * nested lists and blank items included, as hand-edited YAML carries them.
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
  CREATE INDEX relations_dst ON relations(dst, src);
  CREATE TABLE tags (path TEXT NOT NULL, idx INTEGER NOT NULL, tag TEXT NOT NULL, name TEXT NOT NULL);
  CREATE TABLE links (src TEXT NOT NULL, dst TEXT, target TEXT NOT NULL DEFAULT '', leaf TEXT);`;

const pathOf = (title: string, frontmatter: Frontmatter) =>
  `${String(frontmatter['type']).trim().toLowerCase() === 'project' ? 'Projects' : 'Tasks'}/${title}.md`;

function index(notes: Readonly<Record<string, Frontmatter>>): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec(SCHEMA);
  const paths = new Map(Object.entries(notes).map(([title, note]) => [title, pathOf(title, note)]));
  const resolve = (target: string) => paths.get(target) ?? null;
  const file = database.prepare("INSERT INTO files VALUES (?, ?, '', 0, 1, '', NULL, NULL)");
  const prop = database.prepare('INSERT INTO props VALUES (?, ?, ?, ?, ?, ?, ?)');
  const relation = database.prepare('INSERT INTO relations VALUES (?, ?, ?, ?, ?, ?)');
  for (const [title, frontmatter] of Object.entries(notes)) {
    const path = pathOf(title, frontmatter);
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

/** mulberry32: the same seed gives the same vaults. */
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
  '2026-10-01T23:30:00-07:00',
  3,
  '3',
  2.5,
  'abc',
  true,
  'true',
  'false',
  'doing',
  'done',
  'red',
  'blue',
];

/** How a value is written: absent, one, a list, a list with a blank, or a nested list. */
function written(random: () => number, { nested }: { nested: boolean }): unknown {
  const shape = random();
  if (shape < 0.2) return undefined;
  if (shape < 0.55) return pick(random, POOL);
  if (shape < 0.75)
    return Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(random, POOL));
  if (shape < 0.87 || !nested) return [pick(random, POOL), ''];
  return [[pick(random, POOL), pick(random, POOL)]];
}

/** The task fields the oracle reads, by kind; `labels` holds many. */
const OWN = {
  status: 'select',
  due: 'date',
  estimate: 'number',
  notes: 'text',
  flagged: 'checkbox',
  labels: 'multiSelect',
} as const;
type OwnKey = keyof typeof OWN;
const HOPS = { 'project.due': 'date', 'project.status': 'select' } as const;
type HopKey = keyof typeof HOPS;
type FieldName = OwnKey | HopKey;
const FIELDS = [...Object.keys(OWN), ...Object.keys(HOPS)] as FieldName[];
const kindOf = (field: FieldName) => (field in OWN ? OWN[field as OwnKey] : HOPS[field as HopKey]);

function vault(random: () => number, nested: boolean): Record<string, Frontmatter> {
  const notes: Record<string, Frontmatter> = {};
  const projects = 1 + Math.floor(random() * 3);
  for (let at = 0; at < projects; at += 1) {
    const project: Record<string, unknown> = { type: 'project' };
    for (const key of ['due', 'status']) {
      const value = written(random, { nested });
      if (value !== undefined) project[key] = value;
    }
    notes[`Project ${at}`] = project;
  }
  const tasks = 3 + Math.floor(random() * 10);
  for (let at = 0; at < tasks; at += 1) {
    const task: Record<string, unknown> = { type: pick(random, ['task', 'Task', ' TASK ']) };
    for (const key of Object.keys(OWN)) {
      const value = written(random, { nested });
      if (value !== undefined) task[key] = value;
    }
    if (random() < 0.7) task['project'] = `[[Project ${Math.floor(random() * projects)}]]`;
    notes[`Task ${at}`] = task;
  }
  return notes;
}

// ---- The oracle: the PR's rules, read off the rows the index is given.

/** A note's rows of one key, in the order they are written. */
const rowsOfKey = (rows: readonly IndexableProperty[], key: string) =>
  rows.filter((row) => row.key === key);

/**
 * The rows holding a field's value, by the PR's rules: a date its first real
 * day; a number only a number; any other single value only when written as
 * one (a list is no value, as Today's `singleText` counts rows); a
 * multi-select every value.
 */
function heldRows(
  rows: readonly IndexableProperty[],
  key: string,
  kind: string,
): IndexableProperty[] {
  const own = rowsOfKey(rows, key);
  if (kind === 'multiSelect') return own;
  if (kind === 'date') return own.filter((row) => row.date !== null).slice(0, 1);
  if (own.length !== 1) return [];
  return kind === 'number' ? own.filter((row) => row.number !== null) : own;
}

type Cell = string | number | null;

function ownCell(rows: readonly IndexableProperty[], key: string, kind: string): Cell {
  const held = heldRows(rows, key, kind);
  const shown = held.map((row) =>
    kind === 'number' ? row.number : kind === 'date' ? row.date : row.text,
  );
  if (kind === 'multiSelect') {
    const texts = shown.filter((value) => value !== null);
    return texts.length === 0 ? null : texts.join(', ');
  }
  return shown[0] ?? null;
}

function oracleCell(
  notes: Readonly<Record<string, Frontmatter>>,
  title: string,
  field: FieldName,
): Cell {
  const note = notes[title] ?? {};
  if (field in OWN) return ownCell(indexablePropertiesOf(note), field, OWN[field as OwnKey]);
  const link = note['project'];
  if (typeof link !== 'string') return null;
  const project = notes[link.slice(2, -2)];
  if (project === undefined) return null;
  return ownCell(indexablePropertiesOf(project), field.split('.')[1] ?? '', HOPS[field as HopKey]);
}

const taskTitles = (notes: Readonly<Record<string, Frontmatter>>) =>
  Object.keys(notes).filter((title) => title.startsWith('Task '));

/** A value as a query writes it, so `field = <it>` asks for that value. */
function literal(kind: string, value: string | number): string {
  if (kind === 'number') return String(value);
  if (kind === 'date') return String(value).slice(0, 10);
  if (kind === 'checkbox') return String(value) === 'true' ? 'true' : 'false';
  return `"${String(value)}"`;
}

const blank = (cell: Cell) => cell === null || cell === '';

/** What `field = value` lists, by the oracle: the held rows, compared as the field compares. */
function oracleEquals(
  notes: Readonly<Record<string, Frontmatter>>,
  title: string,
  field: FieldName,
  value: string | number,
): boolean {
  const kind = kindOf(field);
  const note = notes[title] ?? {};
  let rows = indexablePropertiesOf(note);
  let key: string = field;
  if (!(field in OWN)) {
    const link = note['project'];
    const project = typeof link === 'string' ? notes[link.slice(2, -2)] : undefined;
    if (project === undefined) return false;
    rows = indexablePropertiesOf(project);
    key = field.split('.')[1] ?? '';
  }
  const held = heldRows(rows, key, kind);
  if (kind === 'checkbox') return held.some((row) => row.text === 'true') === (value === 'true');
  return held.some((row) => {
    if (kind === 'number') return row.number === Number(value);
    if (kind === 'date') return row.date?.slice(0, 10) === String(value).slice(0, 10);
    return row.text === String(value);
  });
}

/** Every value a field's cells show across a vault, and a few it may not. */
function candidates(cells: readonly Cell[], field: FieldName): (string | number)[] {
  const kind = kindOf(field);
  const seen = cells.flatMap((cell) =>
    cell === null ? [] : kind === 'multiSelect' ? String(cell).split(', ') : [cell],
  );
  const extra = kind === 'checkbox' ? ['true', 'false'] : ['doing', 'done', '2026-10-02', 3];
  const valid = [...seen, ...extra].filter(
    (value) =>
      String(value) !== '' &&
      (kind !== 'number' || Number.isFinite(Number(value))) &&
      (kind !== 'date' || /^\d{4}-\d{2}-\d{2}/.test(String(value))),
  );
  return [...new Map(valid.map((value) => [literal(kind, value), value])).values()];
}

interface Disagreement {
  readonly seed: number;
  readonly what: string;
  readonly note: Frontmatter | undefined;
  readonly sql: unknown;
  readonly oracle: unknown;
}

function firstCellDisagreement(seed: number, vaults: number, nested: boolean): Disagreement | null {
  const random = rng(seed);
  for (let at = 0; at < vaults; at += 1) {
    const notes = vault(random, nested);
    const database = index(notes);
    const shown = run(database, `FROM task SHOW ${FIELDS.join(', ')}`);
    for (const row of shown) {
      const title = String(row['title']);
      for (const field of FIELDS) {
        const expected = oracleCell(notes, title, field);
        if (row[field] !== expected) {
          return {
            seed,
            what: `${title} ${field}`,
            note: notes[title],
            sql: row[field],
            oracle: expected,
          };
        }
      }
    }
  }
  return null;
}

/** The first query `field = value` (or IS EMPTY) whose listing differs from what the cells say. */
function firstConditionDisagreement(
  seed: number,
  vaults: number,
  nested: boolean,
  against: 'cells' | 'oracle',
): Disagreement | null {
  const random = rng(seed);
  for (let at = 0; at < vaults; at += 1) {
    const notes = vault(random, nested);
    const database = index(notes);
    const shown = run(database, `FROM task SHOW ${FIELDS.join(', ')}`);
    const cells = new Map(shown.map((row) => [String(row['title']), row]));
    for (const field of FIELDS) {
      const kind = kindOf(field);
      const empty = titlesOf(run(database, `FROM task WHERE ${field} IS EMPTY`));
      const blankByCell = taskTitles(notes)
        .filter((title) => {
          const cell = (cells.get(title)?.[field] ?? null) as Cell;
          // A many-valued cell of blank items only (`, `) is reported on its own, below.
          return kind === 'multiSelect' && cell !== null
            ? String(cell)
                .split(', ')
                .every((item) => item.trim() === '')
            : blank(cell);
        })
        .sort();
      if (JSON.stringify(empty) !== JSON.stringify(blankByCell)) {
        return {
          seed,
          what: `${field} IS EMPTY`,
          note: undefined,
          sql: empty,
          oracle: blankByCell,
        };
      }
      const values = candidates(
        shown.map((row) => (row[field] ?? null) as Cell),
        field,
      );
      for (const value of values) {
        const query = `FROM task WHERE ${field} = ${literal(kind, value)}`;
        const listed = titlesOf(run(database, query));
        const expected = taskTitles(notes)
          .filter((title) => {
            if (against === 'oracle') return oracleEquals(notes, title, field, value);
            const cell = (cells.get(title)?.[field] ?? null) as Cell;
            if (kind === 'checkbox') return (cell === 'true') === (value === 'true');
            if (cell === null) return false;
            if (kind === 'multiSelect') return String(cell).split(', ').includes(String(value));
            return literal(kind, cell) === literal(kind, value);
          })
          .sort();
        if (JSON.stringify(listed) !== JSON.stringify(expected)) {
          const differ = [...listed, ...expected].find(
            (title) => listed.includes(title) !== expected.includes(title),
          );
          return {
            seed,
            what: query,
            note: differ === undefined ? undefined : notes[differ],
            sql: listed,
            oracle: expected,
          };
        }
      }
    }
  }
  return null;
}

describe('#616 attack: a cell is the value the rules give, for every kind and hop', () => {
  it('the query cells are the oracle cells over seeded vaults of plain values, lists and blanks', () => {
    expect(JSON.stringify(firstCellDisagreement(616, 40, false))).toBe('null');
  });

  it('a condition lists what the cells say, for every kind and hop (no nested lists)', () => {
    expect(JSON.stringify(firstConditionDisagreement(1616, 25, false, 'cells'))).toBe('null');
  });

  it('a condition lists what the oracle says, for every kind and hop (no nested lists)', () => {
    expect(JSON.stringify(firstConditionDisagreement(2616, 25, false, 'oracle'))).toBe('null');
  });

  // FAILING: a nested list (`status: [[doing, done]]`, which YAML reads from
  // `[[doing, done]]`) is flattened by toIndexableProperties with every inner
  // item at the outer item's idx, so ONLY_ROW (`q.idx <> p.idx`) and
  // FIRST_DATE (`p.idx = MIN(idx)`) see each row as the only / first one.
  it('a condition lists what the cells say, nested lists included', () => {
    expect(JSON.stringify(firstConditionDisagreement(3616, 40, true, 'cells'))).toBe('null');
  });

  it('the query cells are the oracle cells, nested lists included', () => {
    expect(JSON.stringify(firstCellDisagreement(4616, 40, true))).toBe('null');
  });
});

describe('#616 attack: a single value written as a nested list', () => {
  const database = index({
    'Task nested status': { type: 'task', status: [['doing', 'done']] },
    'Task nested due': { type: 'task', due: [['2026-10-01', '2026-10-02']] },
    'Task nested estimate': { type: 'task', estimate: [[1, 2]] },
  });

  it('a select written as [[doing, done]] holds no status, as Today reads it', () => {
    expect(titlesOf(run(database, 'FROM task WHERE status = done'))).toEqual([]);
  });

  it('a date written as [[d1, d2]] holds its first day only', () => {
    expect(titlesOf(run(database, 'FROM task WHERE due = 2026-10-02'))).toEqual([]);
  });

  it('a number written as [[1, 2]] holds no number, as a list of two does', () => {
    expect(titlesOf(run(database, 'FROM task WHERE estimate = 2'))).toEqual([]);
  });
});

describe('#616 attack: a many-valued cell of blank items', () => {
  // FAILING: `labels: ['', '']` is empty to IS EMPTY (presentValue) but its
  // cell is group_concat of two blanks, ", " — a cell that shows something
  // for a field the conditions call empty.
  it('shows no value when IS EMPTY calls the field empty', () => {
    const database = index({ 'Task blank labels': { type: 'task', labels: ['', ''] } });
    expect(titlesOf(run(database, 'FROM task WHERE labels IS EMPTY'))).toEqual([
      'Task blank labels',
    ]);
    const [row] = run(database, 'FROM task SHOW labels');
    expect(blank((row?.['labels'] ?? null) as Cell)).toBe(true);
  });
});

describe("#616 attack: a type's view holds each note as the query's cells do", () => {
  const VIEW_COLUMNS = [
    { key: 'status', kind: 'select', many: false },
    { key: 'due', kind: 'date', many: false },
    { key: 'estimate', kind: 'number', many: false },
    { key: 'notes', kind: 'text', many: false },
    { key: 'flagged', kind: 'checkbox', many: false },
    { key: 'labels', kind: 'multiSelect', many: false },
    { key: 'project', kind: 'relation', many: false },
  ];

  it('every v_task cell is the FROM task cell, and v_task lists the notes FROM task does (seeded)', () => {
    const random = rng(5616);
    for (let at = 0; at < 40; at += 1) {
      const notes = vault(random, false);
      const database = index(notes);
      const select = typeViewSelectSql({ name: 'task', columns: VIEW_COLUMNS, progress: false });
      database.exec(`CREATE VIEW "v_task" AS ${select ?? ''};`);
      const keys = VIEW_COLUMNS.map((column) => column.key);
      const table = database.prepare(`SELECT * FROM v_task ORDER BY path`).all();
      const query = run(database, `FROM task SHOW ${keys.join(', ')}`).sort((left, right) =>
        String(left['path']).localeCompare(String(right['path'])),
      );
      expect(table.map((row) => row['path'])).toEqual(query.map((row) => row['path']));
      for (const [place, row] of table.entries()) {
        for (const key of keys)
          expect([row['path'], key, row[key]]).toEqual([row['path'], key, query[place]?.[key]]);
      }
    }
  });
});

describe('#616 attack: GROUP BY type groups the notes FROM finds as one type', () => {
  // FROM task now lists `type: Task` and `type: TASK` too, and the leading
  // `type` column names each note's type as it writes it — so GROUP BY type
  // (groupKeyOf: trimmed, composed, case kept) splits one type into three.
  it('FROM task GROUP BY type is one group, however the notes spell task', () => {
    const database = index({
      'Task lower': { type: 'task' },
      'Task capital': { type: 'Task' },
      'Task upper': { type: ' TASK ' },
    });
    const compiled = compileAtlasQuery(parseAtlasQuery('FROM task GROUP BY type'), {
      types: QUERY_TEST_TYPES,
      resolveLink: () => null,
    });
    const rows = database.prepare(compiled.sql).all(...(compiled.parameters as never[])) as Record<
      string,
      unknown
    >[];
    const groups = groupResultRows({
      rows: rows.map((row) => ({
        path: String(row['path']),
        title: String(row['title']),
        values: row,
      })),
      groups: compiled.groups,
    });
    expect(groups.map((group) => [group.label, group.rows.length])).toHaveLength(1);
  });
});

describe('#616 attack: Today and FROM task read a status alike', () => {
  // Today's open tasks (compileReviewTasksQuery) leave out a task with an
  // `archive` row anywhere in its status. FROM task now reads `status:
  // [archive, next-action]` as no status (ONLY_ROW), so `status != archive`
  // lists it: on main both said "finished".
  const GTD_TYPES = [
    parseObjectType({
      name: 'task',
      label: 'Task',
      properties: {
        status: { kind: 'select', options: [...GTD_STATUSES] },
        due: 'date',
        defer: 'date',
      },
    }),
  ];

  function gtdRun(database: DatabaseSync, text: string): string[] {
    const compiled = compileAtlasQuery(parseAtlasQuery(text), {
      types: GTD_TYPES,
      resolveLink: () => null,
    });
    return titlesOf(
      database.prepare(compiled.sql).all(...(compiled.parameters as never[])) as Record<
        string,
        unknown
      >[],
    );
  }

  function todayOpen(database: DatabaseSync): string[] {
    const { sql, parameters } = compileReviewTasksQuery();
    return titlesOf(
      database.prepare(sql).all(...(parameters as never[])) as Record<string, unknown>[],
    );
  }

  it("Today's open tasks are the tasks FROM task lists as not archived (seeded)", () => {
    const random = rng(6616);
    const statusPool = ['archive', 'next-action', 'inbox', '', null, 'Archive'];
    for (let at = 0; at < 30; at += 1) {
      const notes: Record<string, Frontmatter> = {};
      for (let task = 0; task < 8; task += 1) {
        const shape = random();
        const status =
          shape < 0.2
            ? undefined
            : shape < 0.6
              ? pick(random, statusPool)
              : [pick(random, statusPool), pick(random, statusPool)];
        notes[`Task ${task}`] = {
          type: pick(random, ['task', 'Task']),
          ...(status === undefined ? {} : { status }),
        };
      }
      const database = index(notes);
      expect([at, gtdRun(database, 'FROM task WHERE status != archive')]).toEqual([
        at,
        todayOpen(database),
      ]);
    }
  });

  it('a task whose status lists archive and next-action is finished to both', () => {
    const database = index({ 'Task listed': { type: 'task', status: ['archive', 'next-action'] } });
    expect(todayOpen(database)).toEqual([]);
    expect(gtdRun(database, 'FROM task WHERE status != archive')).toEqual(todayOpen(database));
  });

  it("Today's status, due and defer for a task are the cells FROM task shows (seeded)", () => {
    const random = rng(7616);
    const pool = [
      'next-action',
      'inbox',
      'waiting',
      '',
      null,
      'TBD',
      '2026-10-01',
      '2026-02-30',
      '2026-10-02 09:00',
    ];
    for (let at = 0; at < 30; at += 1) {
      const notes: Record<string, Frontmatter> = {};
      for (let task = 0; task < 8; task += 1) {
        const note: Record<string, unknown> = { type: 'task' };
        for (const key of ['status', 'due', 'defer']) {
          const shape = random();
          if (shape < 0.2) continue;
          note[key] = shape < 0.6 ? pick(random, pool) : [pick(random, pool), pick(random, pool)];
        }
        notes[`Task ${task}`] = note;
      }
      const database = index(notes);
      const { sql, parameters } = compileReviewTasksQuery();
      const today = new Map(
        (database.prepare(sql).all(...(parameters as never[])) as Record<string, unknown>[]).map(
          (row) => [String(row['title']), row],
        ),
      );
      const compiled = compileAtlasQuery(parseAtlasQuery('FROM task SHOW status, due, defer'), {
        types: GTD_TYPES,
        resolveLink: () => null,
      });
      const query = database
        .prepare(compiled.sql)
        .all(...(compiled.parameters as never[])) as Record<string, unknown>[];
      for (const row of query) {
        const read = today.get(String(row['title']));
        if (read === undefined) continue;
        const day = (value: unknown) => (typeof value === 'string' ? value.slice(0, 10) : null);
        expect([row['title'], row['status'], day(row['due']), day(row['defer'])]).toEqual([
          row['title'],
          read['status'],
          read['due'],
          read['defer'],
        ]);
      }
    }
  });
});

describe('#616 attack: every read of a type folds it alike', () => {
  const MIXED: Readonly<Record<string, Frontmatter>> = {
    'Task lower': { type: 'task', para: 'area' },
    'Task capital': { type: 'Task', para: 'area' },
    'Task upper': { type: ' TASK ', para: 'area' },
    'Task listed': { type: ['task', 'project'], para: 'area' },
    'Task twice': { type: ['task', 'Task'], para: 'area' },
    'Not a task': { type: 'tasks', para: 'area' },
  };

  it('the sidebar counts, the PARA picker and type = task find the notes FROM task lists', () => {
    const database = index(MIXED);
    const from = titlesOf(run(database, 'FROM task'));
    expect(from).toHaveLength(5);
    const counts = compileTypeCountsQuery(['task', 'Task']);
    const counted = database.prepare(counts.sql).all(...(counts.parameters as never[]));
    expect(counted).toEqual([{ type: 'task', count: from.length }]);
    const para = compileParaValuesQuery('Task');
    const picked = database.prepare(para.sql).all(...(para.parameters as never[])) as Record<
      string,
      unknown
    >[];
    expect(picked.map((row) => String(row['path']).replace(/^Tasks\/|\.md$/g, '')).sort()).toEqual(
      from,
    );
    expect(titlesOf(run(database, 'FROM task, project WHERE type = task'))).toEqual(from);
  });

  it('FROM task, project lists a note of both types once', () => {
    const database = index(MIXED);
    expect(
      titlesOf(run(database, 'FROM task, project')).filter((title) => title === 'Task listed'),
    ).toHaveLength(1);
  });
});
