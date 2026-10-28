import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { GtdStatus } from '../gtd/gtd-status.ts';
import { TASK_TYPE_FILE } from '../gtd/task-type.ts';
import { indexablePropertiesOf } from '../index/property-value.ts';
import { readQueryBlock } from '../query-block/query-block.ts';
import { compileAtlasQuery } from '../query-language/compile.ts';
import { parseAtlasQuery } from '../query-language/parse.ts';
import type { ReviewTask } from '../review/weekly-review.ts';
import { todayLists } from '../today/today-lists.ts';
import { parseObjectType } from '../types/property-def.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import { dailyDaySections } from './daily-note-contents.ts';

/**
 * #110: the daily note's blocks run for real against SQLite, over the
 * index's own tables, and list what the Today page lists for the same day —
 * the two read one rule, and this is where they would be seen to part.
 */
const DAY = '2026-10-28';

interface Fixture {
  readonly status: GtdStatus;
  readonly due?: string;
  readonly defer?: string;
}

const TASKS: Readonly<Record<string, Fixture>> = {
  'Pay the plumber': { status: 'next-action', due: '2026-10-20' },
  'Send the invoice': { status: 'in-progress', due: DAY },
  'Chase Tobias': { status: 'waiting', due: '2026-10-27' },
  'Sort the receipts': { status: 'inbox', due: '2026-10-01' },
  'Plan the offsite': { status: 'backlog', due: DAY },
  'Learn the cello': { status: 'someday', due: '2026-10-02' },
  'Write a novel': { status: 'longterm', due: '2026-10-03' },
  'Filed already': { status: 'archive', due: '2026-10-04' },
  'Due tomorrow': { status: 'next-action', due: '2026-10-29' },
  'Late but put off': { status: 'next-action', due: '2026-10-21', defer: '2026-10-30' },
  'Call the bank': { status: 'next-action' },
  'Back today': { status: 'next-action', defer: DAY },
  'Not yet': { status: 'next-action', defer: '2026-10-29' },
  'Draft the memo': { status: 'in-progress' },
};

const TYPES = [
  TASK_TYPE_FILE.type,
  parseObjectType({ name: 'person', properties: {} }),
  parseObjectType({ name: 'project', properties: {} }),
  parseObjectType({ name: 'area', properties: {} }),
];

function index(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE files (path TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
                        modified INTEGER NOT NULL, size INTEGER NOT NULL);
    CREATE TABLE props (path TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0,
                        value_text TEXT, value_num REAL, value_date TEXT, value_json TEXT);
    CREATE TABLE relations (src TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL,
                            target TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', dst TEXT);
    CREATE TABLE tags (path TEXT NOT NULL, idx INTEGER NOT NULL, tag TEXT NOT NULL, name TEXT NOT NULL);`);
  for (const [title, values] of Object.entries(TASKS)) {
    const path = `tasks/${title}.md`;
    database.prepare('INSERT INTO files VALUES (?, ?, ?, 1, 1)').run(path, title, '');
    for (const row of indexablePropertiesOf({ type: 'task', ...values })) {
      database
        .prepare('INSERT INTO props VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(path, row.key, row.index, row.text, row.number, row.date, row.json);
    }
  }
  return database;
}

const database = index();

/** The titles a day's block lists, in the order it lists them. */
function listed(block: string): string[] {
  const reading = readQueryBlock(block);
  if (!reading.ok) throw new Error(reading.problem);
  const compiled = compileAtlasQuery(parseAtlasQuery(reading.query), {
    types: TYPES,
    resolveLink: () => null,
  });
  const rows = database.prepare(compiled.sql).all(...compiled.parameters) as { title: string }[];
  return rows.map((row) => row.title);
}

function reviewTask(title: string, fixture: Fixture): ReviewTask {
  return {
    path: createVaultPath(`tasks/${title}.md`),
    title,
    status: fixture.status,
    due: fixture.due ?? null,
    defer: fixture.defer ?? null,
    waitingOn: '',
    contexts: [],
    project: null,
    projectTitle: null,
    modified: 0,
  };
}

/** The titles the Today page lists for `DAY` under the given sections. */
function onToday(...ids: string[]): string[] {
  const tasks = Object.entries(TASKS).map(([title, fixture]) => reviewTask(title, fixture));
  const page = todayLists({ tasks, projects: [], at: { today: DAY, now: 0 } });
  return page.sections
    .filter((section) => ids.includes(section.id))
    .flatMap((section) => section.groups.flatMap((group) => group.tasks.map((task) => task.title)));
}

const [due, next] = dailyDaySections(DAY).map((section) => section.block) as [string, string];

describe("the daily note's day, as the index answers it", () => {
  it('lists under Due and overdue what Today lists as Overdue and Due today', () => {
    expect(listed(due).sort()).toEqual(onToday('overdue', 'dueToday').sort());
    expect(listed(due).sort()).toEqual([
      'Chase Tobias',
      'Pay the plumber',
      'Plan the offsite',
      'Send the invoice',
      'Sort the receipts',
    ]);
  });

  it('lists the most overdue first', () => {
    expect(listed(due)[0]).toBe('Sort the receipts');
  });

  it('lists under Next actions the next actions in play and not due by the day', () => {
    expect(listed(next).sort()).toEqual(['Back today', 'Call the bank', 'Due tomorrow']);
    expect(listed(next).sort()).toEqual(
      onToday('nextActions', 'backToday')
        .filter((title) => TASKS[title]?.status === 'next-action')
        .sort(),
    );
  });

  it("runs in a vault whose Task type has GTD's status and dates and nothing more", () => {
    const bare = parseObjectType({
      name: 'task',
      properties: {
        status: { kind: 'select', options: ['inbox', 'next-action', 'archive'] },
        defer: 'date',
        due: 'date',
      },
    });
    for (const block of [due, next]) {
      const reading = readQueryBlock(block);
      if (!reading.ok) throw new Error(reading.problem);
      expect(() =>
        compileAtlasQuery(parseAtlasQuery(reading.query), {
          types: [bare],
          resolveLink: () => null,
        }),
      ).not.toThrow();
    }
  });
});
