import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { indexablePropertiesOf, type IndexableProperty } from '../index/property-value.ts';
import { relationsOf, type IndexableRelation } from '../index/relation-rows.ts';
import { resolveWikiLinkTarget } from '../markdown/resolve-wikilink.ts';
import { tagKey } from '../tags/tag-name.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import {
  NO_SPAN,
  type AtlasQuery,
  type Comparison,
  type Expression,
  type FieldRef,
  type QueryValue,
} from './ast.ts';
import {
  builderFromQuery,
  queryFromBuilder,
  type BuilderCondition,
  type BuilderQuery,
} from './builder.ts';
import { compileAtlasQuery } from './compile.ts';
import { parseAtlasQuery } from './parse.ts';
import { printAtlasQuery } from './print.ts';
import { QUERY_TEST_TYPES } from './query-fixtures.ts';

/**
 * Adversarial, differential: random queries over a random vault, run as the
 * compiled SQL on SQLite and by a naive evaluator written from ADR-0019's
 * words. The two must list the same notes. Every random query also goes
 * through print → parse first, which must give back the same query.
 *
 * Seeded (mulberry32), so a failure names the seed and the query, and the same
 * seed always makes the same vault and the same queries.
 */

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)] as T;
const chance = (rng: Rng, p: number) => rng() < p;

interface Note {
  readonly path: string;
  readonly frontmatter: Record<string, unknown>;
  readonly tags: readonly string[];
}

// ---------------------------------------------------------------- the vault

const PROJECT_PATHS = ['projects/DFAI.md', 'projects/Beacon.md', 'Archive/projects/Old.md'];
const PERSON_PATHS = ['people/Julie.md', 'people/Sam.md'];

function randomVault(rng: Rng): Note[] {
  const notes: Note[] = [];
  for (const path of PROJECT_PATHS) {
    notes.push({
      path,
      frontmatter: {
        type: 'project',
        ...(chance(rng, 0.8) ? { status: pick(rng, ['active', 'paused', 'Active', '']) } : {}),
        ...(chance(rng, 0.7)
          ? { owner: pick(rng, ['[[Julie]]', '[[people/Sam]]', '[[Nobody]]']) }
          : {}),
        ...(chance(rng, 0.5)
          ? { due: pick(rng, ['2026-09-30', '2026-10-01', '2026-09-30T10:00']) }
          : {}),
      },
      tags: chance(rng, 0.5) ? [pick(rng, ['q3', 'q3/okr', 'q4'])] : [],
    });
  }
  for (const path of PERSON_PATHS) {
    notes.push({
      path,
      frontmatter: { type: 'person', role: pick(rng, ['lead', 'dev']) },
      tags: [],
    });
  }
  const folders = ['tasks/', 'tasks/', 'tasks/', 'Archive/tasks/', 'archive/', '.atlas/'];
  for (let at = 0; at < 30; at += 1) {
    const frontmatter: Record<string, unknown> = { type: 'task' };
    const maybe = (key: string, values: readonly unknown[]) => {
      if (chance(rng, 0.75)) frontmatter[key] = pick(rng, values);
    };
    maybe('status', ['backlog', 'doing', 'done', 'Done', '', null]);
    maybe('estimate', [1, 2, 3, 2.5, '3', 'lots', -1, 0]);
    maybe('notes', ['alpha', 'Beta', 'alphabet', '', 'x_y', '50%', 5, "it's"]);
    maybe('flagged', [true, false, 'true', 'yes', null]);
    maybe('labels', [['red'], ['blue'], ['red', 'blue'], [], 'red']);
    maybe('project', ['[[DFAI]]', '[[projects/Beacon]]', '[[Ghost]]', '[[atlas]]', '[[Old]]']);
    maybe('owner', ['[[Julie]]', '[[Sam]]', '[[Nobody]]']);
    maybe('due', ['2026-09-29', '2026-09-30', '2026-10-01', '2026-09-30T18:00', 'soon']);
    const tags = ['q3', 'q3/okr', 'q4', 'Q3', 'q3x'].filter(() => chance(rng, 0.3));
    notes.push({
      path: `${pick(rng, folders)}T${String(at).padStart(2, '0')}.md`,
      frontmatter,
      tags,
    });
  }
  return notes;
}

// ---------------------------------------------------------------- the queries

interface FuzzField {
  readonly text: string;
  readonly values: readonly QueryValue[];
  readonly ops: readonly Comparison[];
}

const text = (value: string): QueryValue => ({ kind: 'text', text: value, span: NO_SPAN });
const num = (value: number): QueryValue => ({
  kind: 'number',
  number: value,
  text: String(value),
  span: NO_SPAN,
});
const link = (target: string): QueryValue => ({ kind: 'link', target, span: NO_SPAN });
const EQ: readonly Comparison[] = ['=', '!='];
const WORDY: readonly Comparison[] = ['=', '!=', 'contains', 'startsWith'];
const ORDERED: readonly Comparison[] = ['=', '!=', '<', '<=', '>', '>='];

const FIELDS: readonly FuzzField[] = [
  { text: 'status', ops: WORDY, values: ['backlog', 'doing', 'done', 'Done', 'do'].map(text) },
  { text: 'estimate', ops: ORDERED, values: [0, 1, 2, 3, -1, 2.5].map(num) },
  {
    text: 'notes',
    ops: WORDY,
    values: ['alpha', 'ALPHA', 'bet', '50%', '_', "it's", 'and'].map(text),
  },
  {
    text: 'flagged',
    ops: EQ,
    values: [true, false].map((value) => ({ kind: 'boolean', value, span: NO_SPAN }) as const),
  },
  { text: 'labels', ops: WORDY, values: ['red', 'blue', 'RED'].map(text) },
  {
    text: 'tag',
    ops: EQ,
    values: ['q3', 'Q3', 'q3/okr', 'q4', 'q'].map(
      (name) => ({ kind: 'tag', name, span: NO_SPAN }) as const,
    ),
  },
  { text: 'title', ops: WORDY, values: ['T01', 't0', 'T1'].map(text) },
  {
    text: 'project',
    ops: WORDY,
    values: [link('DFAI'), link('Beacon'), link('Ghost'), link('ghost'), link('Old'), text('Atl')],
  },
  { text: 'project.status', ops: WORDY, values: ['active', 'paused', 'act'].map(text) },
  { text: 'project.owner', ops: EQ, values: [link('Julie'), link('Sam'), link('Nobody')] },
  { text: 'project.title', ops: WORDY, values: ['DFAI', 'atlas', 'Bea'].map(text) },
  { text: 'owner.role', ops: WORDY, values: ['lead', 'dev'].map(text) },
  { text: 'due', ops: ORDERED, values: ['2026-09-29', '2026-09-30', '2026-10-01'].map(text) },
  { text: 'project.due', ops: ORDERED, values: ['2026-09-30', '2026-10-01'].map(text) },
];

function fieldRef(written: string): FieldRef {
  const [first = '', second] = written.split('.');
  return {
    via: second === undefined ? null : { text: first, span: NO_SPAN },
    name: { text: second ?? first, span: NO_SPAN },
    span: NO_SPAN,
  };
}

function randomCondition(rng: Rng): Expression {
  const field = pick(rng, FIELDS);
  if (chance(rng, 0.15)) {
    return { kind: 'empty', field: fieldRef(field.text), negated: chance(rng, 0.5), span: NO_SPAN };
  }
  const op = pick(rng, field.ops);
  let value = pick(rng, field.values);
  // CONTAINS and STARTS WITH take words; a relation searched is searched by its written target.
  if ((op === 'contains' || op === 'startsWith') && value.kind === 'link')
    value = text(value.target);
  return { kind: 'compare', field: fieldRef(field.text), op, value, span: NO_SPAN };
}

function randomExpression(rng: Rng, depth: number, within: 'and' | 'or' | null): Expression {
  const roll = rng();
  if (depth <= 0 || roll < 0.45) return randomCondition(rng);
  if (roll < 0.6) {
    return { kind: 'not', operand: randomExpression(rng, depth - 1, null), span: NO_SPAN };
  }
  // A list inside a list of the same kind prints without brackets and reads back flat.
  const kind =
    within === 'and' ? 'or' : within === 'or' ? 'and' : pick(rng, ['and', 'or'] as const);
  const count = 2 + Math.floor(rng() * 2);
  const operands = Array.from({ length: count }, () => randomExpression(rng, depth - 1, kind));
  return { kind, operands, span: NO_SPAN };
}

function randomQuery(rng: Rng): AtlasQuery {
  return {
    from: pick(rng, [['task'], ['task', 'project'], ['project', 'task']]).map((type) => ({
      text: type,
      span: NO_SPAN,
    })),
    where: randomExpression(rng, 3, null),
    sort: [],
    group: [],
    show: [],
    includeArchived: chance(rng, 0.3),
    limit: 5000,
  };
}

// ---------------------------------------------------------------- the naive evaluator

interface World {
  readonly notes: readonly Note[];
  readonly byPath: ReadonlyMap<string, Note>;
  readonly props: (path: string) => readonly IndexableProperty[];
  readonly relations: (path: string) => readonly IndexableRelation[];
  readonly resolve: (target: string) => string | null;
}

function worldOf(notes: readonly Note[]): World {
  const paths = notes.map((note) => createVaultPath(note.path));
  const resolve = (target: string) => resolveWikiLinkTarget(target, paths);
  const byPath = new Map(notes.map((note) => [note.path, note]));
  const props = (path: string) => indexablePropertiesOf(byPath.get(path)?.frontmatter ?? {});
  const relations = (path: string) => relationsOf(byPath.get(path)?.frontmatter ?? {}, resolve);
  return { notes, byPath, props, relations, resolve };
}

/** SQLite's lower(): A–Z only. */
const asciiLower = (value: string) => value.replace(/[A-Z]/g, (char) => char.toLowerCase());
const titleOf = (path: string) => path.replace(/^.*\//, '').replace(/\.md$/, '');
const dayOf = (value: string | null) => (value === null ? null : value.slice(0, 10));

function ordered(op: Comparison, left: number | string, right: number | string): boolean {
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
    default:
      throw new Error(`not ordered: ${op}`);
  }
}

function wordy(op: Comparison, left: string | null, right: string): boolean {
  if (left === null) return false;
  if (op === '=') return left === right;
  if (op === 'contains') return asciiLower(left).includes(asciiLower(right));
  if (op === 'startsWith') return asciiLower(left).startsWith(asciiLower(right));
  throw new Error(`not wordy: ${op}`);
}

function valueWords(value: QueryValue): string {
  switch (value.kind) {
    case 'text':
      return value.text;
    case 'number':
      return value.text ?? String(value.number);
    case 'link':
      return value.target;
    case 'tag':
      return value.name;
    default:
      return String(value);
  }
}

/** The notes a field is read from, for one note: itself, or those its relation points at. */
function holders(world: World, path: string, ref: FieldRef): string[] {
  if (ref.via === null) return [path];
  return world
    .relations(path)
    .filter((row) => row.key === ref.via?.text && row.path !== null)
    .map((row) => row.path as string)
    .filter((dst) => world.byPath.has(dst));
}

const KINDS: Readonly<Record<string, string>> = {
  status: 'select',
  estimate: 'number',
  notes: 'text',
  flagged: 'checkbox',
  labels: 'multiSelect',
  tag: 'tag',
  title: 'title',
  project: 'relation',
  owner: 'relation',
  role: 'text',
  due: 'date',
};

/** Whether one note (the holder) has a row of this field matching `test`, and whether it has any value. */
function rowsOf(
  world: World,
  holder: string,
  key: string,
): { present: boolean; any: (op: Comparison, value: QueryValue) => boolean } {
  const kind = KINDS[key] ?? 'text';
  if (kind === 'title') {
    const title = titleOf(holder);
    return { present: title !== '', any: (op, value) => wordy(op, title, valueWords(value)) };
  }
  if (kind === 'tag') {
    const tags = world.byPath.get(holder)?.tags.map(tagKey) ?? [];
    return {
      present: tags.length > 0,
      any: (_op, value) => {
        const wanted = tagKey(valueWords(value));
        return tags.some((tag) => tag === wanted || tag.startsWith(`${wanted}/`));
      },
    };
  }
  const rows = world.props(holder).filter((row) => row.key === key);
  const present = rows.some((row) => (row.text ?? row.json ?? '') !== '');
  if (kind === 'checkbox') {
    return { present, any: () => rows.some((row) => row.text === 'true') };
  }
  if (kind === 'relation') {
    const relations = world.relations(holder).filter((row) => row.key === key);
    return {
      present,
      any: (op, value) => {
        const wanted = valueWords(value);
        if (op === 'contains' || op === 'startsWith') {
          return relations.some((row) => wordy(op, row.target, wanted));
        }
        const resolved = world.resolve(wanted);
        return relations.some((row) =>
          resolved === null ? asciiLower(row.target) === asciiLower(wanted) : row.path === resolved,
        );
      },
    };
  }
  if (kind === 'number') {
    return {
      present,
      any: (op, value) =>
        rows.some(
          (row) =>
            row.number !== null && value.kind === 'number' && ordered(op, row.number, value.number),
        ),
    };
  }
  if (kind === 'date') {
    return {
      present,
      any: (op, value) =>
        rows.some((row) => {
          const day = dayOf(row.date);
          return day !== null && ordered(op, day, valueWords(value));
        }),
    };
  }
  return {
    present,
    any: (op, value) => rows.some((row) => wordy(op, row.text, valueWords(value))),
  };
}

function holds(world: World, path: string, expression: Expression): boolean {
  switch (expression.kind) {
    case 'and':
      return expression.operands.every((operand) => holds(world, path, operand));
    case 'or':
      return expression.operands.some((operand) => holds(world, path, operand));
    case 'not':
      return !holds(world, path, expression.operand);
    case 'linksTo':
    case 'connectedTo':
      throw new Error('the fuzzed queries say no LINKS TO or CONNECTED TO');
    case 'empty': {
      const present = holders(world, path, expression.field).some(
        (holder) => rowsOf(world, holder, expression.field.name.text).present,
      );
      return expression.negated ? present : !present;
    }
    case 'compare': {
      const kind = KINDS[expression.field.name.text];
      const negative = expression.op === '!=';
      const op = negative ? '=' : expression.op;
      const found = holders(world, path, expression.field).some((holder) =>
        rowsOf(world, holder, expression.field.name.text).any(op, expression.value),
      );
      if (kind === 'checkbox') {
        // Unticked is anything but true: "= false" is "no value is true".
        const ticked = expression.value.kind === 'boolean' && expression.value.value;
        return ticked !== negative ? found : !found;
      }
      return negative ? !found : found;
    }
  }
}

function naive(world: World, query: AtlasQuery): string[] {
  const from = new Set(query.from.map((name) => name.text));
  return world.notes
    .filter((note) => from.has(String(note.frontmatter['type'])))
    .filter((note) => !note.path.startsWith('.atlas/'))
    .filter((note) => query.includeArchived || !note.path.toLowerCase().startsWith('archive/'))
    .filter((note) => query.where === null || holds(world, note.path, query.where))
    .map((note) => note.path)
    .sort();
}

// ---------------------------------------------------------------- SQLite

function databaseOf(world: World): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE files (path TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
                        modified INTEGER NOT NULL, size INTEGER NOT NULL);
    CREATE TABLE props (path TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0,
                        value_text TEXT, value_num REAL, value_date TEXT, value_json TEXT);
    CREATE TABLE relations (src TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL,
                            target TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', dst TEXT);
    CREATE TABLE tags (path TEXT NOT NULL, idx INTEGER NOT NULL, tag TEXT NOT NULL, name TEXT NOT NULL);`);
  for (const note of world.notes) {
    database
      .prepare('INSERT INTO files VALUES (?, ?, ?, ?, 1)')
      .run(note.path, titleOf(note.path), '', Date.UTC(2999, 0, 1, 12));
    for (const row of world.props(note.path)) {
      database
        .prepare('INSERT INTO props VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(note.path, row.key, row.index, row.text, row.number, row.date, row.json);
    }
    for (const row of world.relations(note.path)) {
      database
        .prepare('INSERT INTO relations VALUES (?, ?, ?, ?, ?, ?)')
        .run(note.path, row.key, row.index, row.target, row.name, row.path);
    }
    note.tags.forEach((name, at) =>
      database
        .prepare('INSERT INTO tags VALUES (?, ?, ?, ?)')
        .run(note.path, at, tagKey(name), name),
    );
  }
  return database;
}

function compiledPaths(database: DatabaseSync, world: World, query: AtlasQuery): string[] {
  const compiled = compileAtlasQuery(query, {
    types: QUERY_TEST_TYPES,
    resolveLink: world.resolve,
  });
  const rows = database.prepare(compiled.sql).all(...compiled.parameters) as { path: string }[];
  return rows.map((row) => row.path).sort();
}

/** A query without the places it came from, to compare two readings of it. */
function withoutSpans(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSpans);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'span')
        .map(([key, inner]) => [key, withoutSpans(inner)]),
    );
  }
  return value;
}

function randomBuilder(rng: Rng): BuilderQuery {
  const count = Math.floor(rng() * 4);
  const conditions: BuilderCondition[] = Array.from({ length: count }, () => {
    const field = pick(rng, FIELDS);
    const roll = rng();
    const negated = chance(rng, 0.3);
    if (roll < 0.15)
      return {
        field: field.text,
        op: pick(rng, ['isEmpty', 'isNotEmpty'] as const),
        value: null,
        negated,
      };
    return { field: field.text, op: pick(rng, field.ops), value: pick(rng, field.values), negated };
  });
  const orderable = ['due', 'estimate', 'status', 'project', 'title', 'project.status'];
  return {
    types: pick(rng, [['task'], ['task', 'project'], ['project', 'task']]),
    match: count < 2 ? 'all' : pick(rng, ['all', 'any'] as const),
    conditions,
    sort: orderable
      .filter(() => chance(rng, 0.2))
      .map((field) => ({ field, direction: pick(rng, ['asc', 'desc'] as const) })),
    group: ['status', 'project'].filter(() => chance(rng, 0.3)),
    show: ['notes', 'labels', 'project.owner'].filter(() => chance(rng, 0.3)),
    includeArchived: chance(rng, 0.5),
    limit: chance(rng, 0.5) ? null : 1 + Math.floor(rng() * 5000),
  };
}

const SEEDS = Array.from({ length: 25 }, (_, at) => 1000 + at);
const QUERIES_PER_SEED = 40;

describe('compiled DFAI queries against a naive evaluator (adversarial, seeded fuzz)', () => {
  it.each(SEEDS)('prints and reads back every random query unchanged (seed %i)', (seed) => {
    const rng = mulberry32(seed);
    for (let at = 0; at < QUERIES_PER_SEED; at += 1) {
      const query = randomQuery(rng);
      const printed = printAtlasQuery(query);
      expect(withoutSpans(parseAtlasQuery(printed)), printed).toEqual(withoutSpans(query));
    }
  });

  it.each(SEEDS)('opens every printed builder query in the builder as it was (seed %i)', (seed) => {
    const rng = mulberry32(seed);
    for (let at = 0; at < QUERIES_PER_SEED; at += 1) {
      const builder = randomBuilder(rng);
      const printed = printAtlasQuery(queryFromBuilder(builder));
      const reading = builderFromQuery(parseAtlasQuery(printed));
      expect(reading.ok ? withoutSpans(reading.builder) : reading, printed).toEqual(
        withoutSpans(builder),
      );
    }
  });

  it.each(SEEDS)('lists the notes the naive evaluator lists (seed %i)', (seed) => {
    const rng = mulberry32(seed);
    const world = worldOf(randomVault(rng));
    const database = databaseOf(world);
    const mismatches: string[] = [];
    for (let at = 0; at < QUERIES_PER_SEED; at += 1) {
      const query = randomQuery(rng);
      const got = compiledPaths(database, world, query);
      const want = naive(world, query);
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        const extra = got.filter((path) => !want.includes(path));
        const missing = want.filter((path) => !got.includes(path));
        mismatches.push(
          `${printAtlasQuery(query)}\n  extra ${extra.join(' ')} missing ${missing.join(' ')}`,
        );
      }
    }
    expect(mismatches.slice(0, 3)).toEqual([]);
  });

  it.each(SEEDS.slice(0, 5))(
    'honours LIMIT as the first rows of the whole answer (seed %i)',
    (seed) => {
      const rng = mulberry32(seed);
      const world = worldOf(randomVault(rng));
      const database = databaseOf(world);
      for (let at = 0; at < 10; at += 1) {
        const query: AtlasQuery = {
          ...randomQuery(rng),
          sort: [
            {
              field: fieldRef(pick(rng, ['due', 'estimate', 'status', 'project', 'title'])),
              direction: pick(rng, ['asc', 'desc'] as const),
            },
          ],
        };
        const compile = (limit: number) =>
          compileAtlasQuery(
            { ...query, limit },
            { types: QUERY_TEST_TYPES, resolveLink: world.resolve },
          );
        const run = (limit: number) => {
          const compiled = compile(limit);
          return (
            database.prepare(compiled.sql).all(...compiled.parameters) as { path: string }[]
          ).map((row) => row.path);
        };
        const whole = run(5000);
        const limit = 1 + Math.floor(rng() * 5);
        expect(run(limit)).toEqual(whole.slice(0, limit));
      }
    },
  );
});
