import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  compileViewQuery,
  parseObjectType,
  SHIPPED_PROPERTIES,
  typeTableQuery,
  type CompiledQuery,
  type ObjectType,
  type QueryFilter,
  type QueryShape,
  type ViewQuery,
} from '@dfai/domain';
import { viewColumnsOf, viewSpecsFor } from './run-view.ts';

/**
 * The index's type-table budget tests (#919,
 * `apps/desktop/src-tauri/src/index/type_table_budget_tests.rs`) run the SQL
 * TypeScript writes to open the Meeting table. Each copy there is held here to
 * what TypeScript writes now, as `index-rs.pin.test.ts` holds the #143 copies,
 * so the budget is measured on SQL that ships.
 */
const root = new URL('../../../../', import.meta.url);
const TESTS_RS = readFileSync(
  new URL('apps/desktop/src-tauri/src/index/type_table_budget_tests.rs', root),
  'utf8',
);

function rustConstant(name: string): string {
  const found = new RegExp(`const ${name}: &str = r#"([\\s\\S]*?)"#;`).exec(TESTS_RS);
  if (found?.[1] === undefined) throw new Error(`the budget tests have no raw string ${name}`);
  return found[1];
}

/**
 * The built-in Meeting type as `vault/.atlas/types/meeting.md` declares it,
 * with what DFAI ships on it and four columns a person added.
 */
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
      external_id: { kind: 'text', label: "Provider's id" },
      people: { kind: 'relation', target: 'person', many: true },
      companies: { kind: 'relation', target: 'company', many: true },
      project: { kind: 'relation', target: 'project' },
      tasks: { kind: 'relation', target: 'task', many: true },
      decisions: { kind: 'relation', target: 'decision', many: true },
      atlas_import_outcome: { kind: 'select', options: ['imported', 'duplicate', 'error'] },
      atlas_import_error: { kind: 'text', label: 'Import error' },
      atlas_duplicate_of: { kind: 'relation', target: 'meeting', label: 'Duplicate of' },
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

const type = meetingType();
const table = typeTableQuery(type);

/** What the app compiles with: the columns the index made the Meeting view of (#923). */
const reach = { viewColumns: viewColumnsOf([type], type.name) };
const view = (over: Partial<ViewQuery>, shape: QueryShape = {}) =>
  compileViewQuery({ ...table, ...over }, shape, reach);
const MARA: QueryFilter = { key: 'people', operator: 'contains', value: 'Mara' };
const COUNT: QueryShape = { aggregate: { kind: 'count', column: null } };

/** Twenty books, in a vault of meetings that share their list keys (#929). */
const book = parseObjectType({
  name: 'book',
  properties: {
    people: { kind: 'relation', target: 'person', many: true },
    companies: { kind: 'relation', target: 'company', many: true },
  },
});
const books = (filter: QueryFilter) =>
  compileViewQuery(
    { ...typeTableQuery(book), filters: [filter] },
    {},
    {
      viewColumns: viewColumnsOf([book], book.name),
    },
  );

/** Each statement, with what it binds before its LIMIT. */
const STATEMENTS: Record<string, [CompiledQuery, readonly string[]]> = {
  MEETING_TABLE: [view({}), []],
  MEETING_TABLE_BY_DATE: [view({ sorts: [{ key: 'date', direction: 'desc' }] }), []],
  // contains, every meeting matching: Mara Quill is in each.
  MEETING_TABLE_FILTERED: [
    view({ filters: [MARA], sorts: [{ key: 'start', direction: 'asc' }] }),
    ['people', 'Mara', 'Mara'],
  ],
  MEETING_CONTAINS_NONE: [
    view({ filters: [{ key: 'people', operator: 'contains', value: 'Zed' }] }),
    ['people', 'Zed', 'Zed'],
  ],
  MEETING_TABLE_TWO_LIST_FILTERS: [
    view({ filters: [MARA, { key: 'tasks', operator: 'contains', value: 'Follow' }] }),
    ['people', 'Mara', 'Mara', 'tasks', 'Follow', 'Follow'],
  ],
  // is, no meeting matching: each has two people or more.
  MEETING_TABLE_PERSON_IS: [
    view({ filters: [{ key: 'people', operator: 'is', value: '[[Mara Quill]]' }] }),
    ['people', '[[Mara Quill]]', '[[Mara Quill]]'],
  ],
  MEETING_IS_ALL: [
    view({ filters: [{ key: 'companies', operator: 'is', value: '[[Larkspur Payroll]]' }] }),
    ['companies', '[[Larkspur Payroll]]', '[[Larkspur Payroll]]'],
  ],
  MEETING_IS_NOT_ALL: [
    view({ filters: [{ key: 'people', operator: 'isNot', value: '[[Mara Quill]]' }] }),
    ['people', '[[Mara Quill]]', '[[Mara Quill]]'],
  ],
  MEETING_IS_NOT_NONE: [
    view({ filters: [{ key: 'companies', operator: 'isNot', value: '[[Larkspur Payroll]]' }] }),
    ['companies', '[[Larkspur Payroll]]', '[[Larkspur Payroll]]'],
  ],
  MEETING_TABLE_WITHOUT_TASKS: [
    view({ filters: [{ key: 'tasks', operator: 'isEmpty' }] }),
    ['tasks'],
  ],
  MEETING_IS_EMPTY_ALL: [
    view({ filters: [{ key: 'decisions', operator: 'isEmpty' }] }),
    ['decisions'],
  ],
  MEETING_IS_EMPTY_NONE: [view({ filters: [{ key: 'people', operator: 'isEmpty' }] }), ['people']],
  MEETING_IS_NOT_EMPTY_ALL: [
    view({ filters: [{ key: 'people', operator: 'isNotEmpty' }] }),
    ['people'],
  ],
  MEETING_IS_NOT_EMPTY_NONE: [
    view({ filters: [{ key: 'decisions', operator: 'isNotEmpty' }] }),
    ['decisions'],
  ],
  // startsWith stays on the cell (#929).
  MEETING_STARTS_WITH_ALL: [
    view({ filters: [{ key: 'people', operator: 'startsWith', value: '[[' }] }),
    ['[['],
  ],
  MEETING_SORT_BY_PEOPLE: [view({ sorts: [{ key: 'people', direction: 'desc' }] }), []],
  // The attack's statement on #921 (type-table-budget.attack-921.test.ts).
  MEETING_SORT_BY_TWO_LISTS: [
    view({
      sorts: [
        { key: 'people', direction: 'desc' },
        { key: 'attendees', direction: 'asc' },
      ],
    }),
    [],
  ],
  MEETING_COUNT: [view({}, COUNT), []],
  MEETING_COUNT_FILTERED: [view({ filters: [MARA] }, COUNT), ['people', 'Mara', 'Mara']],
  MEETING_GROUPS: [view({}, { groupBy: 'kind' }), []],
  MEETING_GROUPS_BY_PEOPLE: [view({}, { groupBy: 'people' }), []],
  MEETING_GROUPS_BY_PEOPLE_FILTERED: [
    view({ filters: [MARA] }, { groupBy: 'people' }),
    ['people', 'Mara', 'Mara'],
  ],
  BOOK_CONTAINS: [books(MARA), ['people', 'Mara', 'Mara']],
  BOOK_IS: [
    books({ key: 'people', operator: 'is', value: '[[Mara Quill]]' }),
    ['people', '[[Mara Quill]]', '[[Mara Quill]]'],
  ],
  BOOK_IS_NOT: [
    books({ key: 'people', operator: 'isNot', value: '[[Mara Quill]]' }),
    ['people', '[[Mara Quill]]', '[[Mara Quill]]'],
  ],
  BOOK_IS_EMPTY: [books({ key: 'people', operator: 'isEmpty' }), ['people']],
  BOOK_IS_NOT_EMPTY: [books({ key: 'people', operator: 'isNotEmpty' }), ['people']],
};

describe('the SQL the type-table budget tests run is the SQL TypeScript writes (#919)', () => {
  it('the Meeting and Book views', () => {
    expect(rustConstant('MEETING_VIEW')).toBe(viewSpecsFor([type])[0]?.select);
    expect(rustConstant('BOOK_VIEW')).toBe(viewSpecsFor([book])[0]?.select);
  });

  it.each(Object.entries(STATEMENTS))('%s', (name, [compiled]) => {
    expect(rustConstant(name)).toBe(compiled.sql);
  });

  it.each(Object.entries(STATEMENTS))(
    '%s binds what the Rust tests bind',
    (name, [compiled, binds]) => {
      expect(compiled.parameters).toEqual([...binds, 500]);
      const bound = new RegExp(
        `\\(\\s*"[^"]*",\\s*${name},\\s*vec!\\[([\\s\\S]*?)limit\\(\\)`,
      ).exec(TESTS_RS);
      const rust = [...(bound?.[1] ?? '').matchAll(/text\("([^"]*)"\)/g)].map((found) => found[1]);
      expect(rust, `${name} in statements()`).toEqual(binds);
    },
  );

  it('every statement the Rust tests run is one written here', () => {
    const constants = [...TESTS_RS.matchAll(/^const ((?:MEETING|BOOK)_\w+): &str = r#"/gm)].map(
      (found) => found[1],
    );
    expect(constants.sort()).toEqual(
      ['MEETING_VIEW', 'BOOK_VIEW', ...Object.keys(STATEMENTS)].sort(),
    );
  });
});
