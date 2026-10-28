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
import type { ObjectType } from '../types/property-def.ts';
import { dailyDaySections } from './daily-note-contents.ts';

/**
 * Attack on PR #611 (#110), second pass: the daily note's blocks against the Today page,
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

/*
 * Second attack (commit df3eee78). The PR reads a single-valued field by its
 * first value "as the Today page reads it". The Today page does not read a
 * status that way: `singleText` (review-query.ts) gives null when a status
 * holds several values, and the statement leaves out a task holding the
 * finished status anywhere in its list. The blocks read the first.
 */

const [dueBlock, nextBlock] = blocksOf(DAY);

describe('#611b attack: a status written as a list, the daily blocks against Today', () => {
  it('leaves out of Next actions a task whose status is [next-action, waiting], as Today does', () => {
    const database = index({
      'Draft the Larkspur brief': { type: 'task', status: ['next-action', 'waiting'] },
    });
    expect(nextOnToday(database, DAY)).toEqual([]);
    expect(blockTitles(database, nextBlock)).toEqual([]);
  });

  it('leaves out of Next actions a task whose status is [next-action, archive], as Today does', () => {
    const database = index({
      'Return the hall keys': { type: 'task', status: ['next-action', 'archive'] },
    });
    expect(nextOnToday(database, DAY)).toEqual([]);
    expect(blockTitles(database, nextBlock)).toEqual([]);
  });

  it('leaves out of Due and overdue a task whose status is [in-progress, archive], as Today does', () => {
    const database = index({
      'File the Fenn invoice': {
        type: 'task',
        status: ['in-progress', 'archive'],
        due: '2026-10-20',
      },
    });
    expect(dueOnToday(database, DAY)).toEqual([]);
    expect(blockTitles(database, dueBlock)).toEqual([]);
  });
});

const STATUS_ITEMS: readonly unknown[] = [...GTD_STATUSES, '', null, 'Next-Action', ' waiting '];
const TYPE_SPELLINGS: readonly unknown[] = ['task', 'Task', ' TASK ', 'tasks', ['task', 'project']];

/** Hand-edited tasks: lists where one value belongs, blanks, words for days, types in any case. */
function messyVault(
  random: () => number,
  day: string,
  statusAsList = true,
): Record<string, Frontmatter> {
  const notes: Record<string, Frontmatter> = {};
  const count = 1 + Math.floor(random() * 20);
  const value = (single: () => unknown) => {
    const shape = random();
    if (shape < 0.15) return undefined;
    if (shape < 0.7) return single();
    return Array.from({ length: 1 + Math.floor(random() * 3) }, single);
  };
  for (let at = 0; at < count; at += 1) {
    const status = statusAsList
      ? value(() => pick(random, STATUS_ITEMS))
      : random() < 0.15
        ? undefined
        : pick(random, STATUS_ITEMS);
    const due = value(() => writtenDate(random, day) ?? pick(random, ['TBD', '2026-02-30', '']));
    const defer = value(() => writtenDate(random, day) ?? pick(random, ['later', '']));
    notes[`Task ${at}`] = {
      type: pick(random, TYPE_SPELLINGS),
      ...(status !== undefined && { status }),
      ...(due !== undefined && { due }),
      ...(defer !== undefined && { defer }),
    };
  }
  return notes;
}

/** The tasks one list holds and the other does not, with what each note says. */
function parted(notes: Record<string, Frontmatter>, block: string[], today: string[]) {
  return Object.keys(notes)
    .filter((title) => block.includes(title) !== today.includes(title))
    .map((title) => ({ title, note: notes[title], inBlock: block.includes(title) }));
}

describe('#611b attack: the daily blocks list what Today lists, over seeded hand-edited vaults', () => {
  it('Due and overdue is Overdue plus Due today (seeded, 200 vaults)', () => {
    const random = rng(6112);
    for (let vault = 0; vault < 200; vault += 1) {
      const notes = messyVault(random, DAY);
      const database = index(notes);
      expect(parted(notes, blockTitles(database, dueBlock), dueOnToday(database, DAY))).toEqual([]);
    }
  });

  it("Next actions is Today's next actions in play (seeded, 200 vaults)", () => {
    const random = rng(6113);
    for (let vault = 0; vault < 200; vault += 1) {
      const notes = messyVault(random, DAY);
      const database = index(notes);
      expect(parted(notes, blockTitles(database, nextBlock), nextOnToday(database, DAY))).toEqual(
        [],
      );
    }
  });

  // Held: with one status each, everything else as messy as above, the two agree.
  it.each([
    ['Due and overdue', 0, ['overdue', 'dueToday']],
    ['Next actions', 1, ['nextActions', 'backToday']],
  ] as const)(
    '%s agrees with Today when each status is one value (seeded, 200 vaults)',
    (_, at, ids) => {
      const random = rng(6114 + at);
      const block = blocksOf(DAY)[at];
      for (let vault = 0; vault < 200; vault += 1) {
        const notes = messyVault(random, DAY, false);
        const database = index(notes);
        expect(
          parted(notes, blockTitles(database, block), todayTitles(database, DAY, ids)),
        ).toEqual([]);
      }
    },
  );
});
