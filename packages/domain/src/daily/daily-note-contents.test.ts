import { describe, expect, it } from 'vitest';
import { splitFrontmatter } from '../markdown/markdown-document.ts';
import { readQueryBlock } from '../query-block/query-block.ts';
import { parseAtlasQuery } from '../query-language/parse.ts';
import { TASK_TYPE_FILE } from '../gtd/task-type.ts';
import { parseObjectType, type ObjectType } from '../types/property-def.ts';
import {
  dailyDaySections,
  dailyNoteContents as contentsWith,
  dayBlocksFit,
} from './daily-note-contents.ts';

const DAY = '2026-10-28';
const GTD = [TASK_TYPE_FILE.type];

/** Today's note on `day` in a vault on GTD. */
const dailyNoteContents = (day: string) => contentsWith({ day, types: GTD });

/** The fenced `atlas-query` texts a note holds, in order. */
function queryBlocksOf(contents: string): string[] {
  return [...contents.matchAll(/^```atlas-query\n([\s\S]*?)\n```$/gm)].map((match) => match[1]!);
}

describe("today's note without a Daily template (#110)", () => {
  it('is a note of the Daily type', () => {
    expect(splitFrontmatter(dailyNoteContents(DAY)).frontmatter).toMatch(/^type: daily$/m);
  });

  it('starts with the day — due and overdue, then next actions — above what happened and what is next', () => {
    const headings = [...dailyNoteContents(DAY).matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    expect(headings).toEqual(['Due and overdue', 'Next actions', 'What happened', 'What is next']);
  });

  it('holds each section of the day as a live query block under its heading, listed as a list', () => {
    const contents = dailyNoteContents(DAY);
    const blocks = queryBlocksOf(contents);
    expect(blocks).toEqual(dailyDaySections(DAY).map((section) => section.block));
    for (const block of blocks) {
      const reading = readQueryBlock(block);
      expect(reading).toMatchObject({ ok: true, layout: 'list' });
      if (reading.ok) expect(() => parseAtlasQuery(reading.query)).not.toThrow();
    }
    expect(contents.indexOf('## Due and overdue')).toBeLessThan(contents.indexOf(blocks[0]!));
    expect(contents.indexOf(blocks[1]!)).toBeLessThan(contents.indexOf('## What happened'));
  });

  it("names the note's own day rather than @today, so an old note keeps its day", () => {
    const blocks = dailyDaySections(DAY).map((section) => section.block);
    for (const block of blocks) {
      expect(block).toContain(DAY);
      expect(block).not.toContain('@today');
    }
    expect(dailyDaySections('2026-11-02')[0]?.block).toContain('due <= 2026-11-02');
  });

  it('asks only open work for what is due: Someday, Longterm and finished work promise no day', () => {
    const due = dailyDaySections(DAY)[0]!.block;
    for (const status of ['inbox', 'backlog', 'next-action', 'in-progress', 'waiting']) {
      expect(due).toContain(`status = ${status}`);
    }
    for (const status of ['someday', 'longterm', 'archive']) {
      expect(due).not.toContain(`status = ${status}`);
    }
  });

  it('is the same text every time for the same day: the file is written once, byte-stable', () => {
    expect(dailyNoteContents(DAY)).toBe(dailyNoteContents(DAY));
    expect(dailyNoteContents(DAY).endsWith('## What is next\n')).toBe(true);
  });

  it('refuses a day that is not YYYY-MM-DD rather than write a query that cannot run', () => {
    for (const bad of ['', '2026-1-2', '@today', '2026-10-28 OR 1', 'tomorrow']) {
      expect(() => dailyNoteContents(bad)).toThrow(RangeError);
    }
  });
});

const GTD_OPTIONS = [
  'inbox',
  'backlog',
  'next-action',
  'in-progress',
  'waiting',
  'someday',
  'longterm',
  'archive',
];

/** A Task type with GTD's status and `due` and `defer` as given. */
function taskType({
  options = GTD_OPTIONS,
  done = 'archive',
  due = 'date',
  defer = 'date',
  name = 'task',
}: {
  options?: string[];
  done?: string;
  due?: string | null;
  defer?: string | null;
  name?: string;
} = {}) {
  const properties: Record<string, unknown> = { status: { kind: 'select', options, done } };
  if (due !== null) properties['due'] = due;
  if (defer !== null) properties['defer'] = defer;
  return parseObjectType({ name, properties });
}

describe('whether the day fits the vault (#110)', () => {
  const person = parseObjectType({ name: 'person', properties: {} });

  it("fits a Task type with GTD's statuses and due and defer as dates", () => {
    expect(dayBlocksFit([person, taskType()])).toBe(true);
    expect(dayBlocksFit(GTD)).toBe(true);
  });

  // The index knows only the types on disk: with no task.md, `FROM task` has no type to read.
  it('does not fit a vault with no Task type of its own', () => {
    expect(dayBlocksFit([])).toBe(false);
    expect(dayBlocksFit([person])).toBe(false);
  });

  // `FROM task` names the type exactly, so a type spelt `Task` is no type of that name.
  it('does not fit a GTD Task type whose name is spelt other than task', () => {
    expect(dayBlocksFit([taskType({ name: 'Task' })])).toBe(false);
    expect(dayBlocksFit([taskType({ name: 'TASK' })])).toBe(false);
  });

  // FROM task cannot tell task from Task, so a vault holding both gets no blocks.
  it('does not fit a vault with a second type spelt Task besides task', () => {
    expect(dayBlocksFit([taskType(), taskType({ name: 'Task' })])).toBe(false);
    expect(dayBlocksFit([taskType(), taskType()])).toBe(true);
  });

  it.each<[string, ObjectType]>([
    ['statuses of its own', taskType({ options: ['todo', 'doing', 'done'], done: 'done' })],
    ["GTD's statuses in another order", taskType({ options: [...GTD_OPTIONS].reverse() })],
    ['no due', taskType({ due: null })],
    ['no defer', taskType({ defer: null })],
    ['due as text', taskType({ due: 'text' })],
    ['defer as text', taskType({ defer: 'text' })],
    ['no status', parseObjectType({ name: 'task', properties: { due: 'date', defer: 'date' } })],
  ])('does not fit a Task type with %s', (_, type) => {
    expect(dayBlocksFit([type])).toBe(false);
  });

  it('starts a note without the blocks, as the two headings alone, when the day does not fit', () => {
    const plain = contentsWith({ day: DAY, types: [taskType({ due: null })] });
    expect(plain).toBe('---\ntype: daily\n---\n\n## What happened\n\n## What is next\n');
  });

  it('starts a note with the blocks when it does', () => {
    expect(contentsWith({ day: DAY, types: [taskType()] })).toContain('```atlas-query\n');
  });
});
