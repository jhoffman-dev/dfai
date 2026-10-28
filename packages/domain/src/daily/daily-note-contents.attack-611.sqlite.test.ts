import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { GTD_STATUSES } from '../gtd/gtd-status.ts';
import { TASK_TYPE_FILE } from '../gtd/task-type.ts';
import { indexablePropertiesOf } from '../index/property-value.ts';
import { readQueryBlock } from '../query-block/query-block.ts';
import { compileAtlasQuery } from '../query-language/compile.ts';
import { parseAtlasQuery } from '../query-language/parse.ts';
import { compileReviewTasksQuery, reviewTask } from '../review/review-query.ts';
import { todayLists } from '../today/today-lists.ts';
import { PROPERTY_KINDS, parseObjectType, type ObjectType } from '../types/property-def.ts';
import { dailyDaySections, dayBlocksFit } from './daily-note-contents.ts';

/**
 * Attack on PR #611 (#110): the daily note's blocks against the Today page,
 * both read through the index the way the app reads them — the blocks through
 * the query language, the Today page through its own statement and
 * `todayLists`. The PR says the two "read one rule"; these are the vaults
 * where they part.
 */

type Frontmatter = Readonly<Record<string, unknown>>;

const DAY = '2026-10-28';

function index(notes: Readonly<Record<string, Frontmatter>>): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE files (path TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
                        modified INTEGER NOT NULL, size INTEGER NOT NULL);
    CREATE TABLE props (path TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0,
                        value_text TEXT, value_num REAL, value_date TEXT, value_json TEXT);
    CREATE TABLE relations (src TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL,
                            target TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', dst TEXT);
    CREATE TABLE tags (path TEXT NOT NULL, idx INTEGER NOT NULL, tag TEXT NOT NULL, name TEXT NOT NULL);`);
  for (const [title, frontmatter] of Object.entries(notes)) {
    const path = `Tasks/${title}.md`;
    database.prepare('INSERT INTO files VALUES (?, ?, ?, 1, 1)').run(path, title, '');
    for (const row of indexablePropertiesOf(frontmatter)) {
      database
        .prepare('INSERT INTO props VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(path, row.key, row.index, row.text, row.number, row.date, row.json);
    }
  }
  return database;
}

function blockTitles(
  database: DatabaseSync,
  block: string,
  types: readonly ObjectType[] = [TASK_TYPE_FILE.type],
): string[] {
  const reading = readQueryBlock(block);
  if (!reading.ok) throw new Error(reading.problem);
  const compiled = compileAtlasQuery(parseAtlasQuery(reading.query), {
    types,
    resolveLink: () => null,
  });
  const rows = database.prepare(compiled.sql).all(...compiled.parameters) as { title: string }[];
  return rows.map((row) => row.title).sort();
}

/** The Today page for `day`, as read-today reads it: its own statement, then todayLists. */
function todayTitles(database: DatabaseSync, day: string, ids: readonly string[]): string[] {
  const statement = compileReviewTasksQuery();
  const rows = database.prepare(statement.sql).all(...statement.parameters) as Record<
    string,
    unknown
  >[];
  const page = todayLists({
    tasks: rows.map(reviewTask),
    projects: [],
    at: { today: day, now: 0 },
  });
  return page.sections
    .filter((section) => ids.includes(section.id))
    .flatMap((section) => section.groups.flatMap((group) => group.tasks))
    .filter((task) => ids.includes('overdue') || task.status === 'next-action')
    .map((task) => task.title)
    .sort();
}

const blocksOf = (day: string) =>
  dailyDaySections(day).map((section) => section.block) as [string, string];

const dueOnToday = (database: DatabaseSync, day: string) =>
  todayTitles(database, day, ['overdue', 'dueToday']);
const nextOnToday = (database: DatabaseSync, day: string) =>
  todayTitles(database, day, ['nextActions', 'backToday']);

/** A small seeded generator (mulberry32): the same seed gives the same vaults. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(random: () => number, items: readonly T[]): T =>
  items[Math.floor(random() * items.length)] as T;

function shifted(day: string, by: number): string {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + by);
  return at.toISOString().slice(0, 10);
}

/** A date as a person or the app writes one: a day, a day with a time, with an offset. */
function writtenDate(random: () => number, day: string): string | undefined {
  const shape = Math.floor(random() * 4);
  if (shape === 0) return undefined;
  const near = shifted(day, Math.floor(random() * 7) - 3);
  if (shape === 1) return near;
  if (shape === 2) return `${near}T${pick(random, ['00:00', '09:30', '23:59'])}`;
  return `${near}T23:30:00${pick(random, ['-07:00', '+13:00', 'Z'])}`;
}

function wellFormedVault(random: () => number, day: string): Record<string, Frontmatter> {
  const notes: Record<string, Frontmatter> = {};
  const count = 1 + Math.floor(random() * 25);
  for (let at = 0; at < count; at += 1) {
    const status = random() < 0.1 ? undefined : pick(random, GTD_STATUSES);
    const due = writtenDate(random, day);
    const defer = writtenDate(random, day);
    notes[`Task ${at}`] = {
      type: 'task',
      ...(status !== undefined && { status }),
      ...(due !== undefined && { due }),
      ...(defer !== undefined && { defer }),
    };
  }
  return notes;
}

// Year and month ends, a leap day, and the US and EU DST change days.
const EDGE_DAYS = [
  '2026-12-31',
  '2027-01-01',
  '2026-02-28',
  '2028-02-29',
  '2026-03-08',
  '2026-03-29',
  '2026-11-01',
  '2026-10-25',
  DAY,
];

describe('#611 attack: the daily blocks list what Today lists, over seeded well-formed vaults', () => {
  it.each(EDGE_DAYS)('Due and overdue is Overdue plus Due today on %s', (day) => {
    const random = rng(611 + day.length + Number(day.slice(-2)));
    const [due] = blocksOf(day);
    for (let vault = 0; vault < 40; vault += 1) {
      const database = index(wellFormedVault(random, day));
      expect(blockTitles(database, due)).toEqual(dueOnToday(database, day));
    }
  });

  it.each(EDGE_DAYS)("Next actions is Today's next actions in play on %s", (day) => {
    const random = rng(1110 + Number(day.slice(-2)));
    const [, next] = blocksOf(day);
    for (let vault = 0; vault < 40; vault += 1) {
      const database = index(wellFormedVault(random, day));
      expect(blockTitles(database, next)).toEqual(nextOnToday(database, day));
    }
  });
});

describe('#611 attack: a value the Today page reads, the daily blocks drop', () => {
  const [due, next] = blocksOf(DAY);

  // Today reads a due it cannot read as a day as no due (review-query firstDay),
  // so the task is a next action; `due IS EMPTY OR due > day` is false for it.
  // query-language value rules: see PR #616 (follow-up to #110)
  it.fails.each([['TBD'], ['soon'], ['2026-02-30']])(
    'lists a next action whose due is not a day (%s) under Next actions, as Today does',
    (written) => {
      const database = index({
        'Ring Mara Quill': { type: 'task', status: 'next-action', due: written },
      });
      expect(nextOnToday(database, DAY)).toEqual(['Ring Mara Quill']);
      expect(blockTitles(database, next)).toEqual(['Ring Mara Quill']);
    },
  );

  // Today reads a defer it cannot read as a day as not put off; the block's
  // `defer IS EMPTY OR defer <= day` is false for it.
  // query-language value rules: see PR #616 (follow-up to #110)
  it.fails(
    'lists an overdue task whose defer is not a day under Due and overdue, as Today does',
    () => {
      const database = index({
        'Pay the plumber': {
          type: 'task',
          status: 'next-action',
          due: '2026-10-20',
          defer: 'next week',
        },
      });
      expect(dueOnToday(database, DAY)).toEqual(['Pay the plumber']);
      expect(blockTitles(database, due)).toEqual(['Pay the plumber']);
    },
  );

  // query-language value rules: see PR #616 (follow-up to #110)
  it.fails('lists a next action whose defer is not a day under Next actions, as Today does', () => {
    const database = index({
      'Call the bank': { type: 'task', status: 'next-action', defer: 'after the move' },
    });
    expect(nextOnToday(database, DAY)).toEqual(['Call the bank']);
    expect(blockTitles(database, next)).toEqual(['Call the bank']);
  });

  // Today matches a task's type in any case (inUseOfTypeSql: lower(trim(..))); FROM task does not.
  // query-language value rules: see PR #616 (follow-up to #110)
  it.fails('lists a task whose note says type: Task, as Today does', () => {
    const database = index({
      'Send the invoice': { type: 'Task', status: 'in-progress', due: DAY },
    });
    expect(dueOnToday(database, DAY)).toEqual(['Send the invoice']);
    expect(blockTitles(database, due)).toEqual(['Send the invoice']);
  });
});

describe('#611 attack: each task once, as the Today page lists it', () => {
  const [due, next] = blocksOf(DAY);

  const inBoth = (database: DatabaseSync) => {
    const nextTitles = new Set(blockTitles(database, next));
    return blockTitles(database, due).filter((title) => nextTitles.has(title));
  };

  // The module doc: "Each task is listed once, as on the Today page".
  // query-language value rules: see PR #616 (follow-up to #110)
  it.fails('lists a next action whose due holds two days under one section only', () => {
    const database = index({
      'Book the hall': { type: 'task', status: 'next-action', due: ['2026-11-30', '2026-10-01'] },
    });
    expect(inBoth(database)).toEqual([]);
  });
});

/** A Task type dayBlocksFit takes, with whatever else a vault might add. */
function fittingTypes(random: () => number): ObjectType[] {
  const extraKinds = PROPERTY_KINDS.filter((kind) => kind !== 'relation');
  const extras: Record<string, unknown> = {};
  const extraCount = Math.floor(random() * 8);
  for (let at = 0; at < extraCount; at += 1) {
    const key = pick(random, [
      'contexts',
      'project',
      'title',
      'tags',
      'modified',
      'path',
      'estimate',
      `field_${at}`,
      'Due',
      'progress',
    ]);
    extras[key] = pick(random, extraKinds);
  }
  const dateSpec = () =>
    pick(random, [
      'date',
      { kind: 'date' },
      { kind: 'date', many: true },
      { kind: 'date', required: true, label: 'When' },
    ]);
  const order = [...Object.entries(extras)];
  const own = {
    status: {
      kind: 'select',
      options: [...GTD_STATUSES],
      done: 'archive',
      ...(random() < 0.5 && { label: 'Where it stands', required: true }),
      ...(random() < 0.5 && { colors: { inbox: 'blue', 'next-action': 'green' } }),
    },
    due: dateSpec(),
    defer: dateSpec(),
  };
  const properties = Object.fromEntries(
    random() < 0.5 ? [...order, ...Object.entries(own)] : [...Object.entries(own), ...order],
  );
  const task = parseObjectType({ name: 'task', label: 'Task', properties });
  const others = [
    parseObjectType({ name: 'Task', properties: { due: 'text' } }),
    parseObjectType({ name: 'project', properties: { due: 'text', status: 'text' } }),
    parseObjectType({ name: 'person', properties: {} }),
  ].filter(() => random() < 0.5);
  return random() < 0.5 ? [task, ...others] : [...others, task];
}

describe('#611 attack: the blocks compile and run for every type set dayBlocksFit takes', () => {
  it('compiles and runs both blocks over 300 seeded fitting type sets', () => {
    const random = rng(110611);
    const database = index({ 'Plan the offsite': { type: 'task', status: 'backlog', due: DAY } });
    let fitting = 0;
    for (let set = 0; set < 300; set += 1) {
      const types = fittingTypes(random);
      if (!dayBlocksFit(types)) continue;
      fitting += 1;
      for (const block of blocksOf(pick(random, EDGE_DAYS))) {
        expect(() => blockTitles(database, block, types)).not.toThrow();
      }
    }
    // About half the sets also hold a type spelt `Task`, which no longer fits (dayBlocksFit).
    expect(fitting).toBeGreaterThan(100);
  });
});
