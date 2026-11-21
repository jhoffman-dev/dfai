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

const STATEMENTS: Record<string, CompiledQuery> = {
  MEETING_TABLE: view({}),
  MEETING_TABLE_BY_DATE: view({ sorts: [{ key: 'date', direction: 'desc' }] }),
  MEETING_TABLE_FILTERED: view({ filters: [MARA], sorts: [{ key: 'start', direction: 'asc' }] }),
  MEETING_TABLE_TWO_LIST_FILTERS: view({
    filters: [MARA, { key: 'tasks', operator: 'contains', value: 'Follow' }],
  }),
  MEETING_TABLE_PERSON_IS: view({
    filters: [{ key: 'people', operator: 'is', value: '[[Mara Quill]]' }],
  }),
  MEETING_TABLE_WITHOUT_TASKS: view({ filters: [{ key: 'tasks', operator: 'isEmpty' }] }),
  MEETING_SORT_BY_PEOPLE: view({ sorts: [{ key: 'people', direction: 'desc' }] }),
  MEETING_SORT_BY_TWO_LISTS: view({
    sorts: [
      { key: 'people', direction: 'desc' },
      { key: 'tasks', direction: 'asc' },
    ],
  }),
  MEETING_COUNT: view({}, { aggregate: { kind: 'count', column: null } }),
  MEETING_COUNT_FILTERED: view({ filters: [MARA] }, { aggregate: { kind: 'count', column: null } }),
  MEETING_GROUPS: view({}, { groupBy: 'kind' }),
  MEETING_GROUPS_BY_PEOPLE: view({}, { groupBy: 'people' }),
  MEETING_GROUPS_BY_PEOPLE_FILTERED: view({ filters: [MARA] }, { groupBy: 'people' }),
};

describe('the SQL the type-table budget tests run is the SQL TypeScript writes (#919)', () => {
  it('the Meeting view', () => {
    expect(rustConstant('MEETING_VIEW')).toBe(viewSpecsFor([type])[0]?.select);
  });

  it.each(Object.entries(STATEMENTS))('%s', (name, compiled) => {
    expect(rustConstant(name)).toBe(compiled.sql);
  });

  it('binds what the Rust tests bind', () => {
    const bound = Object.fromEntries(
      Object.entries(STATEMENTS).map(([name, { parameters }]) => [name, parameters]),
    );
    expect(bound).toEqual({
      MEETING_TABLE: [500],
      MEETING_TABLE_BY_DATE: [500],
      MEETING_TABLE_FILTERED: ['people', 'Mara', 500],
      MEETING_TABLE_TWO_LIST_FILTERS: ['people', 'Mara', 'tasks', 'Follow', 500],
      MEETING_TABLE_PERSON_IS: ['people', '[[Mara Quill]]', 500],
      MEETING_TABLE_WITHOUT_TASKS: ['tasks', 500],
      MEETING_SORT_BY_PEOPLE: [500],
      MEETING_SORT_BY_TWO_LISTS: [500],
      MEETING_COUNT: [500],
      MEETING_COUNT_FILTERED: ['people', 'Mara', 500],
      MEETING_GROUPS: [500],
      MEETING_GROUPS_BY_PEOPLE: [500],
      MEETING_GROUPS_BY_PEOPLE_FILTERED: ['people', 'Mara', 500],
    });
  });

  it('every statement the Rust tests run is one written here', () => {
    const constants = [...TESTS_RS.matchAll(/^const (MEETING_\w+): &str = r#"/gm)].map(
      (found) => found[1],
    );
    expect(constants.sort()).toEqual(['MEETING_VIEW', ...Object.keys(STATEMENTS)].sort());
  });
});
