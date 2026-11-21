import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  compileViewQuery,
  parseObjectType,
  SHIPPED_PROPERTIES,
  typeTableQuery,
  type CompiledQuery,
  type ObjectType,
} from '@dfai/domain';
import { viewSpecsFor } from './run-view.ts';

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

const STATEMENTS: Record<string, CompiledQuery> = {
  MEETING_TABLE: compileViewQuery(table),
  MEETING_TABLE_BY_DATE: compileViewQuery({
    ...table,
    sorts: [{ key: 'date', direction: 'desc' }],
  }),
  MEETING_TABLE_FILTERED: compileViewQuery({
    ...table,
    filters: [{ key: 'people', operator: 'contains', value: 'Mara' }],
    sorts: [{ key: 'start', direction: 'asc' }],
  }),
  MEETING_COUNT: compileViewQuery(table, { aggregate: { kind: 'count', column: null } }),
  MEETING_GROUPS: compileViewQuery(table, { groupBy: 'kind' }),
};

describe('the SQL the type-table budget tests run is the SQL TypeScript writes (#919)', () => {
  it('the Meeting view', () => {
    expect(rustConstant('MEETING_VIEW')).toBe(viewSpecsFor([type])[0]?.select);
  });

  it.each(Object.entries(STATEMENTS))('%s', (name, compiled) => {
    expect(rustConstant(name)).toBe(compiled.sql);
  });

  it('binds what the Rust tests bind', () => {
    expect(STATEMENTS['MEETING_TABLE_FILTERED']?.parameters).toEqual(['Mara', 500]);
    for (const name of [
      'MEETING_TABLE',
      'MEETING_TABLE_BY_DATE',
      'MEETING_COUNT',
      'MEETING_GROUPS',
    ]) {
      expect(STATEMENTS[name]?.parameters).toEqual([500]);
    }
  });
});
