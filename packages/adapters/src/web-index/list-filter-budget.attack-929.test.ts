import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@sqlite.org/sqlite-wasm';
import { viewSpecsFor } from '@dfai/application';
import {
  compileViewQuery,
  parseObjectType,
  SHIPPED_PROPERTIES,
  typeTableQuery,
  type CompiledQuery,
  type ObjectType,
  type QueryFilter,
  typeViewColumns,
} from '@dfai/domain';
import { sqliteWasm } from './in-memory-web-index.ts';
import { QUERY_STEP_BUDGET } from './wasm-index-query.ts';

/**
 * Attack on PR #929 (#923): a filter on a list answered from its items must
 * never cost more of the step budget than the cell's filter it replaces. The
 * lookup reads every row of the key in the whole vault, whatever the type,
 * and `startsWith` checks each matching item is first by another lookup.
 */

const root = new URL('../../../../', import.meta.url);
const SCHEMA = readFileSync(new URL('apps/desktop/src-tauri/src/index_schema.sql', root), 'utf8');
const MEETINGS = 20_000;
const PEOPLE = ['Mara Quill', 'Tobias Fenn', 'Iris Vale', 'Owen Marsh', 'Lena Brook', 'Nia Wren'];

/** The built-in Meeting type with the properties an imported vault declares (22 columns). */
function meetingType(): ObjectType {
  const declared = parseObjectType({
    name: 'meeting',
    properties: {
      title: 'text',
      date: 'date',
      start: 'text',
      end: 'text',
      kind: 'text',
      provider: 'text',
      external_id: 'text',
      people: { kind: 'relation', target: 'person', many: true },
      companies: { kind: 'relation', target: 'company', many: true },
      project: { kind: 'relation', target: 'project' },
      tasks: { kind: 'relation', target: 'task', many: true },
      decisions: { kind: 'relation', target: 'decision', many: true },
      atlas_import_outcome: { kind: 'select', options: ['imported', 'duplicate', 'error'] },
      atlas_import_error: 'text',
      atlas_duplicate_of: { kind: 'relation', target: 'meeting' },
      attendees: { kind: 'text', many: true },
      follow_up: 'date',
      rating: { kind: 'select', options: ['good', 'poor'] },
      topics: { kind: 'multiSelect', options: ['payroll', 'hiring'] },
    },
  });
  const held = new Set(declared.properties.map((property) => property.key));
  const shipped = (SHIPPED_PROPERTIES.get('meeting') ?? []).filter(
    (property) => !held.has(property.key),
  );
  return { ...declared, properties: [...declared.properties, ...shipped] };
}

type PropRow = [string, number, string, string | null];

/** One imported meeting's rows (~30): header, 2-7 people and attendees, links. Deterministic in `at`. */
function meetingRows(at: number): PropRow[] {
  const day = `2026-${String(1 + (at % 12)).padStart(2, '0')}-${String(1 + (at % 28)).padStart(2, '0')}`;
  const rows: PropRow[] = [
    ['type', 0, 'meeting', null],
    ['title', 0, `Weekly sync ${at % 97}`, null],
    ['date', 0, day, day],
    ['start', 0, `${day}T09:00`, null],
    ['end', 0, `${day}T09:30`, null],
    ['kind', 0, ['sync', '1on1', 'review', 'planning'][at % 4] ?? 'sync', null],
    ['provider', 0, 'granola', null],
    ['external_id', 0, `ext-${at}`, null],
    ['atlas_import_outcome', 0, 'imported', null],
    ['companies', 0, '[[Larkspur Payroll]]', null],
    ['calendar_id', 0, `cal-${at}`, null],
  ];
  const people = 2 + (at % 6);
  for (let index = 0; index < people; index += 1) {
    const person = PEOPLE[(at + index) % PEOPLE.length] ?? 'Mara Quill';
    rows.push(['people', index, `[[${person}]]`, null]);
    rows.push(['attendees', index, `${person.split(' ')[0]?.toLowerCase()}@example.com`, null]);
  }
  if (at % 3 === 0) rows.push(['project', 0, '[[Larkspur launch]]', null]);
  if (at % 2 === 0)
    for (let index = 0; index < 3; index += 1)
      rows.push(['tasks', index, `[[Task ${at}-${index}]]`, null]);
  return rows;
}

const type = meetingType();
const book = parseObjectType({
  name: 'book',
  properties: {
    people: { kind: 'relation', target: 'person', many: true },
    attendees: { kind: 'text', many: true },
  },
});
const BOOKS = 20;

let database: Database;
let stepsOf: (compiled: CompiledQuery) => number;

beforeAll(async () => {
  const sqlite3 = await sqliteWasm();
  database = new sqlite3.oo1.DB(':memory:');
  database.exec(SCHEMA);
  const file = database.prepare(
    'INSERT INTO files (path, title, summary, modified, size) VALUES (?, ?, ?, ?, 0)',
  );
  const prop = database.prepare(
    'INSERT INTO props (path, key, idx, value_text, value_date) VALUES (?, ?, ?, ?, ?)',
  );
  database.exec('BEGIN');
  for (let at = 0; at < MEETINGS; at += 1) {
    const path = `meetings/Meeting ${(at * 7919) % MEETINGS}.md`;
    file.bind([path, `Meeting ${at}`, '', 1_790_000_000_000 + at]).stepReset();
    for (const row of meetingRows(at)) prop.bind([path, ...row]).stepReset();
  }
  for (let at = 0; at < BOOKS; at += 1) {
    const path = `books/Book ${at}.md`;
    file.bind([path, `Book ${at}`, '', 1]).stepReset();
    prop.bind([path, 'type', 0, 'book', null]).stepReset();
    prop.bind([path, 'people', 0, '[[Mara Quill]]', null]).stepReset();
    prop.bind([path, 'attendees', 0, 'mara@example.com', null]).stepReset();
  }
  database.exec('COMMIT');
  file.finalize();
  prop.finalize();
  for (const spec of viewSpecsFor([type, book]))
    database.exec(`CREATE VIEW v_${spec.name} AS\n${spec.select}`);
  database.exec('ANALYZE');
  stepsOf = ({ sql, parameters }) => {
    const statement = database.prepare(sql);
    if (parameters.length > 0) statement.bind([...parameters]);
    while (statement.step()) {
      // read every row
    }
    const steps = sqlite3.capi.sqlite3_stmt_status(
      statement.pointer as number,
      sqlite3.capi.SQLITE_STMTSTATUS_VM_STEP,
      0,
    );
    statement.finalize();
    return steps;
  };
}, 120_000);

function stepsOldAndNew(of: ObjectType, filter: QueryFilter): { cell: number; items: number } {
  const query = { ...typeTableQuery(of), filters: [filter] };
  const items = compileViewQuery(query, {}, { viewColumns: typeViewColumns(of) });
  expect(items.sql).toContain('FROM props AS p WHERE p.key = ?');
  return { cell: stepsOf(compileViewQuery(query)), items: stepsOf(items) };
}

const STARTS = { key: 'people', operator: 'startsWith', value: '[[' } as const;

describe(`a list filter costs no more than the cell's, ${MEETINGS} meetings (#923)`, () => {
  it('startsWith that every meeting matches stays within the budget main kept it in', () => {
    const { cell, items } = stepsOldAndNew(type, STARTS);
    expect(cell).toBeLessThan(QUERY_STEP_BUDGET);
    expect(items).toBeLessThan(QUERY_STEP_BUDGET);
  });

  it(`a ${BOOKS}-book table filtered by people costs per book, not per meeting`, () => {
    for (const filter of [
      STARTS,
      { key: 'people', operator: 'contains', value: 'Mara' },
      { key: 'people', operator: 'isEmpty' },
    ] as const) {
      const { cell, items } = stepsOldAndNew(book, filter);
      expect(items, `${filter.operator} on ${BOOKS} books`).toBeLessThanOrEqual(cell * 2);
    }
  });
});
