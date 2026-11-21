import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { carriesChecklistProgress } from '../checklists/progress-field.ts';
import { indexablePropertiesOf } from '../index/property-value.ts';
import { holdsMany, shownValue } from '../query-language/field-sql.ts';
import type { FieldKind, QueryField } from '../query-language/fields.ts';
import {
  typeViewSelectSql,
  type TypeViewColumn,
  type TypeViewSpec,
} from '../query-language/type-view.ts';
import { foldedTypeName, foldedTypeSql } from '../types/note-type-sql.ts';
import { isViewColumn } from '../types/type-name.ts';
import { parseObjectType, type ObjectType } from '../types/property-def.ts';
import type { AggregateKind } from './aggregate.ts';
import {
  compileViewQuery,
  type FilterOperator,
  type QueryFilter,
  type QueryShape,
  type ViewQuery,
} from './view-query.ts';

/**
 * #919 changed the SQL of every type's table: the view reads each cell by its
 * own lookup instead of one grouped pass, and a page of rows chooses its notes
 * before it reads their cells. Neither may change an answer. Here main's SQL
 * (the grouped view, the one-pass page) and the new SQL run over one seeded
 * vault of five types, and every query — each type, sorts on every column both
 * ways, filters of every operator, limits, counts, charts, aggregates — must
 * come back with the same rows in the same order, ties included.
 */

const root = new URL('../../../../', import.meta.url);
const SCHEMA = readFileSync(new URL('apps/desktop/src-tauri/src/index_schema.sql', root), 'utf8');

// ---- main's SQL, at 61663aa0, kept to compare against --------------------

/** main's `typeViewSelectSql`: one grouped pass over every row of the type's notes. */
function mainTypeViewSelectSql(spec: TypeViewSpec): string {
  const HELD = "COALESCE(p.value_text, p.value_json, '') <> ''";
  const ORDERED = '(p.idx * 4294967296 + p.rowid + 1000000000000000000)';
  const columnSql = (column: TypeViewColumn): string => {
    const kind = column.kind as FieldKind;
    const field: QueryField = {
      text: column.key,
      label: column.key,
      via: null,
      key: column.key,
      kind,
      options: [],
      target: null,
      many: column.many || kind === 'multiSelect',
    };
    const held = `p.key = '${column.key}'`;
    const value = shownValue(field);
    if (field.many)
      return `group_concat(CASE WHEN ${held} THEN ${value} END, ', ' ORDER BY p.idx, p.rowid)`;
    if (holdsMany(field) || field.kind === 'date') {
      const dated = field.kind === 'date' ? ' AND p.value_date IS NOT NULL' : '';
      return `substr(min(CASE WHEN ${held}${dated} THEN ${ORDERED} || ${value} END), 20)`;
    }
    return `CASE WHEN count(CASE WHEN ${held} THEN 1 END) = 1 THEN max(CASE WHEN ${held} THEN ${value} END) END`;
  };
  const progress = spec.progress ? ', n.progress AS "progress"' : '';
  const columns = spec.columns
    .map((column) => `, ${columnSql(column)} AS "${column.key}"`)
    .join('');
  return [
    'SELECT n.path AS "path",',
    `       COALESCE(MAX(CASE WHEN p.key = 'title' THEN p.value_text END), n.title) AS "title",`,
    '       n.summary AS "summary",',
    `       n.modified AS "modified"${progress}${columns}`,
    `FROM files AS n JOIN props AS p ON p.path = n.path AND ${HELD}`,
    `WHERE n.path IN (SELECT path FROM props WHERE key = 'type' AND ${foldedTypeSql('value_text')} = '${foldedTypeName(spec.name)}')`,
    'GROUP BY n.path',
  ].join('\n');
}

const PAGE_FIRST =
  /^(SELECT [^\n]*)\nFROM ("v_\w+")\nWHERE "path" IN \(SELECT "path" FROM \2 (WHERE [^\n]*)\n {2}(ORDER BY [^\n]*)\n {2}LIMIT \?\)\n\4$/;

/** main's page of rows: the new statement's own parts in one pass, as main wrote them. */
function mainRowSql(sql: string): string {
  const parts = PAGE_FIRST.exec(sql);
  if (parts === null) return sql; // counts, charts and aggregates were never changed
  const [, select, table, where, order] = parts;
  return [select, `FROM ${table}`, where, order, 'LIMIT ?'].join('\n');
}

// ---- a seeded vault -------------------------------------------------------

/** A small deterministic generator (mulberry32), so a failure is the same failure. */
function seeded(seed: number) {
  let state = seed;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const below = (n: number) => Math.floor(next() * n);
  const pick = <T>(items: readonly T[]): T => items[below(items.length)] as T;
  return { next, below, pick };
}

const SEED = 919;

const TYPES: ObjectType[] = [
  parseObjectType({
    name: 'meeting',
    properties: {
      date: 'date',
      start: 'text',
      kind: 'text',
      people: { kind: 'relation', target: 'person', many: true },
      project: { kind: 'relation', target: 'project' },
      attendees: { kind: 'text', many: true },
      rating: { kind: 'select', options: ['good', 'poor'] },
      topics: { kind: 'multiSelect', options: ['payroll', 'hiring'] },
      score: 'number',
    },
  }),
  parseObjectType({
    name: 'task',
    properties: {
      status: { kind: 'select', options: ['next', 'waiting', 'done'] },
      due: 'date',
      project: { kind: 'relation', target: 'project' },
      tags: { kind: 'multiSelect', options: [] },
      estimate: 'number',
    },
  }),
  parseObjectType({
    name: 'person',
    properties: {
      email: 'text',
      company: { kind: 'relation', target: 'company' },
      role: { kind: 'select', options: ['lead', 'peer'] },
    },
  }),
  parseObjectType({
    name: 'project',
    properties: {
      status: { kind: 'select', options: ['doing', 'done'] },
      para: { kind: 'select', options: ['project', 'area', 'archive'] },
      due: 'date',
    },
  }),
  parseObjectType({
    name: 'one_on_one',
    properties: {
      person: { kind: 'relation', target: 'person' },
      date: 'date',
      notes: 'text',
      progress: 'number',
    },
  }),
];

const specOf = (type: ObjectType): TypeViewSpec => ({
  name: type.name,
  columns: type.properties
    .filter((property) => !isViewColumn(property.key))
    .map((property) => ({ key: property.key, kind: property.kind, many: property.many })),
  progress: carriesChecklistProgress(type),
});

const PEOPLE = ['Mara Quill', 'Tobias Fenn', 'Iris Vale', 'Owen Marsh'];
const PROJECTS = ['Larkspur launch', 'Payroll audit'];
const TITLES = ['Weekly sync', 'Larkspur Payroll review', '1:1', 'Planning', 'weekly sync'];
const FOLDERS = ['', 'Inbox/', 'Archive/', '.atlas/', 'work/', 'archive/old/'];

type Rng = ReturnType<typeof seeded>;

/** A value of a property, of the many shapes a hand-written note gives one. */
function valueOf(rng: Rng, kind: string, many: boolean): unknown {
  const one = (): unknown => {
    switch (kind) {
      case 'date':
        return rng.pick([
          `2026-0${1 + rng.below(9)}-1${rng.below(10)}`,
          `2026-03-0${1 + rng.below(9)} 0${rng.below(10)}:30`,
          'soon',
          '2026-02-30',
          '',
        ]);
      case 'number':
        return rng.pick([rng.below(20), rng.below(20) / 4, '7', -3, 'many', null]);
      case 'relation':
        return rng.pick(
          [...PEOPLE, ...PROJECTS].map((name) => `[[${name}]]`).concat(['', 'Nobody']),
        );
      default:
        return rng.pick([
          'next',
          'done',
          'good',
          'payroll',
          'hiring',
          'Standup',
          '',
          ' ',
          'a, b',
          '09:30',
          null,
        ]);
    }
  };
  if (many || rng.next() < 0.1) {
    const count = rng.below(4);
    if (count === 0 && rng.next() < 0.5) return [];
    return Array.from({ length: Math.max(count, 1) }, () =>
      rng.next() < 0.1 ? { name: rng.pick(PEOPLE) } : one(),
    );
  }
  return one();
}

function typeValue(rng: Rng, name: string): unknown {
  return rng.pick<unknown>([name, name, name.toUpperCase(), ` ${name} `, [name, 'other'], [name]]);
}

interface Note {
  readonly path: string;
  readonly title: string;
  readonly modified: number;
  readonly frontmatter: Record<string, unknown>;
}

function vaultNotes(seed: number): Note[] {
  const rng = seeded(seed);
  const notes: Note[] = [];
  for (let at = 0; at < 600; at += 1) {
    const type = rng.pick(TYPES);
    const title = rng.pick(TITLES);
    const frontmatter: Record<string, unknown> = { type: typeValue(rng, type.name) };
    const titled = rng.next();
    if (titled < 0.6) frontmatter['title'] = rng.next() < 0.5 ? title : `${title} ${at % 7}`;
    else if (titled < 0.7) frontmatter['title'] = '';
    else if (titled < 0.75) frontmatter['title'] = [title, 'second'];
    for (const property of type.properties) {
      if (rng.next() < 0.75) frontmatter[property.key] = valueOf(rng, property.kind, property.many);
    }
    if (rng.next() < 0.3) frontmatter['undeclared'] = valueOf(rng, 'text', true);
    notes.push({
      path: `${rng.pick(FOLDERS)}${title} ${at}.md`,
      title: rng.next() < 0.1 ? '' : `${title} file`,
      modified: 1_790_000_000_000 + rng.below(50) * 1000,
      frontmatter,
    });
  }
  // A note with no frontmatter but a type, and one typed twice the same way.
  notes.push({ path: 'bare.md', title: 'Bare', modified: 1, frontmatter: { type: 'task' } });
  return notes;
}

function vaultIndex(notes: readonly Note[], view: (spec: TypeViewSpec) => string | null) {
  const database = new DatabaseSync(':memory:');
  database.exec(SCHEMA);
  const file = database.prepare(
    'INSERT INTO files (path, title, summary, modified, size, progress) VALUES (?, ?, ?, ?, 0, ?)',
  );
  const prop = database.prepare(
    'INSERT INTO props (path, key, idx, value_text, value_num, value_date, value_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const relation = database.prepare(
    'INSERT INTO relations (src, key, idx, target, name, dst) VALUES (?, ?, ?, ?, ?, ?)',
  );
  notes.forEach((note, at) => {
    file.run(
      note.path,
      note.title,
      `About ${at % 5}`,
      note.modified,
      at % 3 === 0 ? null : at % 101,
    );
    for (const row of indexablePropertiesOf(note.frontmatter)) {
      prop.run(note.path, row.key, row.index, row.text, row.number, row.date, row.json);
      const linked = /^\[\[(.+)\]\]$/.exec(row.text ?? '');
      if (linked?.[1] !== undefined) {
        const target = linked[1];
        relation.run(note.path, row.key, row.index, target, target.toLowerCase(), `${target}.md`);
      }
    }
  });
  for (const type of TYPES) {
    const select = view(specOf(type));
    if (select !== null) database.exec(`CREATE VIEW "v_${type.name}" AS\n${select}`);
  }
  return database;
}

// ---- the queries ----------------------------------------------------------

const OPERATORS: readonly FilterOperator[] = [
  'is',
  'isNot',
  'contains',
  'startsWith',
  'greaterThan',
  'lessThan',
  'isEmpty',
  'isNotEmpty',
];
const FILTER_VALUES = [
  'next',
  'done',
  '2026-03-01',
  '5',
  'a',
  '',
  '[[Mara Quill]]',
  '[[Larkspur launch]]',
  'Weekly',
];
const AGGREGATES: readonly AggregateKind[] = ['count', 'sum', 'average', 'earliest', 'latest'];

interface Case {
  readonly name: string;
  readonly query: ViewQuery;
  readonly shape: QueryShape;
  readonly includeArchived: boolean;
}

function cases(seed: number): Case[] {
  const rng = seeded(seed + 1);
  const found: Case[] = [];
  for (const type of TYPES) {
    const keys = ['title', 'modified', 'summary', 'path', ...type.properties.map((p) => p.key)];
    const base: ViewQuery = {
      type: type.name,
      columns: type.properties.map((property) => property.key),
      filters: [],
      sorts: [{ key: 'title', direction: 'asc' }],
      limit: 500,
    };
    const add = (name: string, query: ViewQuery, shape: QueryShape = {}) => {
      found.push({ name: `${type.name}: ${name}`, query, shape, includeArchived: false });
      found.push({
        name: `${type.name}: ${name}, archived too`,
        query,
        shape,
        includeArchived: true,
      });
    };
    add('its table', base);
    add('no sort', { ...base, sorts: [] });
    for (const key of keys) {
      for (const direction of ['asc', 'desc'] as const) {
        for (const limit of [1, 3, 17, 500]) {
          add(`by ${key} ${direction}, ${limit}`, { ...base, sorts: [{ key, direction }], limit });
        }
      }
      add(`grouped by ${key}`, base, { groupBy: key });
      for (const kind of AGGREGATES)
        add(`${kind} of ${key}`, base, { aggregate: { kind, column: key } });
    }
    for (let at = 0; at < 60; at += 1) {
      const filters: QueryFilter[] = Array.from({ length: 1 + rng.below(2) }, () => ({
        key: rng.pick(keys),
        operator: rng.pick(OPERATORS),
        value: rng.pick(FILTER_VALUES),
      }));
      const sorts = Array.from({ length: rng.below(3) }, () => ({
        key: rng.pick(keys),
        direction: rng.pick(['asc', 'desc'] as const),
      }));
      const columns = keys.filter(() => rng.next() < 0.5);
      const query = { ...base, columns, filters, sorts, limit: rng.pick([1, 5, 40, 500, 0]) };
      add(`filtered ${at}`, query);
      add(`filtered ${at}, counted`, query, { aggregate: { kind: 'count', column: null } });
    }
  }
  return found;
}

/** Where a link resolves, as the app's note names would: a known person or project, else nowhere. */
const resolveLink = (target: string) =>
  [...PEOPLE, ...PROJECTS].includes(target) ? `${target}.md` : null;

function answer(database: DatabaseSync, sql: string, parameters: readonly (string | number)[]) {
  const statement = database.prepare(sql);
  statement.setReturnArrays(true);
  return {
    columns: statement.columns().map((column) => column.name),
    rows: statement.all(...parameters),
  };
}

describe('a type table answers as it did before #919', () => {
  const notes = vaultNotes(SEED);
  const before = vaultIndex(notes, mainTypeViewSelectSql);
  const after = vaultIndex(notes, typeViewSelectSql);
  const all = cases(SEED);

  it('unwraps the new page into exactly the statement main wrote', () => {
    const { sql } = compileViewQuery({
      type: 'task',
      columns: ['status'],
      filters: [{ key: 'status', operator: 'is', value: 'next' }],
      sorts: [{ key: 'due', direction: 'desc' }],
      limit: 10,
    });
    expect(mainRowSql(sql)).toBe(
      [
        'SELECT "path", "title", "status"',
        'FROM "v_task"',
        `WHERE substr("path", 1, 7) <> '.atlas/' AND lower(substr("path", 1, 8)) <> 'archive/' AND "status" IS ?`,
        'ORDER BY "due" DESC, "path" ASC',
        'LIMIT ?',
      ].join('\n'),
    );
  });

  it(`holds ${all.length} queries over ${notes.length} notes of ${TYPES.length} types (seed ${SEED})`, () => {
    let rowsCompared = 0;
    let different = 0;
    for (const { name, query, shape, includeArchived } of all) {
      const { sql, parameters } = compileViewQuery(query, shape, { includeArchived, resolveLink });
      const was = answer(before, mainRowSql(sql), parameters);
      const now = answer(after, sql, parameters);
      rowsCompared += now.rows.length;
      if (JSON.stringify(now) !== JSON.stringify(was)) {
        different += 1;
        expect({ name, ...now }).toEqual({ name, ...was });
      }
    }
    expect(different).toBe(0);
    // The vault is not so sparse that the queries compare nothing.
    expect(rowsCompared).toBeGreaterThan(20_000);
  }, 120_000);

  it('the whole view, every row and column, is the same', () => {
    for (const type of TYPES) {
      const sql = `SELECT * FROM "v_${type.name}" ORDER BY "path"`;
      const was = answer(before, sql, []);
      expect(was.rows.length).toBeGreaterThan(50);
      expect(answer(after, sql, [])).toEqual(was);
    }
  });
});
