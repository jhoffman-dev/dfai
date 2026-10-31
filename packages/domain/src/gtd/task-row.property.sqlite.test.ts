import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { indexablePropertiesOf } from '../index/property-value.ts';
import { toBoardRows } from '../query/group-rows.ts';
import { parseRecurrence } from '../query/recurrence.ts';
import { compileAtlasQuery } from '../query-language/compile.ts';
import { parseAtlasQuery } from '../query-language/parse.ts';
import { compileReviewTasksQuery, reviewTask } from '../review/review-query.ts';
import { focusIsOwn, taskAsRead } from '../today/row-read.ts';
import { TASK_TYPE_FILE } from './task-type.ts';
import { taskRowState } from './task-row.ts';

/**
 * Attack on PR #625 (#107): over seeded random task frontmatter, the hidden
 * `task:*` columns read each task as the write reads its file (`taskAsRead`,
 * `focusIsOwn`, `parseRecurrence`) and as Today's statement reads the index.
 */
function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const STATUS_SHAPES: readonly unknown[] = [
  'next-action',
  ' waiting ',
  'archive',
  'Next-Action',
  '',
  null,
  5,
  true,
  ['someday'],
  ['archive', 'next-action'],
  ['next-action', ''],
  [['waiting']],
  [['next-action', 'waiting']],
  { status: 'inbox' },
  [],
  ['', ''],
  'junk',
];
const DAY_SHAPES: readonly unknown[] = [
  '2026-10-28',
  '2026-12-31T23:30',
  '2026-10-28T09:00:00-07:00',
  ' 2026-01-01 ',
  '',
  null,
  'tomorrow',
  20261028,
  ['2026-10-29'],
  ['x', '2026-11-02'],
  [['2026-10-05', '2026-10-01']],
  ['2026-10-28', '2026-10-29'],
  ['', '2026-10-30'],
  { day: '2026-10-28' },
];
const RECURRENCE_SHAPES: readonly unknown[] = [
  'every day',
  'every week',
  'every 2 weeks',
  'every month',
  'every year',
  'weekly',
  'every 0 days',
  '',
  null,
  ['every week'],
  ['', 'every day'],
  'nonsense',
  7,
];

function frontmatterOf(next: () => number): Record<string, unknown> {
  const pick = <T>(shapes: readonly T[]) => shapes[Math.floor(next() * shapes.length)] as T;
  const properties: Record<string, unknown> = { type: 'task' };
  const maybe = (key: string, shapes: readonly unknown[]) => {
    if (next() < 0.8) properties[key] = pick(shapes);
  };
  maybe('status', STATUS_SHAPES);
  maybe('due', DAY_SHAPES);
  maybe('defer', DAY_SHAPES);
  maybe('focus', [...DAY_SHAPES, 'when the rain stops']);
  maybe('recurrence', RECURRENCE_SHAPES);
  return properties;
}

function indexOf(notes: ReadonlyMap<string, Record<string, unknown>>) {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE files (path TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
                        modified INTEGER NOT NULL, size INTEGER NOT NULL);
    CREATE TABLE props (path TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0,
                        value_text TEXT, value_num REAL, value_date TEXT, value_json TEXT);
    CREATE TABLE relations (src TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL,
                            target TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', dst TEXT);
    CREATE TABLE tags (path TEXT NOT NULL, idx INTEGER NOT NULL, tag TEXT NOT NULL, name TEXT NOT NULL);`);
  for (const [path, frontmatter] of notes) {
    database.prepare('INSERT INTO files VALUES (?, ?, ?, ?, 1)').run(path, path, '', 1);
    for (const row of indexablePropertiesOf(frontmatter)) {
      database
        .prepare('INSERT INTO props VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(path, row.key, row.index, row.text, row.number, row.date, row.json);
    }
  }
  const all = (sql: string, parameters: readonly (string | number)[]) =>
    database.prepare(sql).all(...parameters) as Record<string, unknown>[];
  const compiled = compileAtlasQuery(parseAtlasQuery('FROM task SORT BY title LIMIT 1000'), {
    types: [TASK_TYPE_FILE.type],
    resolveLink: () => null,
    taskRows: true,
  });
  const objects = all(compiled.sql, compiled.parameters);
  const columns = objects[0] === undefined ? [] : Object.keys(objects[0]);
  const rows = toBoardRows({
    columns,
    rows: objects.map((object) => columns.map((column) => object[column])),
  });
  const statement = compileReviewTasksQuery();
  const today = new Map(
    all(statement.sql, statement.parameters).map((row) => [String(row['path']), reviewTask(row)]),
  );
  return { rows, today };
}

function seededNotes(seed: number, count: number) {
  const next = rng(seed);
  const notes = new Map<string, Record<string, unknown>>();
  for (let at = 0; at < count; at += 1)
    notes.set(`Tasks/T${String(at).padStart(4, '0')}.md`, frontmatterOf(next));
  return notes;
}

describe('the hidden task columns over seeded task shapes (PR #625)', () => {
  it.each([1, 2, 3, 625])('read each task as its file reads (seed %i)', (seed) => {
    const notes = seededNotes(seed, 300);
    const { rows } = indexOf(notes);
    expect(rows.length).toBe(notes.size);
    for (const row of rows) {
      const file = notes.get(row.path) ?? expect.fail(row.path);
      const state = taskRowState(row.values);
      expect(
        { asRead: state?.asRead, focusIsOwn: state?.focusIsOwn },
        JSON.stringify(file),
      ).toEqual({
        asRead: taskAsRead(file),
        focusIsOwn: focusIsOwn(file),
      });
    }
  });

  it.each([1, 2, 3, 625])('read each task as Today’s statement does (seed %i)', (seed) => {
    const notes = seededNotes(seed, 300);
    const { rows, today } = indexOf(notes);
    // Today's statement reads open work only; each task it reads is compared.
    expect(today.size).toBeGreaterThan(50);
    for (const row of rows) {
      const state = taskRowState(row.values);
      const read = today.get(row.path);
      if (read === undefined) continue;
      expect(state, row.path).toEqual({
        asRead: { status: read?.status, due: read?.due, defer: read?.defer, focus: read?.focus },
        focusIsOwn: read?.focusIsOwn,
        recurrence: read?.recurrence,
      });
    }
  });

  it.each([1, 625])(
    'carry a recurrence only where the tick rolls the task on (seed %i)',
    (seed) => {
      const notes = seededNotes(seed, 300);
      const { rows } = indexOf(notes);
      for (const row of rows) {
        const file = notes.get(row.path) ?? expect.fail(row.path);
        const repeats = parseRecurrence(file['recurrence']) !== null;
        expect(
          taskRowState(row.values)?.recurrence !== null &&
            parseRecurrence(taskRowState(row.values)?.recurrence) !== null,
          JSON.stringify(file['recurrence']),
        ).toBe(repeats);
      }
    },
  );
});
