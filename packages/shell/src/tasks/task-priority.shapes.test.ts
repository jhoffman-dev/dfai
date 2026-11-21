/**
 * Review of PR #917 (#913): every shape a note may hold under `priority`, on
 * every surface that shows or edits a task's priority, read through the app's
 * own markdown, index and reads. The soft-field rule, held alike everywhere:
 * 1 to 4 (or their digits, or a one-item list of one) are a priority and draw
 * its pill; anything else draws none, a picker shows it as "Other: …" and
 * leaves it be until a pick; none at all is "No priority".
 */
import { describe, expect, it } from 'vitest';
import {
  createVaultPath,
  parseObjectType,
  priorityLabel,
  taskPriorityOf,
  splitFrontmatter,
  type ReviewTask,
} from '@dfai/domain';
import { atlasQueryIndex, sqliteIndexPort } from '@dfai/application/testing/sqlite';
import { remarkMarkdown } from '@dfai/adapters';
import {
  fakeMarkdown,
  fakeVaultFs,
  listInbox,
  readToday,
  runView,
  toIndexedNote,
  viewSpecsFor,
} from '@dfai/application';
import { priorityPicker, priorityPill } from '@dfai/ui';

const LONG = 'x'.repeat(60);

/** A shape, the `priority` line holding it (none for absent), the pill it draws, and what a picker shows. */
const SHAPES: readonly (readonly [string, string | null, string | null, string])[] = [
  ['absent', null, null, 'No priority'],
  ['blank', 'priority:', null, 'No priority'],
  ['3 as a number', 'priority: 3', 'P3', 'P3'],
  ['"2" as text', 'priority: "2"', 'P2', 'P2'],
  ['0', 'priority: 0', null, 'Other: 0'],
  ['7', 'priority: 7', null, 'Other: 7'],
  ['2.5', 'priority: 2.5', null, 'Other: 2.5'],
  ['words', 'priority: high', null, 'Other: high'],
  ['a list', 'priority: [1, 2]', null, 'Other: [1, 2]'],
  ['a one-item list of 2', 'priority: [2]', 'P2', 'P2'],
  ['a mapping', 'priority: {level: high}', null, 'Other: {"level":"high"}'],
  ['true', 'priority: true', null, 'Other: true'],
  ['a long string', `priority: ${LONG}`, null, `Other: ${'x'.repeat(23)}…`],
];

const noteText = (line: string | null, status = 'next-action') =>
  [
    '---',
    'type: task',
    `status: ${status}`,
    ...(line === null ? [] : [line]),
    '---',
    '',
    'A task.',
    '',
  ].join('\n');

/** What a pill says, or null where none is drawn. */
const pillOf = (value: unknown) => {
  const priority = taskPriorityOf(value);
  expect(priorityPill(value) === null).toBe(priority === null);
  return priority === null ? null : priorityLabel(priority);
};

/** What a picker shows chosen, for the value it is handed. */
const chosenOf = (value: unknown) => {
  const { selected, choices } = priorityPicker(value);
  return choices.find((choice) => choice.value === selected)?.label;
};

describe('the properties panel (the value as the note holds it)', () => {
  for (const [shape, line, pill, picker] of SHAPES) {
    it(`${shape}: pill ${pill ?? 'none'}, picker ${picker}`, () => {
      const value = remarkMarkdown.frontmatterProperties(
        splitFrontmatter(noteText(line)).frontmatter,
      )['priority'];
      expect(pillOf(value)).toBe(pill);
      expect(chosenOf(value)).toBe(picker);
    });
  }
});

const files = Object.fromEntries(
  SHAPES.map(([shape, line]) => [`Inbox/${shape}.md`, noteText(line, 'inbox')]),
);
const query = atlasQueryIndex({ files, markdown: remarkMarkdown });

describe('an Inbox row and its Clarify picker (as the Inbox reads the index)', () => {
  for (const [shape, , pill, picker] of SHAPES) {
    it(`${shape}: pill ${pill ?? 'none'}, picker ${picker}`, async () => {
      const { items } = await listInbox({ index: { query } as never, ranksTasks: true });
      const task = items.find((item) => item.title === shape)?.task;
      expect(task?.priority).not.toBeUndefined();
      expect(pillOf(task?.priority)).toBe(pill);
      expect(chosenOf(task?.priorityWritten ?? task?.priority)).toBe(picker);
    });
  }
});

describe('a Today row (as Today reads the index)', () => {
  const todayFiles = Object.fromEntries(
    SHAPES.map(([shape, line]) => [`Tasks/${shape}.md`, noteText(line)]),
  );
  const todayQuery = atlasQueryIndex({ files: todayFiles, markdown: remarkMarkdown });
  for (const [shape, , pill] of SHAPES) {
    it(`${shape}: pill ${pill ?? 'none'}`, async () => {
      const report = await readToday({
        index: { query: todayQuery } as never,
        fs: fakeVaultFs(),
        markdown: fakeMarkdown(),
        clock: { today: () => '2026-11-21', now: () => Date.UTC(2026, 10, 21) },
        choosing: true,
        ranksTasks: true,
      });
      const tasks: ReviewTask[] = report.sections.flatMap((section) =>
        section.groups.flatMap((group) => group.tasks),
      );
      expect(pillOf(tasks.find((task) => task.title === shape)?.priority)).toBe(pill);
    });
  }
});

describe('a task table’s Priority cell (as the type view reads it)', () => {
  const TASK = parseObjectType({
    name: 'task',
    properties: { status: 'text', priority: 'number' },
  });
  for (const [shape, line, pill] of SHAPES) {
    it(`${shape}: pill ${pill ?? 'none'}`, async () => {
      const index = sqliteIndexPort();
      const path = `Tasks/${shape}.md`;
      const text = noteText(line);
      await index.put([
        toIndexedNote({
          file: { path, text, modified: 1, size: text.length },
          notePaths: [createVaultPath(path)],
          markdown: remarkMarkdown,
        }),
      ]);
      await index.rebuildViews(viewSpecsFor([TASK]));
      const result = await runView({
        index,
        query: { type: 'task', columns: ['priority'], filters: [], sorts: [], limit: 10 },
      });
      const row = result.rows[0] ?? [];
      expect(pillOf(row[result.columns.indexOf('priority')])).toBe(pill);
    });
  }
});
