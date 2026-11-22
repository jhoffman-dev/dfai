import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { carriesChecklistProgress } from '../checklists/progress-field.ts';
import { indexablePropertiesOf } from '../index/property-value.ts';
import { holdsMany, shownValue } from '../query-language/field-sql.ts';
import type { FieldKind, QueryField } from '../query-language/fields.ts';
import {
  typeViewColumns,
  typeViewSelectSql,
  type TypeViewColumn,
  type TypeViewSpec,
} from '../query-language/type-view.ts';
import { foldedTypeName, foldedTypeSql } from '../types/note-type-sql.ts';
import { parseObjectType, type ObjectType } from '../types/property-def.ts';
import {
  compileViewQuery,
  FILTER_OPERATORS,
  type QueryFilter,
  type QuerySort,
  type ViewQuery,
} from './view-query.ts';
import { listColumnOf } from './list-filter.ts';
import { mainCompileViewQuery } from './main-view-query.test-support.ts';

/**
 * #923 answers a filter on a list of text from the list's items in the index
 * (`list-filter.ts`) and reads a list's cell from its items alone. Neither may
 * change an answer. Here main's SQL — the view as #921 wrote it and main's
 * compile, both frozen copies — and the new SQL run over one seeded vault of
 * hostile lists, and every query must come back with the same columns and
 * rows in the same order, ties included. One difference is deliberate and
 * tested on its own (`list-filter.attack-929.sqlite.test.ts`): an item holding
 * a NUL character, which this vault leaves out.
 */

const root = new URL('../../../../', import.meta.url);
const SCHEMA = readFileSync(new URL('apps/desktop/src-tauri/src/index_schema.sql', root), 'utf8');

// ---- main's view, at d87cd3ed, kept to compare against --------------------

/** main's `typeViewSelectSql` (#921): each cell its own lookup, a list joined from its held rows. */
function mainTypeViewSelectSql(spec: TypeViewSpec): string {
  const HELD = "COALESCE(p.value_text, p.value_json, '') <> ''";
  const ORDERED = '(p.idx * 4294967296 + p.rowid + 1000000000000000000)';
  const cellSql = (key: string, aggregate: string) =>
    `(SELECT ${aggregate} FROM props AS p WHERE p.path = n.path AND p.key = '${key}' AND ${HELD})`;
  const aggregateOf = (column: TypeViewColumn): string => {
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
    .filter((column) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(column.key))
    .map((column) => `, ${cellSql(column.key, aggregateOf(column))} AS "${column.key}"`)
    .join('');
  return [
    'SELECT n.path AS "path",',
    `       COALESCE(${cellSql('title', "MAX(CASE WHEN p.key = 'title' THEN p.value_text END)")}, n.title) AS "title",`,
    '       n.summary AS "summary",',
    `       n.modified AS "modified"${progress}${columns}`,
    'FROM files AS n',
    `WHERE n.path IN (SELECT path FROM props WHERE key = 'type' AND ${foldedTypeSql('value_text')} = '${foldedTypeName(spec.name)}')`,
  ].join('\n');
}

// ---- a seeded vault of hostile lists ----------------------------------------

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

type Rng = ReturnType<typeof seeded>;

const SEED = 923;
const NOTES = 5_200;

const TYPES: ObjectType[] = [
  parseObjectType({
    name: 'meeting',
    properties: {
      date: 'date',
      kind: 'text',
      people: { kind: 'relation', target: 'person', many: true },
      project: { kind: 'relation', target: 'project' },
      attendees: { kind: 'text', many: true },
      topics: { kind: 'multiSelect', options: ['payroll', 'hiring'] },
      tags: { kind: 'multiSelect', options: [] },
      rating: { kind: 'select', options: ['good', 'poor'] },
      scores: { kind: 'number', many: true },
      days: { kind: 'date', many: true },
      score: 'number',
    },
  }),
  parseObjectType({
    name: 'task',
    properties: {
      status: { kind: 'select', options: ['next', 'waiting', 'done'] },
      due: 'date',
      tags: { kind: 'multiSelect', options: [] },
      labels: { kind: 'text', many: true },
      owners: { kind: 'relation', target: 'person', many: true },
    },
  }),
  parseObjectType({
    name: 'person',
    properties: {
      email: 'text',
      aliases: { kind: 'text', many: true },
      company: { kind: 'relation', target: 'company' },
    },
  }),
  parseObjectType({
    name: 'project',
    properties: {
      status: { kind: 'select', options: ['doing', 'done'] },
      para: { kind: 'select', options: ['project', 'area', 'archive'] },
      members: { kind: 'relation', target: 'person', many: true },
    },
  }),
];

const specOf = (type: ObjectType): TypeViewSpec => ({
  name: type.name,
  columns: typeViewColumns(type),
  progress: carriesChecklistProgress(type),
});

const PEOPLE = ['Mara Quill', 'Tobias Fenn', 'Iris Vale'];

/** Items a list is made of: separators inside values, case and space variants, wildcards, numbers and dates as text. */
const ITEMS: readonly unknown[] = [
  'Mara Quill',
  'mara quill',
  ' Mara Quill ',
  '[[Mara Quill]]',
  '[[mara quill]]',
  '[[Tobias Fenn]]',
  '[[Iris Vale]]',
  'a',
  'A',
  'b',
  'a, b',
  'a,b',
  ', b',
  'b,',
  ' b',
  'a b',
  '',
  ' ',
  null,
  '5',
  5,
  5.5,
  '2026-03-01',
  '2026-03-01 09:30',
  'x%y',
  'x_y',
  '%',
  '_',
  'Errand',
  '#errand',
  'ERRAND',
  'payroll',
  'next',
  true,
];

function itemOf(rng: Rng): unknown {
  const roll = rng.next();
  if (roll < 0.05) return { name: rng.pick(PEOPLE) };
  if (roll < 0.08) return [rng.pick(ITEMS), rng.pick(ITEMS)];
  return rng.pick(ITEMS);
}

/** A list, or now and then one value where a list belongs. Duplicates come of the small pool. */
function listOf(rng: Rng): unknown {
  if (rng.next() < 0.1) return itemOf(rng);
  const count = rng.below(6);
  const items = Array.from({ length: count }, () => itemOf(rng));
  if (count > 0 && rng.next() < 0.2) items.push(items[0]);
  return items;
}

function valueOf(rng: Rng, kind: string, many: boolean): unknown {
  if (many || kind === 'multiSelect') return listOf(rng);
  if (rng.next() < 0.1) return listOf(rng);
  if (kind === 'date') return rng.pick(['2026-03-01', '2026-03-02 09:30', 'soon', '']);
  if (kind === 'number') return rng.pick([3, 4.5, '7', 'many', null]);
  return rng.pick(ITEMS);
}

const FOLDERS = ['', 'Inbox/', 'Archive/', '.atlas/', 'work/'];

interface Note {
  readonly path: string;
  readonly title: string;
  readonly frontmatter: Record<string, unknown>;
}

function vaultNotes(seed: number): Note[] {
  const rng = seeded(seed);
  return Array.from({ length: NOTES }, (_, at) => {
    const type = rng.pick(TYPES);
    const frontmatter: Record<string, unknown> = {
      type: rng.pick([type.name, type.name.toUpperCase(), ` ${type.name} `]),
    };
    // Some notes hold nothing but their type.
    if (rng.next() < 0.9) {
      for (const property of type.properties) {
        if (rng.next() < 0.7)
          frontmatter[property.key] = valueOf(rng, property.kind, property.many);
      }
    }
    // A key that differs only in case is another key, never the declared one.
    if (rng.next() < 0.15) frontmatter['People'] = listOf(rng);
    if (rng.next() < 0.1) frontmatter['Tags'] = listOf(rng);
    if (rng.next() < 0.5) frontmatter['title'] = rng.pick(['Weekly sync', 'weekly sync', '']);
    return {
      path: `${rng.pick(FOLDERS)}${type.name} ${at}.md`,
      title: `Note ${at % 37}`,
      frontmatter,
    };
  });
}

function vaultIndex(notes: readonly Note[], view: (spec: TypeViewSpec) => string | null) {
  const database = new DatabaseSync(':memory:');
  database.exec(SCHEMA);
  const file = database.prepare(
    'INSERT INTO files (path, title, summary, modified, size) VALUES (?, ?, ?, ?, 0)',
  );
  const prop = database.prepare(
    'INSERT INTO props (path, key, idx, value_text, value_num, value_date, value_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const relation = database.prepare(
    'INSERT INTO relations (src, key, idx, target, name, dst) VALUES (?, ?, ?, ?, ?, ?)',
  );
  database.exec('BEGIN');
  notes.forEach((note, at) => {
    file.run(note.path, note.title, `About ${at % 5}`, 1_790_000_000_000 + (at % 50));
    for (const row of indexablePropertiesOf(note.frontmatter)) {
      prop.run(note.path, row.key, row.index, row.text, row.number, row.date, row.json);
      const linked = /^\[\[(.+)\]\]$/.exec(row.text ?? '');
      if (linked?.[1] !== undefined) {
        const target = linked[1];
        relation.run(note.path, row.key, row.index, target, target.toLowerCase(), `${target}.md`);
      }
    }
  });
  // Rows no writer makes today (property-value.ts never sets text beside
  // json): main's held rule and the item rule must still pick the same items.
  notes.forEach((note, at) => {
    if (at % 9 !== 0) return;
    for (const key of ['people', 'attendees', 'tags', 'labels', 'aliases', 'members']) {
      prop.run(note.path, key, 7, '', null, null, '{"name":"Mara Quill"}');
      prop.run(note.path, key, 8, 'Mara Quill', null, null, '{"name":"Mara Quill"}');
    }
  });
  database.exec('COMMIT');
  for (const type of TYPES) {
    const select = view(specOf(type));
    if (select !== null) database.exec(`CREATE VIEW "v_${type.name}" AS\n${select}`);
  }
  database.exec('ANALYZE');
  return database;
}

// ---- the queries ----------------------------------------------------------

const FILTER_VALUES: readonly (string | number | boolean)[] = [
  ...ITEMS.filter((item): item is string | number | boolean => item !== null),
  'mara',
  'MARA QUILL',
  'Quill]]',
  ']], [[',
  'Quill, ',
  'Quill]], [[Tobias',
  'b, a',
  'a, b, a',
  'Mara Quill, Mara Quill',
  '@today',
  '#Errand',
  ' errand ',
  'payroll, hiring',
  0,
  false,
];

const LIMITS = [1, 3, 17, 500, 5_000];

interface Case {
  readonly name: string;
  readonly query: ViewQuery;
  readonly includeArchived: boolean;
  readonly linked: boolean;
}

/** Keys a filter names: every column of each kind, a list named in another case, the view's own, one undeclared. */
function keysOf(type: ObjectType): string[] {
  const declared = type.properties.map((property) => property.key);
  const variants = declared
    .filter((key) => key === 'people' || key === 'tags' || key === 'labels')
    .map((key) => key.toUpperCase());
  return ['title', 'path', 'summary', 'modified', ...declared, ...variants, 'undeclared'];
}

function sortsOf(rng: Rng, keys: readonly string[]): QuerySort[] {
  return Array.from({ length: rng.below(3) }, () => ({
    key: rng.pick(keys),
    direction: rng.pick(['asc', 'desc'] as const),
  }));
}

function cases(seed: number): Case[] {
  const rng = seeded(seed + 1);
  const found: Case[] = [];
  for (const type of TYPES) {
    const keys = keysOf(type);
    const sortable = keys.filter((key) => key !== 'undeclared');
    const base: ViewQuery = {
      type: type.name,
      columns: type.properties.map((property) => property.key),
      filters: [],
      sorts: [],
      limit: 500,
    };
    const add = (name: string, query: ViewQuery) =>
      found.push({
        name: `${type.name}: ${name}`,
        query,
        includeArchived: rng.next() < 0.3,
        linked: rng.next() < 0.5,
      });
    // Every operator on every key, with every value.
    for (const key of keys) {
      // Every value on a list of text, which #923 changed; a sample on the rest, which it did not.
      const asked =
        listColumnOf(key, typeViewColumns(type)) === null
          ? FILTER_VALUES.filter((_, at) => at % 4 === 0)
          : FILTER_VALUES;
      for (const operator of FILTER_OPERATORS) {
        const values = operator === 'isEmpty' || operator === 'isNotEmpty' ? [null] : asked;
        for (const value of values) {
          const filter: QueryFilter = value === null ? { key, operator } : { key, operator, value };
          add(`${key} ${operator} ${JSON.stringify(value)}`, {
            ...base,
            filters: [filter],
            sorts: sortsOf(rng, sortable),
            limit: rng.pick(LIMITS),
          });
        }
      }
    }
    // Two or three filters at once, sorted by lists and limited.
    for (let at = 0; at < 400; at += 1) {
      const filters = Array.from({ length: 2 + rng.below(2) }, (): QueryFilter => {
        const operator = rng.pick(FILTER_OPERATORS);
        const key = rng.pick(keys.filter((candidate) => candidate !== 'undeclared'));
        return operator === 'isEmpty' || operator === 'isNotEmpty'
          ? { key, operator }
          : { key, operator, value: rng.pick(FILTER_VALUES) };
      });
      const columns = type.properties.map((p) => p.key).filter(() => rng.next() < 0.6);
      add(`combined ${at}`, {
        ...base,
        columns,
        filters,
        sorts: sortsOf(rng, sortable),
        limit: rng.pick(LIMITS),
      });
    }
  }
  return found;
}

const resolveLink = (target: string) => (PEOPLE.includes(target) ? `${target}.md` : null);

type Answer = { readonly columns: string[]; readonly rows: unknown[] } | { readonly error: string };

function answer(
  database: DatabaseSync,
  run: () => { sql: string; parameters: readonly (string | number)[] },
): Answer {
  try {
    const { sql, parameters } = run();
    const statement = database.prepare(sql);
    statement.setReturnArrays(true);
    return {
      columns: statement.columns().map((column) => column.name),
      rows: statement.all(...parameters),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** The SQL of the item lookup, which main never wrote. */
const ITEM_LOOKUP = 'FROM props AS p WHERE p.path = ';

describe('a filter on a list answers as it did before #923', () => {
  const notes = vaultNotes(SEED);
  const before = vaultIndex(notes, mainTypeViewSelectSql);
  const after = vaultIndex(notes, typeViewSelectSql);
  const all = cases(SEED);
  const viewColumnsOf = new Map(TYPES.map((type) => [type.name, typeViewColumns(type)]));

  it('the whole view, every row and column, is the same', () => {
    for (const type of TYPES) {
      const sql = `SELECT * FROM "v_${type.name}" ORDER BY "path"`;
      const was = answer(before, () => ({ sql, parameters: [] }));
      expect('rows' in was && was.rows.length).toBeGreaterThan(500);
      expect(answer(after, () => ({ sql, parameters: [] }))).toEqual(was);
    }
  });

  it(`holds ${all.length} queries over ${NOTES} notes of ${TYPES.length} types (seed ${SEED})`, () => {
    let rowsCompared = 0;
    let lookedUp = 0;
    let different = 0;
    let referenceLookups = 0;
    let drifted = 0;
    for (const { name, query, includeArchived, linked } of all) {
      const reach = { includeArchived, ...(linked && { resolveLink }) };
      const was = answer(before, () => {
        const compiled = mainCompileViewQuery(query, {}, reach);
        if (compiled.sql.includes(ITEM_LOOKUP)) referenceLookups += 1;
        // Without the view's columns the compile is main's, word for word, so
        // the step guards (list-filter-budget.test.ts) may stand it in for main.
        if (JSON.stringify(compileViewQuery(query, {}, reach)) !== JSON.stringify(compiled)) {
          drifted += 1;
        }
        return compiled;
      });
      const now = answer(after, () => {
        const compiled = compileViewQuery(
          query,
          {},
          { ...reach, viewColumns: viewColumnsOf.get(query.type) },
        );
        if (compiled.sql.includes(ITEM_LOOKUP)) lookedUp += 1;
        return compiled;
      });
      if ('rows' in now) rowsCompared += now.rows.length;
      if (JSON.stringify(now) !== JSON.stringify(was)) {
        different += 1;
        expect({ name, ...now }).toEqual({ name, ...was });
      }
    }
    expect(different).toBe(0);
    // The reference is main's: every filter on the cell.
    expect(referenceLookups).toBe(0);
    expect(drifted).toBe(0);
    // Not so sparse a vault, nor so few lookups, that the comparison proves nothing.
    expect(rowsCompared).toBeGreaterThan(400_000);
    expect(lookedUp).toBeGreaterThan(1_500);
  }, 300_000);

  it('a count and a chart filtered by a list answer the same', () => {
    const rng = seeded(SEED + 2);
    for (const type of TYPES) {
      for (const key of type.properties.map((property) => property.key)) {
        for (const operator of FILTER_OPERATORS) {
          const value = rng.pick(FILTER_VALUES);
          const query: ViewQuery = {
            type: type.name,
            columns: [],
            filters: [{ key, operator, value }],
            sorts: [],
            limit: 500,
          };
          for (const shape of [
            { aggregate: { kind: 'count', column: null } } as const,
            { groupBy: key },
          ]) {
            const was = answer(before, () => mainCompileViewQuery(query, shape));
            const now = answer(after, () =>
              compileViewQuery(query, shape, { viewColumns: viewColumnsOf.get(type.name) }),
            );
            expect({ key, operator, value, ...now }).toEqual({ key, operator, value, ...was });
          }
        }
      }
    }
  });
});

/** The type as its view was before it held lists: each list a single value (`is a list` switched on since). */
const singleSpec = (spec: TypeViewSpec): TypeViewSpec => ({
  ...spec,
  columns: spec.columns.map((column) => ({
    ...column,
    many: false,
    kind: column.kind === 'multiSelect' ? 'select' : column.kind,
  })),
});

describe('a filter on a list, while the index still holds the view from before it was a list', () => {
  // The index rebuilds its views apart from the types a query is compiled
  // with, and keeps the old ones when a rebuild fails: the filter is asked of
  // the view the index holds, never of the types alone.
  const notes = vaultNotes(SEED);
  const before = vaultIndex(notes, (spec) => mainTypeViewSelectSql(singleSpec(spec)));
  const after = vaultIndex(notes, (spec) => typeViewSelectSql(singleSpec(spec)));
  const listed = new Map(TYPES.map((type) => [type.name, typeViewColumns(type)]));
  const sample = cases(SEED).filter((_, at) => at % 7 === 0);

  it(`keeps what main keeps on the old view, ${sample.length} queries`, () => {
    let different = 0;
    let rowsCompared = 0;
    for (const { name, query, includeArchived } of sample) {
      const was = answer(before, () => mainCompileViewQuery(query, {}, { includeArchived }));
      const now = answer(after, () =>
        compileViewQuery(query, {}, { includeArchived, viewColumns: listed.get(query.type) }),
      );
      if ('rows' in now) rowsCompared += now.rows.length;
      if (JSON.stringify(now) !== JSON.stringify(was)) {
        different += 1;
        expect({ name, ...now }).toEqual({ name, ...was });
      }
    }
    expect(different).toBe(0);
    expect(rowsCompared).toBeGreaterThan(50_000);
  }, 120_000);
});
