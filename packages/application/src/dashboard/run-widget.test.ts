import { parseDashboard, parseObjectType, type Widget } from '@dfai/domain';
import { describe, expect, it } from 'vitest';
import { fakeIndexPort } from '../testing/fake-ports.ts';
import { runDashboard, runWidget } from './run-widget.ts';

const widgetFor = (source: Record<string, unknown>): Widget => {
  const [widget] = parseDashboard({ atlas: 'dashboard', widgets: [source] });
  if (widget === undefined) throw new Error('the test asked for a widget that does not parse');
  return widget;
};

const indexReturning = (result: {
  columns: string[];
  rows: unknown[][];
}): ReturnType<typeof fakeIndexPort> =>
  fakeIndexPort({ query: async () => ({ ...result, truncated: false }) });

describe('runWidget', () => {
  it('reports the number for an aggregate widget', async () => {
    const result = await runWidget({
      index: indexReturning({ columns: ['value'], rows: [[7]] }),
      widget: widgetFor({ kind: 'number', type: 'task' }),
    });
    expect(result.data).toEqual({ shape: 'number', value: '7' });
  });

  it('formats the number the way its kind reads', async () => {
    const result = await runWidget({
      index: indexReturning({ columns: ['value'], rows: [[3.14159]] }),
      widget: widgetFor({ kind: 'number', type: 'task', aggregate: 'average', of: 'estimate' }),
    });
    expect(result.data).toEqual({ shape: 'number', value: '3.14' });
  });

  it('shows a dash when an aggregate has nothing to work over', async () => {
    const result = await runWidget({
      index: indexReturning({ columns: ['value'], rows: [[null]] }),
      widget: widgetFor({ kind: 'number', type: 'task', aggregate: 'sum', of: 'estimate' }),
    });
    expect(result.data).toEqual({ shape: 'number', value: '—' });
  });

  it('shows a dash when the view itself is empty', async () => {
    const result = await runWidget({
      index: indexReturning({ columns: ['value'], rows: [] }),
      widget: widgetFor({ kind: 'number', type: 'task', aggregate: 'latest', of: 'due' }),
    });
    expect(result.data).toEqual({ shape: 'number', value: '—' });
  });

  it('asks the index for the aggregate rather than for the rows', async () => {
    let asked = '';
    await runWidget({
      index: fakeIndexPort({
        query: async (sql) => {
          asked = sql;
          return { columns: ['value'], rows: [[2]], truncated: false };
        },
      }),
      widget: widgetFor({ kind: 'number', type: 'task', aggregate: 'sum', of: 'estimate' }),
    });
    expect(asked).toContain('SUM("estimate")');
  });

  it('turns a grouped result into bars with their shares, biggest first', async () => {
    const result = await runWidget({
      index: indexReturning({
        columns: ['label', 'count'],
        rows: [
          ['doing', 3],
          ['done', 1],
        ],
      }),
      widget: widgetFor({ kind: 'bar', type: 'task', groupBy: 'status' }),
    });
    expect(result.data).toEqual({
      shape: 'bars',
      bars: [
        { label: 'doing', count: 3, share: 75 },
        { label: 'done', count: 1, share: 25 },
      ],
      unset: 0,
      total: 4,
      highlight: 'doing',
    });
  });

  it('puts a numeric grouping on the axis in number order and calls out the last', async () => {
    const result = await runWidget({
      index: indexReturning({
        columns: ['label', 'count'],
        rows: [
          [13, 33],
          [2, 6],
          [10, 7],
        ],
      }),
      widget: widgetFor({ kind: 'bar', type: 'task', groupBy: 'phase' }),
    });
    if (result.data.shape !== 'bars') throw new Error(`expected bars, got ${result.data.shape}`);
    expect(result.data.bars.map((bar) => bar.label)).toEqual(['2', '10', '13']);
    expect(result.data.highlight).toBe('13');
  });

  it('follows a declared highlight rule', async () => {
    const result = await runWidget({
      index: indexReturning({
        columns: ['label', 'count'],
        rows: [
          [13, 33],
          [2, 6],
        ],
      }),
      widget: widgetFor({ kind: 'bar', type: 'task', groupBy: 'phase', highlight: 2 }),
    });
    expect(result.data).toMatchObject({ highlight: '2' });
  });

  it('keeps the notes with no value off the axis and counts them apart', async () => {
    const result = await runWidget({
      index: indexReturning({
        columns: ['label', 'count'],
        rows: [
          [1, 3],
          [null, 2],
        ],
      }),
      widget: widgetFor({ kind: 'bar', type: 'task', groupBy: 'phase' }),
    });
    expect(result.data).toEqual({
      shape: 'bars',
      bars: [{ label: '1', count: 3, share: 60 }],
      unset: 2,
      total: 5,
      highlight: '1',
    });
  });

  it('runs a line along its keys in number order, calling nothing out', async () => {
    const result = await runWidget({
      index: indexReturning({
        columns: ['label', 'count'],
        rows: [
          [10, 1],
          [9, 5],
          [11, 2],
        ],
      }),
      widget: widgetFor({ kind: 'line', type: 'task', groupBy: 'phase' }),
    });
    if (result.data.shape !== 'bars') throw new Error(`expected bars, got ${result.data.shape}`);
    expect(result.data.bars.map((bar) => bar.label)).toEqual(['9', '10', '11']);
    expect(result.data.highlight).toBeNull();
  });

  it('lists every option of a select in a donut, the ones nothing has yet as zero', async () => {
    const result = await runWidget({
      index: indexReturning({
        columns: ['label', 'count'],
        rows: [
          ['done', 166],
          ['backlog', 11],
        ],
      }),
      widget: widgetFor({ kind: 'donut', type: 'task', groupBy: 'status' }),
      types: [
        {
          name: 'task',
          label: 'Task',
          properties: [
            {
              key: 'status',
              kind: 'select',
              label: 'Status',
              required: false,
              options: ['backlog', 'next', 'done'],
              target: null,
              many: false,
            },
          ],
        },
      ],
    });
    expect(result.data).toEqual({
      shape: 'bars',
      bars: [
        { label: 'done', count: 166, share: 94 },
        { label: 'backlog', count: 11, share: 6 },
        { label: 'next', count: 0, share: 0 },
      ],
      unset: 0,
      total: 177,
      highlight: null,
    });
  });

  it("keeps a donut's no-value notes as a slice of the whole", async () => {
    const result = await runWidget({
      index: indexReturning({
        columns: ['label', 'count'],
        rows: [
          ['done', 3],
          [null, 1],
        ],
      }),
      widget: widgetFor({ kind: 'donut', type: 'task', groupBy: 'status' }),
    });
    expect(result.data).toMatchObject({
      bars: [
        { label: 'done', count: 3, share: 75 },
        { label: '', count: 1, share: 25 },
      ],
      unset: 0,
    });
  });

  it("gathers a donut's tail into Other, and its share with it", async () => {
    const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((label, at) => [label, 8 - at]);
    const result = await runWidget({
      index: indexReturning({ columns: ['label', 'count'], rows }),
      widget: widgetFor({ kind: 'donut', type: 'task', groupBy: 'status' }),
    });
    if (result.data.shape !== 'bars') throw new Error(`expected bars, got ${result.data.shape}`);
    // 8+7+6+5+4+3 are drawn; 2+1 are gathered, 3 of 36.
    expect(result.data.bars.at(-1)).toEqual({ label: 'Other', count: 3, share: 8 });
    expect(result.data.bars.reduce((sum, bar) => sum + bar.share, 0)).toBe(100);
  });

  it('ranks the largest groups against every note, with or without a value', async () => {
    const result = await runWidget({
      index: indexReturning({
        columns: ['label', 'count'],
        rows: [
          [13, 33],
          [12, 29],
          [15, 12],
          [0, 5],
          [null, 7],
        ],
      }),
      widget: widgetFor({ kind: 'rank', type: 'task', groupBy: 'phase', limit: 2 }),
    });
    expect(result.data).toEqual({
      shape: 'rank',
      rows: [
        { label: '13', count: 33, fraction: 1 },
        { label: '12', count: 29, fraction: 29 / 33 },
      ],
      shown: 62,
      total: 86,
      highlight: '15',
    });
  });

  it('reports an error when a chart query comes back without groups', async () => {
    const result = await runWidget({
      index: indexReturning({ columns: ['path'], rows: [['a.md']] }),
      widget: widgetFor({ kind: 'bar', type: 'task', groupBy: 'status' }),
    });
    expect(result.data).toEqual({
      shape: 'error',
      message: 'the chart query returned no groups',
    });
  });

  it('keys each row of a table by column name', async () => {
    const result = await runWidget({
      index: indexReturning({
        columns: ['path', 'title', 'status'],
        rows: [['tasks/a.md', 'Write it', 'doing']],
      }),
      widget: widgetFor({ kind: 'table', type: 'task', columns: ['status'] }),
    });
    expect(result.data).toEqual({
      shape: 'rows',
      columns: ['path', 'title', 'status'],
      rows: [
        {
          path: 'tasks/a.md',
          title: 'Write it',
          values: { path: 'tasks/a.md', title: 'Write it', status: 'doing' },
        },
      ],
    });
  });

  it('reports the SQL it ran', async () => {
    const result = await runWidget({
      index: indexReturning({ columns: ['value'], rows: [[1]] }),
      widget: widgetFor({ kind: 'number', type: 'task' }),
    });
    expect(result.sql).toContain('FROM "v_task"');
  });

  it('reports a failing query as a result rather than rejecting', async () => {
    const result = await runWidget({
      index: fakeIndexPort({
        query: async () => {
          throw new Error('no such table: v_gone');
        },
      }),
      widget: widgetFor({ kind: 'table', type: 'gone' }),
    });
    expect(result.data).toEqual({ shape: 'error', message: 'no such table: v_gone' });
  });

  it('still reports the SQL when the query failed', async () => {
    const result = await runWidget({
      index: fakeIndexPort({
        query: async () => {
          throw new Error('no such column');
        },
      }),
      widget: widgetFor({ kind: 'table', type: 'task' }),
    });
    expect(result.sql).toContain('FROM "v_task"');
  });

  it('reports a query it could not even compile', async () => {
    const result = await runWidget({
      index: fakeIndexPort(),
      widget: {
        ...widgetFor({ kind: 'table', type: 'task' }),
        query: { type: 'task', columns: ['nope; drop'], filters: [], sorts: [], limit: 5 },
      },
    });
    expect(result.sql).toBeNull();
    expect(result.data.shape).toBe('error');
  });
});

describe('runDashboard', () => {
  it('runs every widget and keeps them in order', async () => {
    const results = await runDashboard({
      index: indexReturning({ columns: ['value'], rows: [[4]] }),
      widgets: parseDashboard({
        atlas: 'dashboard',
        widgets: [
          { kind: 'number', type: 'task', title: 'First' },
          { kind: 'number', type: 'task', title: 'Second' },
        ],
      }),
    });
    expect(results.map((result) => result.widget.title)).toEqual(['First', 'Second']);
  });

  it('draws the rest when one widget fails', async () => {
    let call = 0;
    const index = fakeIndexPort({
      query: async () => {
        call += 1;
        if (call === 1) throw new Error('broken');
        return { columns: ['value'], rows: [[9]], truncated: false };
      },
    });

    const results = await runDashboard({
      index,
      widgets: parseDashboard({
        atlas: 'dashboard',
        widgets: [
          { kind: 'number', type: 'task' },
          { kind: 'number', type: 'task' },
        ],
      }),
    });
    expect(results.map((result) => result.data.shape)).toEqual(['error', 'number']);
  });

  it('reports nothing for a dashboard with no widgets', async () => {
    expect(await runDashboard({ index: fakeIndexPort(), widgets: [] })).toEqual([]);
  });
});

describe('a hero widget', () => {
  const hero = {
    kind: 'hero',
    type: 'task',
    groupBy: 'phase',
    progress: { filters: [{ key: 'status', operator: 'is', value: 'done' }] },
  };

  /** Answers the count, the done count and the groups by what the SQL asks. */
  const heroIndex = (asked: string[] = []) =>
    fakeIndexPort({
      query: async (sql) => {
        asked.push(sql);
        if (sql.includes('GROUP BY')) {
          return {
            columns: ['label', 'count'],
            rows: [
              [10, 4],
              [2, 3],
              [null, 1],
            ],
            truncated: false,
          };
        }
        // Every query leaves `.atlas` out, so only the progress filter tells the
        // done count from the total.
        return { columns: ['value'], rows: [[sql.includes('"status"') ? 6 : 8]], truncated: false };
      },
    });

  it('reports the total, the done part, and the groups in key order', async () => {
    const result = await runWidget({ index: heroIndex(), widget: widgetFor(hero) });
    expect(result.data).toEqual({
      shape: 'hero',
      total: 8,
      part: { label: 'done', count: 6 },
      groups: [
        { label: '2', count: 3 },
        { label: '10', count: 4 },
      ],
      highlight: { label: '10', count: 4 },
    });
  });

  it('narrows the done count by the progress filters and nothing else', async () => {
    const asked: string[] = [];
    await runWidget({ index: heroIndex(asked), widget: widgetFor(hero) });
    expect(asked).toHaveLength(3);
    expect(asked.filter((sql) => sql.includes('"status"'))).toHaveLength(1);
  });

  it('asks only for the count when it declares neither progress nor a grouping', async () => {
    const asked: string[] = [];
    const result = await runWidget({
      index: heroIndex(asked),
      widget: widgetFor({ kind: 'hero', type: 'task' }),
    });
    expect(asked).toHaveLength(1);
    expect(result.data).toEqual({
      shape: 'hero',
      total: 8,
      part: null,
      groups: [],
      highlight: null,
    });
  });

  it('reports the plain count as its SQL', async () => {
    const result = await runWidget({ index: heroIndex(), widget: widgetFor(hero) });
    expect(result.sql).toContain('COUNT(*)');
    expect(result.sql).not.toContain('GROUP BY');
  });

  it('fails as a tile when any of its questions fails', async () => {
    const result = await runWidget({
      index: fakeIndexPort({
        query: async (sql) => {
          if (sql.includes('GROUP BY')) throw new Error('no such column: phase');
          return { columns: ['value'], rows: [[1]], truncated: false };
        },
      }),
      widget: widgetFor(hero),
    });
    expect(result.data).toEqual({ shape: 'error', message: 'no such column: phase' });
  });
});

describe('a donut over a select with more values than it has slices', () => {
  const select = (options: string[]) => [
    {
      name: 'task',
      label: 'Task',
      properties: [
        {
          key: 'status',
          kind: 'select' as const,
          label: 'Status',
          required: false,
          options,
          target: null,
          many: false,
        },
      ],
    },
  ];
  const labels = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  // 8+7+6+5+4+3 are drawn; g (2) and h (1) are gathered into Other.
  const rows = labels.map((label, at) => [label, 8 - at]);

  it('never lists an option as empty when its notes were gathered into Other', async () => {
    const result = await runWidget({
      index: indexReturning({ columns: ['label', 'count'], rows }),
      widget: widgetFor({ kind: 'donut', type: 'task', groupBy: 'status' }),
      types: select(labels),
    });
    if (result.data.shape !== 'bars') throw new Error(`expected bars, got ${result.data.shape}`);
    expect(result.data.bars.find((bar) => bar.label === 'Other')?.count).toBe(3);
    // `g` has two notes; a legend row reading "g 0" says the stage is empty.
    expect(result.data.bars.filter((bar) => bar.label === 'g' && bar.count === 0)).toEqual([]);
  });

  it('counts every note once: the slices add up to the total', async () => {
    const result = await runWidget({
      index: indexReturning({ columns: ['label', 'count'], rows }),
      widget: widgetFor({ kind: 'donut', type: 'task', groupBy: 'status' }),
      types: select(labels),
    });
    if (result.data.shape !== 'bars') throw new Error(`expected bars, got ${result.data.shape}`);
    const labelsShown = result.data.bars.map((bar) => bar.label);
    expect(new Set(labelsShown).size).toBe(labelsShown.length);
    expect(result.data.bars.reduce((sum, bar) => sum + bar.count, 0)).toBe(result.data.total);
  });

  it('keeps a real option named Other apart from the gathered tail', async () => {
    const withOther = ['Other', ...labels.slice(1)];
    const result = await runWidget({
      index: indexReturning({
        columns: ['label', 'count'],
        rows: withOther.map((label, at) => [label, 8 - at]),
      }),
      widget: widgetFor({ kind: 'donut', type: 'task', groupBy: 'status' }),
      types: select(withOther),
    });
    if (result.data.shape !== 'bars') throw new Error(`expected bars, got ${result.data.shape}`);
    const shown = result.data.bars.map((bar) => bar.label);
    expect(new Set(shown).size).toBe(shown.length);
  });
});

describe('runWidget: a query widget (ADR-0019)', () => {
  const types = [
    parseObjectType({
      name: 'task',
      properties: {
        status: { kind: 'select', options: ['doing', 'done'] },
        owner: { kind: 'relation', target: 'person' },
      },
    }),
    parseObjectType({ name: 'person', properties: {} }),
  ];

  it('runs the query and hands back its rows in their groups', async () => {
    const asked: unknown[][] = [];
    const index = fakeIndexPort({
      query: async (_sql, parameters) => {
        asked.push([...parameters]);
        return {
          columns: ['path', 'title', 'type', 'status'],
          rows: [
            ['a.md', 'A', 'task', 'done'],
            ['b.md', 'B', 'task', 'doing'],
          ],
          truncated: false,
        };
      },
    });
    const result = await runWidget({
      index,
      types,
      notePaths: ['people/Julie.md'],
      widget: widgetFor({
        kind: 'query',
        query: 'FROM task WHERE owner = [[Julie]] GROUP BY status',
      }),
    });
    expect(result.sql?.startsWith('/* atlas-query */')).toBe(true);
    expect(asked[0]).toContain('people/Julie.md');
    if (result.data.shape !== 'grouped') throw new Error(`drew ${result.data.shape}`);
    expect(result.data.fields).toEqual([
      { key: 'type', label: 'Type', kind: 'type' },
      { key: 'status', label: 'Status', kind: 'select' },
      { key: 'owner', label: 'Owner', kind: 'relation' },
    ]);
    expect(
      result.data.groups.map((group) => [group.label, group.rows.map((row) => row.title)]),
    ).toEqual([
      ['doing', ['B']],
      ['done', ['A']],
    ]);
  });

  it('reports a query the vault cannot answer in its own tile', async () => {
    const result = await runWidget({
      index: fakeIndexPort(),
      types,
      widget: widgetFor({ kind: 'query', query: 'FROM tsk' }),
    });
    expect(result.data).toEqual({ shape: 'error', message: 'There is no type called tsk.' });
  });
});
