import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { viewSpecsFor } from '@dfai/application';
import {
  compileViewQuery,
  parseObjectType,
  typeTableQuery,
  typeViewColumns,
  type CompiledQuery,
  type ObjectType,
  type QueryFilter,
  type QueryShape,
  type ViewQuery,
} from '@dfai/domain';
import { sqliteWasm } from './in-memory-web-index.ts';

/**
 * #923, held to #929's bar: a filter on a list asked of each note's items
 * never costs more steps than main's filter on the cell — whether nearly
 * every note matches or almost none does, and whether the type is large or a
 * handful of notes in a vault of thousands of another type sharing the key.
 * main here is the compile without the view's columns (which the differential
 * holds to a frozen copy of main's) over the view as main wrote its lists.
 */

const root = new URL('../../../../', import.meta.url);
const SCHEMA = readFileSync(new URL('apps/desktop/src-tauri/src/index_schema.sql', root), 'utf8');
const PEOPLE = ['Mara Quill', 'Tobias Fenn', 'Iris Vale', 'Owen Marsh', 'Lena Brook', 'Nia Wren'];
const BOOKS = 20;

const LISTS = {
  people: { kind: 'relation', target: 'person', many: true },
  attendees: { kind: 'text', many: true },
  companies: { kind: 'relation', target: 'company', many: true },
  decisions: { kind: 'relation', target: 'decision', many: true },
  tags: { kind: 'multiSelect', options: [] },
  // Held by every other meeting, one in twenty, and none (#929's sparse keys).
  reviewers: { kind: 'text', many: true },
  guests: { kind: 'text', many: true },
  visitors: { kind: 'text', many: true },
};
const MEETING = parseObjectType({
  name: 'meeting',
  properties: { title: 'text', start: 'text', kind: 'text', ...LISTS },
});
const BOOK = parseObjectType({ name: 'book', properties: { title: 'text', ...LISTS } });

/** main's list cell (#921): its held rows, through a CASE. */
const mainView = (select: string) =>
  select.replace(
    /\(SELECT group_concat\(p\.value_text, ', ' ORDER BY p\.idx, p\.rowid\) FROM props AS p WHERE p\.path = n\.path AND p\.key = '(\w+)' AND p\.value_text <> ''\)/g,
    (_, key: string) =>
      `(SELECT group_concat(CASE WHEN p.key = '${key}' THEN p.value_text END, ', ' ORDER BY p.idx, p.rowid) FROM props AS p WHERE p.path = n.path AND p.key = '${key}' AND COALESCE(p.value_text, p.value_json, '') <> '')`,
  );

type Row = [string, string, number, string];

/**
 * A meeting: 2-7 people (each an attendee), one company, a tag, no decisions;
 * a reviewer on every other one, a guest on one in twenty, no visitors.
 */
function meetingRows(at: number): Row[] {
  const path = `meetings/Meeting ${at}.md`;
  const rows: Row[] = [
    [path, 'type', 0, 'meeting'],
    [path, 'title', 0, `Weekly sync ${at % 97}`],
    [path, 'start', 0, `09:${String(at % 60).padStart(2, '0')}`],
    [path, 'companies', 0, '[[Larkspur Payroll]]'],
    [path, 'tags', 0, `t${at % 7}`],
  ];
  for (let index = 0; index < 2 + (at % 6); index += 1) {
    const person = PEOPLE[(at + index) % PEOPLE.length] ?? 'Mara Quill';
    rows.push([path, 'people', index, `[[${person}]]`]);
    rows.push([path, 'attendees', index, `${person.split(' ')[0]?.toLowerCase()}@example.com`]);
  }
  if (at % 2 === 0) rows.push([path, 'reviewers', 0, 'Mara Quill']);
  if (at % 20 === 0) rows.push([path, 'guests', 0, 'Mara Quill']);
  return rows;
}

async function vaultOf(meetings: number) {
  const sqlite3 = await sqliteWasm();
  const database = new sqlite3.oo1.DB(':memory:');
  database.exec(SCHEMA);
  const file = database.prepare(
    'INSERT INTO files (path, title, summary, modified, size) VALUES (?, ?, ?, ?, 0)',
  );
  const prop = database.prepare(
    'INSERT INTO props (path, key, idx, value_text) VALUES (?, ?, ?, ?)',
  );
  database.exec('BEGIN');
  for (let at = 0; at < meetings; at += 1) {
    file.bind([`meetings/Meeting ${at}.md`, `Meeting ${at}`, '', at]).stepReset();
    for (const row of meetingRows(at)) prop.bind(row).stepReset();
  }
  for (let at = 0; at < BOOKS; at += 1) {
    const path = `books/Book ${at}.md`;
    file.bind([path, `Book ${at}`, '', 1]).stepReset();
    for (const row of [
      [path, 'type', 0, 'book'],
      [path, 'people', 0, '[[Mara Quill]]'],
      [path, 'companies', 0, '[[Larkspur Payroll]]'],
    ] as const)
      prop.bind([...row]).stepReset();
  }
  database.exec('COMMIT');
  file.finalize();
  prop.finalize();
  database.exec('ANALYZE');
  const specs = viewSpecsFor([MEETING, BOOK]);
  // main's cells, or nothing would be compared: the rewrite must have matched.
  for (const { select } of specs) expect(mainView(select)).not.toBe(select);
  const viewsAs = (main: boolean) => {
    for (const { name, select } of specs) {
      database.exec(`DROP VIEW IF EXISTS "v_${name}"`);
      database.exec(`CREATE VIEW "v_${name}" AS\n${main ? mainView(select) : select}`);
    }
  };
  const stepsOf = ({ sql, parameters }: CompiledQuery) => {
    const statement = database.prepare(sql);
    statement.bind([...parameters]);
    while (statement.step()) {
      // every row read, as the host reads a page
    }
    const steps = sqlite3.capi.sqlite3_stmt_status(
      statement.pointer as number,
      sqlite3.capi.SQLITE_STMTSTATUS_VM_STEP,
      0,
    );
    statement.finalize();
    return steps;
  };
  /** Steps of main's SQL and of the new, for filters (and sorts) over one type. */
  const mainAndNew = (
    type: ObjectType,
    asked: QueryFilter | Pick<ViewQuery, 'filters' | 'sorts'>,
    shape: QueryShape = {},
  ) => {
    const query = {
      ...typeTableQuery(type),
      ...('key' in asked ? { filters: [asked] } : asked),
    };
    viewsAs(true);
    const main = stepsOf(compileViewQuery(query, shape));
    viewsAs(false);
    const items = compileViewQuery(query, shape, { viewColumns: typeViewColumns(type) });
    expect(items.sql).toContain('FROM props AS p WHERE p.path = ');
    return { main, now: stepsOf(items) };
  };
  return { mainAndNew, close: () => database.close() };
}

/** #929's bar: no dearer than main, but for a small constant. */
const withinMain = (main: number) => Math.max(main * 1.1, main + 5_000);

/** Each indexed operator, once where (nearly) every meeting matches and once where none does. */
const MATCHING: readonly [string, QueryFilter][] = [
  ['contains, all', { key: 'people', operator: 'contains', value: '[[' }],
  ['contains, none', { key: 'people', operator: 'contains', value: 'Zed' }],
  ['is, all', { key: 'companies', operator: 'is', value: '[[Larkspur Payroll]]' }],
  ['is, none', { key: 'people', operator: 'is', value: '[[Mara Quill]]' }],
  ['is not, all', { key: 'people', operator: 'isNot', value: '[[Mara Quill]]' }],
  ['is not, none', { key: 'companies', operator: 'isNot', value: '[[Larkspur Payroll]]' }],
  ['is empty, all', { key: 'decisions', operator: 'isEmpty' }],
  ['is empty, none', { key: 'people', operator: 'isEmpty' }],
  ['is not empty, all', { key: 'people', operator: 'isNotEmpty' }],
  ['is not empty, none', { key: 'decisions', operator: 'isNotEmpty' }],
  ['a tag is, a seventh', { key: 'tags', operator: 'is', value: 'T1' }],
  ...(['reviewers', 'guests', 'visitors'] as const).flatMap((key): [string, QueryFilter][] => {
    const held = { reviewers: 'half', guests: 'one in twenty', visitors: 'none' }[key];
    return [
      [`contains, ${key} on ${held}`, { key, operator: 'contains', value: 'Mara' }],
      [`is, ${key} on ${held}`, { key, operator: 'is', value: 'Mara Quill' }],
      [`is not, ${key} on ${held}`, { key, operator: 'isNot', value: 'Mara Quill' }],
      [`is empty, ${key} on ${held}`, { key, operator: 'isEmpty' }],
      [`is not empty, ${key} on ${held}`, { key, operator: 'isNotEmpty' }],
    ];
  }),
];

const MARA: QueryFilter = { key: 'people', operator: 'contains', value: 'Mara' };

/** Filters together, and with sorts: each list filter's cost added to what else the statement reads. */
const COMBINED: readonly [string, Pick<ViewQuery, 'filters' | 'sorts'>][] = [
  [
    'two lists',
    { filters: [MARA, { key: 'attendees', operator: 'contains', value: 'iris' }], sorts: [] },
  ],
  [
    'one list twice',
    { filters: [MARA, { key: 'people', operator: 'isNot', value: '[[Iris Vale]]' }], sorts: [] },
  ],
  ['sorted by the same list', { filters: [MARA], sorts: [{ key: 'people', direction: 'desc' }] }],
  ['sorted by another list', { filters: [MARA], sorts: [{ key: 'attendees', direction: 'asc' }] }],
  ['sorted by a single value', { filters: [MARA], sorts: [{ key: 'start', direction: 'asc' }] }],
];

const SHAPES: readonly [string, QueryShape][] = [
  ['page', {}],
  ['count', { aggregate: { kind: 'count', column: null } }],
  ['chart by people', { groupBy: 'people' }],
  ['chart by kind', { groupBy: 'kind' }],
];

describe('a list filter asked of the items costs no more than main’s (#923, #929)', () => {
  for (const meetings of [5_000, 20_000]) {
    it(`over ${meetings} meetings, every operator, matching all, half, a few or none, alone and together`, async () => {
      const vault = await vaultOf(meetings);
      for (const [name, filter] of MATCHING) {
        for (const [shaped, shape] of SHAPES) {
          const { main, now } = vault.mainAndNew(MEETING, filter, shape);
          expect(now, `${name}, ${shaped}: ${now} against main's ${main}`).toBeLessThanOrEqual(
            withinMain(main),
          );
        }
      }
      for (const [name, asked] of COMBINED) {
        for (const [shaped, shape] of SHAPES) {
          const { main, now } = vault.mainAndNew(MEETING, asked, shape);
          expect(now, `${name}, ${shaped}: ${now} against main's ${main}`).toBeLessThanOrEqual(
            withinMain(main),
          );
        }
      }
      vault.close();
    }, 120_000);
  }

  it(`a table of ${BOOKS} books costs per book, however many meetings share its keys`, async () => {
    const steps = new Map<string, number[]>();
    for (const meetings of [0, 5_000, 20_000]) {
      const vault = await vaultOf(meetings);
      for (const [name, filter] of MATCHING) {
        const { main, now } = vault.mainAndNew(BOOK, filter);
        expect(now, `${name} over ${meetings} meetings`).toBeLessThanOrEqual(withinMain(main));
        steps.set(name, [...(steps.get(name) ?? []), now]);
      }
      vault.close();
    }
    for (const [name, [none = 0, ...more]] of steps) {
      // The meetings' own items are never read: a fixed few steps apart at most.
      for (const at of more) expect(Math.abs(at - none), name).toBeLessThan(500);
    }
  }, 240_000);
});
