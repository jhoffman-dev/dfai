import { describe, expect, it } from 'vitest';
import {
  compileViewQuery,
  filtersByLink,
  InvalidQueryError,
  viewNameFor,
  type FilterOperator,
  type ViewQuery,
} from './view-query.ts';

const query = (overrides: Partial<ViewQuery> = {}): ViewQuery => ({
  type: 'company',
  columns: [],
  filters: [],
  sorts: [],
  limit: 100,
  ...overrides,
});

const sqlOf = (overrides: Partial<ViewQuery> = {}) => compileViewQuery(query(overrides)).sql;

describe('viewNameFor', () => {
  it('names the view after the type', () => {
    expect(viewNameFor('company')).toBe('v_company');
  });

  it.each(['drop table', 'a-b', '1company', '', 'a;b', 'a"b'])(
    'refuses %j, which could not be a safe name',
    (type) => {
      expect(() => viewNameFor(type)).toThrow(InvalidQueryError);
    },
  );
});

describe('compileViewQuery', () => {
  it('always selects the path and title', () => {
    expect(sqlOf()).toContain('SELECT "path", "title"');
  });

  it('selects the requested columns in order', () => {
    expect(sqlOf({ columns: ['stage', 'arr'] })).toContain(
      'SELECT "path", "title", "stage", "arr"',
    );
  });

  it('does not select a column twice', () => {
    expect(sqlOf({ columns: ['title', 'stage'] })).toContain('SELECT "path", "title", "stage"');
  });

  it('reads from the view for the type', () => {
    expect(sqlOf()).toContain('FROM "v_company"');
  });

  it('filters on nothing but where the note lives when no filter is set', () => {
    // The page's notes are chosen by it (#919); the page then reads them by path alone.
    expect(sqlOf()).toContain(
      `WHERE substr("path", 1, 7) <> '.atlas/' AND lower(substr("path", 1, 8)) <> 'archive/'\n  ORDER BY`,
    );
  });

  it('orders by path when nothing is sorted, so results never reshuffle', () => {
    expect(sqlOf()).toContain('ORDER BY "path" ASC');
  });

  it('applies sorts before the tiebreak', () => {
    const sql = sqlOf({ sorts: [{ key: 'arr', direction: 'desc' }] });
    expect(sql).toContain(`ORDER BY NULLIF("arr", '') DESC NULLS LAST, "path" ASC`);
  });

  it('applies several sorts in order', () => {
    const sql = sqlOf({
      sorts: [
        { key: 'stage', direction: 'asc' },
        { key: 'arr', direction: 'desc' },
      ],
    });
    expect(sql).toContain(
      `ORDER BY NULLIF("stage", '') ASC NULLS LAST, NULLIF("arr", '') DESC NULLS LAST, "path" ASC`,
    );
  });

  describe('filters', () => {
    const compiled = (operator: FilterOperator, value?: unknown) =>
      compileViewQuery(query({ filters: [{ key: 'stage', operator, value: value as string }] }));

    it.each([
      ['is', 'IS ?'],
      ['isNot', 'IS NOT ?'],
      ['greaterThan', '> ?'],
      ['lessThan', '< ?'],
    ] as const)('compiles %s', (operator, expected) => {
      expect(compiled(operator, 'seed').sql).toContain(`"stage" ${expected}`);
    });

    it('compiles contains as a wildcard match on both sides', () => {
      expect(compiled('contains', 'ed').sql).toContain(`"stage" LIKE '%' || ? || '%'`);
    });

    it('compiles startsWith as a wildcard match on one side', () => {
      expect(compiled('startsWith', 'se').sql).toContain(`"stage" LIKE ? || '%'`);
    });

    it('treats an empty string and a missing value the same for isEmpty', () => {
      expect(compiled('isEmpty').sql).toContain(`("stage" IS NULL OR "stage" = '')`);
    });

    it('compiles isNotEmpty', () => {
      expect(compiled('isNotEmpty').sql).toContain(`("stage" IS NOT NULL AND "stage" <> '')`);
    });

    it('binds the value rather than writing it into the statement', () => {
      const { sql, parameters } = compiled('is', "seed'; DROP TABLE files;--");
      expect(sql).not.toContain('DROP');
      expect(parameters).toContain("seed'; DROP TABLE files;--");
    });

    it('binds a number as a number', () => {
      expect(compiled('greaterThan', 1000).parameters[0]).toBe(1000);
    });

    it('binds a boolean as the text the index stores', () => {
      expect(compiled('is', true).parameters[0]).toBe('true');
    });

    it('takes no value for the operators that need none', () => {
      expect(compiled('isEmpty').parameters).toEqual([100]);
    });

    it.each(['is', 'contains', 'greaterThan'] as const)(
      'refuses %s with no value to compare against',
      (operator) => {
        expect(() => compiled(operator)).toThrow(InvalidQueryError);
      },
    );

    it('joins several filters with AND', () => {
      const sql = compileViewQuery(
        query({
          filters: [
            { key: 'stage', operator: 'is', value: 'seed' },
            { key: 'arr', operator: 'greaterThan', value: 100 },
          ],
        }),
      ).sql;
      expect(sql).toContain('AND "stage" IS ? AND "arr" > ?');
    });

    it('binds filter values in the order they appear, before the limit', () => {
      const { parameters } = compileViewQuery(
        query({
          limit: 25,
          filters: [
            { key: 'stage', operator: 'is', value: 'seed' },
            { key: 'arr', operator: 'greaterThan', value: 100 },
          ],
        }),
      );
      expect(parameters).toEqual(['seed', 100, 25]);
    });
  });

  describe('limits', () => {
    it('binds the limit', () => {
      expect(compileViewQuery(query({ limit: 25 })).parameters).toEqual([25]);
      expect(sqlOf({ limit: 25 })).toContain('LIMIT ?');
    });

    it('falls back to a default when none is given', () => {
      expect(compileViewQuery(query({ limit: 0 })).parameters).toEqual([500]);
    });

    it('caps a limit that would return the whole vault', () => {
      expect(compileViewQuery(query({ limit: 1_000_000 })).parameters).toEqual([5000]);
    });

    it('rounds a fractional limit', () => {
      expect(compileViewQuery(query({ limit: 10.7 })).parameters).toEqual([10]);
    });
  });

  describe('names that could not be safe', () => {
    it.each(['a b', 'a;b', 'a--b', '"a"', 'drop table files'])('refuses column %j', (column) => {
      expect(() => compileViewQuery(query({ columns: [column] }))).toThrow(InvalidQueryError);
    });

    it('refuses an unsafe filter column', () => {
      expect(() =>
        compileViewQuery(query({ filters: [{ key: 'a;b', operator: 'isEmpty' }] })),
      ).toThrow(InvalidQueryError);
    });

    it('refuses an unsafe sort column', () => {
      expect(() => compileViewQuery(query({ sorts: [{ key: 'a b', direction: 'asc' }] }))).toThrow(
        InvalidQueryError,
      );
    });

    it('refuses an unsafe type', () => {
      expect(() => compileViewQuery(query({ type: 'a b' }))).toThrow(InvalidQueryError);
    });
  });
});

describe('relative dates', () => {
  const withFilter = (value: string) =>
    compileViewQuery(query({ filters: [{ key: 'due', operator: 'lessThan', value }] }));

  it('compiles @today to a date expression rather than binding it', () => {
    const { sql, parameters } = withFilter('@today');
    expect(sql).toContain(`"due" < date('now', 'localtime')`);
    // Only the limit is bound: the date is part of the statement.
    expect(parameters).toEqual([100]);
  });

  it.each([
    ['@yesterday', "'-1 day'"],
    ['@tomorrow', "'+1 day'"],
    ['@weekAgo', "'-7 days'"],
    ['@weekAhead', "'+7 days'"],
    ['@monthAhead', "'+1 month'"],
  ])('compiles %s', (value, expected) => {
    expect(withFilter(value).sql).toContain(expected);
  });

  it('keeps a real date bound as a value', () => {
    const { sql, parameters } = withFilter('2026-09-20');
    expect(sql).toContain('"due" < ?');
    expect(parameters).toEqual(['2026-09-20', 100]);
  });

  it('binds text that only looks like a relative date', () => {
    const { sql, parameters } = withFilter('@whenever');
    expect(sql).toContain('"due" < ?');
    expect(parameters).toEqual(['@whenever', 100]);
  });

  it('works with every operator that takes a value', () => {
    const sql = compileViewQuery(
      query({
        filters: [
          { key: 'due', operator: 'greaterThan', value: '@yesterday' },
          { key: 'due', operator: 'lessThan', value: '@tomorrow' },
        ],
      }),
    ).sql;
    expect(sql).toContain(`"due" > date('now', 'localtime', '-1 day')`);
    expect(sql).toContain(`"due" < date('now', 'localtime', '+1 day')`);
  });
});

describe('shaping a query', () => {
  const shaped = (shape: Parameters<typeof compileViewQuery>[1]): string =>
    compileViewQuery(
      {
        type: 'task',
        columns: [],
        filters: [],
        sorts: [{ key: 'due', direction: 'asc' }],
        limit: 20,
      },
      shape,
    ).sql;

  it('counts rows instead of returning them', () => {
    expect(shaped({ aggregate: { kind: 'count', column: null } })).toContain(
      'SELECT COUNT(*) AS "value"',
    );
  });

  it('applies the function for the kind to the column', () => {
    expect(shaped({ aggregate: { kind: 'average', column: 'estimate' } })).toContain(
      'SELECT AVG("estimate") AS "value"',
    );
  });

  it('ignores the column for a count, which has nothing to count over', () => {
    expect(shaped({ aggregate: { kind: 'count', column: 'estimate' } })).toContain(
      'SELECT COUNT(*) AS "value"',
    );
  });

  it('does not order an aggregate, which is one row', () => {
    expect(shaped({ aggregate: { kind: 'sum', column: 'estimate' } })).not.toContain('ORDER BY');
  });

  it('refuses an aggregate column that is not a plain name', () => {
    expect(() => shaped({ aggregate: { kind: 'sum', column: 'estimate"; drop' } })).toThrow(
      InvalidQueryError,
    );
  });

  it('counts per distinct value when grouping', () => {
    const sql = shaped({ groupBy: 'status' });
    expect(sql).toContain('SELECT COALESCE("status", \'\') AS "label", COUNT(*) AS "count"');
    expect(sql).toContain('GROUP BY COALESCE("status", \'\')');
  });

  it('puts the biggest group first and breaks ties by name', () => {
    expect(shaped({ groupBy: 'status' })).toContain('ORDER BY "count" DESC, "label" ASC');
  });

  it('refuses a group column that is not a plain name', () => {
    expect(() => shaped({ groupBy: 'status OR 1=1' })).toThrow(InvalidQueryError);
  });

  it('still filters when shaped', () => {
    const compiled = compileViewQuery(
      {
        type: 'task',
        columns: [],
        filters: [{ key: 'status', operator: 'isNot', value: 'done' }],
        sorts: [],
        limit: 20,
      },
      { groupBy: 'phase' },
    );
    expect(compiled.sql).toContain('AND "status" IS NOT ?');
    expect(compiled.parameters).toEqual(['done', 20]);
  });

  it('returns rows as before when nothing is shaped', () => {
    expect(shaped({})).toContain('SELECT "path", "title"');
  });
});

describe('a filter by a link (#212)', () => {
  const byProject = (operator: FilterOperator, value: string) =>
    query({ type: 'task', filters: [{ key: 'project', operator, value }] });
  const opens = (target: string) =>
    target === 'Larkspur launch' ? 'projects/Larkspur launch.md' : null;

  it('compares by the note the link opens when links can be resolved', () => {
    const { sql, parameters } = compileViewQuery(
      byProject('is', '[[Larkspur launch|Launch]]'),
      {},
      {
        resolveLink: opens,
      },
    );
    expect(sql).toContain(
      'EXISTS (SELECT 1 FROM relations AS r WHERE r.src = "path" AND r.key = ? AND r.dst = ?)',
    );
    expect(parameters.slice(0, 2)).toEqual(['project', 'projects/Larkspur launch.md']);
  });

  it('is not leaves out the notes linking it; a link to no note compares by its folded name', () => {
    const { sql, parameters } = compileViewQuery(
      byProject('isNot', '[[Someday Plan]]'),
      {},
      {
        resolveLink: opens,
      },
    );
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM relations AS r');
    expect(sql).toContain('r.name = ?');
    expect(parameters.slice(0, 2)).toEqual(['project', 'someday plan']);
  });

  it('compares the text as it is without a resolver, or for a text search', () => {
    expect(compileViewQuery(byProject('is', '[[Larkspur launch]]')).sql).toContain(
      '"project" IS ?',
    );
    expect(
      compileViewQuery(byProject('contains', '[[Larkspur launch]]'), {}, { resolveLink: opens })
        .sql,
    ).not.toContain('relations');
  });

  it('is told apart from a view filtered by no link', () => {
    expect(filtersByLink(byProject('is', '[[Larkspur launch]]'))).toBe(true);
    expect(filtersByLink(byProject('isNot', '[[Larkspur launch]]'))).toBe(true);
    expect(filtersByLink(byProject('contains', '[[Larkspur launch]]'))).toBe(false);
    expect(filtersByLink(byProject('is', 'Larkspur launch'))).toBe(false);
    expect(filtersByLink(query({ filters: [{ key: 'project', operator: 'isEmpty' }] }))).toBe(
      false,
    );
  });
});

describe('a filter on tags (#212)', () => {
  it('compares a tag however it is cased, without its #', () => {
    const { sql, parameters } = compileViewQuery(
      query({ type: 'task', filters: [{ key: 'tags', operator: 'isNot', value: '#Errand' }] }),
    );
    expect(sql).toContain('"tags" IS NOT ? COLLATE NOCASE');
    expect(parameters[0]).toBe('Errand');
  });
});
