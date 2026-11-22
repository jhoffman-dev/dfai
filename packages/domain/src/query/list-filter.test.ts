import { describe, expect, it } from 'vitest';
import { typeViewSelectSql, type TypeViewColumn } from '../query-language/type-view.ts';
import { listColumnOf, listCondition, viewJoinsItemsSql } from './list-filter.ts';
import { compileViewQuery, type QueryFilter, type QueryReach } from './view-query.ts';

const PEOPLE: TypeViewColumn = { key: 'people', kind: 'relation', many: true };
const TAGS: TypeViewColumn = { key: 'tags', kind: 'multiSelect', many: false };
const COLUMNS: readonly TypeViewColumn[] = [
  PEOPLE,
  TAGS,
  { key: 'scores', kind: 'number', many: true },
  { key: 'days', kind: 'date', many: true },
  { key: 'kind', kind: 'text', many: false },
  { key: 'project', kind: 'relation', many: false },
];

const LOOKUP = 'FROM props AS p WHERE p.path = "v_meeting"."path" AND p.key = ?';

describe('listColumnOf', () => {
  it('finds a list of text by its key in any case, as SQLite reads a column name', () => {
    expect(listColumnOf('people', COLUMNS)).toBe(PEOPLE);
    expect(listColumnOf('PEOPLE', COLUMNS)).toBe(PEOPLE);
    expect(listColumnOf('tags', COLUMNS)).toBe(TAGS);
  });

  it('finds no list of numbers or dates, no single value, and nothing without the columns', () => {
    for (const key of ['scores', 'days', 'kind', 'project', 'title', 'undeclared']) {
      expect(listColumnOf(key, COLUMNS)).toBeNull();
    }
    expect(listColumnOf('people', undefined)).toBeNull();
  });

  it('finds none where two columns are spelt alike, nor where a key is no identifier', () => {
    const twice = [PEOPLE, { ...PEOPLE, key: 'People' }];
    expect(listColumnOf('people', twice)).toBeNull();
    // U+212A KELVIN SIGN lower-cases to `k` in JavaScript, never in SQLite.
    expect(listColumnOf('k', [{ key: 'K', kind: 'text', many: true }])).toBeNull();
  });
});

describe('listCondition', () => {
  const SITE = { table: '"v_meeting"', view: 'v_meeting' };
  const lookup = (filter: Omit<QueryFilter, 'key'>) => {
    const parameters: (string | number)[] = [];
    const sql = listCondition(
      {
        column: PEOPLE,
        operator: filter.operator,
        value: typeof filter.value === 'string' ? filter.value : undefined,
      },
      SITE,
      parameters,
    );
    return { sql, parameters };
  };

  it('asks the note’s own items, by its path in the view, binding the key and then the value', () => {
    expect(lookup({ operator: 'contains', value: 'Mara' })).toEqual({
      sql: `EXISTS (SELECT 1 FROM props AS p WHERE p.path = "v_meeting"."path" AND p.key = ? AND p.value_text <> '' AND p.value_text LIKE '%' || ? || '%')`,
      parameters: ['people', 'Mara'],
    });
    expect(lookup({ operator: 'isEmpty' }).parameters).toEqual(['people']);
  });

  it('compares the one item a note holds as the cell is compared, by IS', () => {
    expect(lookup({ operator: 'is', value: '[[Mara Quill]]' }).sql).toBe(
      `(SELECT CASE WHEN count(*) = 1 THEN max(p.value_text) END FROM props AS p WHERE p.path = "v_meeting"."path" AND p.key = ? AND p.value_text <> '') IS ?`,
    );
    expect(lookup({ operator: 'isNot', value: '[[Mara Quill]]' }).sql).toMatch(/\) IS NOT \?$/);
  });

  it('leaves out, rather than keeps, the notes holding an item for is empty', () => {
    expect(lookup({ operator: 'isEmpty' }).sql).toMatch(/^NOT EXISTS /);
    expect(lookup({ operator: 'isNotEmpty' }).sql).toMatch(/^EXISTS /);
  });

  it('takes no pattern that could match across the separator, and binds nothing then', () => {
    for (const value of ['a, b', 'a,b', ', b', ' b', '%', 'x_y']) {
      expect(lookup({ operator: 'contains', value })).toEqual({ sql: null, parameters: [] });
    }
    expect(lookup({ operator: 'is', value: 'a, b' }).sql).toBeNull();
    expect(lookup({ operator: 'is', value: 'a,b' }).sql).not.toBeNull();
  });

  it('leaves startsWith to the cell: only the table knows an item’s place (#929)', () => {
    expect(lookup({ operator: 'startsWith', value: '[[' })).toEqual({ sql: null, parameters: [] });
  });

  it('leaves greater and less than to the cell, which compare past the first item', () => {
    expect(lookup({ operator: 'greaterThan', value: 'm' }).sql).toBeNull();
    expect(lookup({ operator: 'lessThan', value: 'm' }).sql).toBeNull();
  });
});

describe('compileViewQuery with the view’s columns (#923)', () => {
  const compiled = (filter: QueryFilter, reach: QueryReach = {}) =>
    compileViewQuery(
      { type: 'meeting', columns: [], filters: [filter], sorts: [], limit: 10 },
      {},
      { viewColumns: COLUMNS, ...reach },
    );

  it('looks a list filter up by its items, where the view the index holds joins them', () => {
    const { sql, parameters } = compiled({ key: 'People', operator: 'contains', value: 'Mara' });
    expect(sql).toContain(
      `CASE WHEN ${viewJoinsItemsSql(PEOPLE, { table: '"v_meeting"', view: 'v_meeting' })} THEN EXISTS (`,
    );
    expect(sql).toContain(LOOKUP);
    // Else the cell, as main compares it.
    expect(sql).toContain(`ELSE "People" LIKE '%' || ? || '%' END`);
    // The key the index holds, not the filter's spelling of it; then the cell's value.
    expect(parameters).toEqual(['people', 'Mara', 'Mara', 10]);
  });

  it('asks the view for the cell exactly as the view writes it', () => {
    const check = viewJoinsItemsSql(PEOPLE, { table: '"v_meeting"', view: 'v_meeting' });
    const select = typeViewSelectSql({ name: 'meeting', columns: [PEOPLE], progress: false }) ?? '';
    const cell = /instr\(sql, '(.*)'\) > 0/.exec(check)?.[1]?.replaceAll("''", "'") ?? '';
    expect(cell).toContain('AS "people"');
    expect(select).toContain(cell);
  });

  it('compares a tag without regard to case, its # and spaces left off', () => {
    const { sql, parameters } = compiled({ key: 'tags', operator: 'is', value: ' #Errand ' });
    expect(sql).toContain(') IS ? COLLATE NOCASE ELSE "tags" IS ? COLLATE NOCASE END');
    expect(parameters).toEqual(['tags', 'Errand', 'Errand', 10]);
  });

  it('keeps a link filter by the note it opens', () => {
    const resolveLink = () => 'people/Mara Quill.md';
    const { sql } = compiled(
      { key: 'people', operator: 'is', value: '[[Mara Quill]]' },
      { resolveLink },
    );
    expect(sql).toContain('FROM relations AS r');
    expect(sql).not.toContain(LOOKUP);
  });

  it('compares the cell for a number, a relative date, a single value or an unsafe pattern', () => {
    const cell: QueryFilter[] = [
      { key: 'people', operator: 'contains', value: 5 },
      { key: 'people', operator: 'contains', value: '@today' },
      { key: 'kind', operator: 'contains', value: 'sync' },
      { key: 'people', operator: 'contains', value: 'a, b' },
      { key: 'people', operator: 'greaterThan', value: 'm' },
    ];
    for (const filter of cell) expect(compiled(filter).sql).not.toContain(LOOKUP);
  });

  it('still refuses a filter with no value, by the same words', () => {
    expect(() => compiled({ key: 'people', operator: 'contains' })).toThrow(
      'contains needs a value',
    );
  });
});
