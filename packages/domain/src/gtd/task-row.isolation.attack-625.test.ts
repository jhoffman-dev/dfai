import { describe, expect, it } from 'vitest';
import { compileAtlasQuery, resultFields } from '../query-language/compile.ts';
import { parseAtlasQuery } from '../query-language/parse.ts';
import { TASK_TYPE_FILE } from './task-type.ts';
import { TASK_ROW_COLUMNS } from './task-row.ts';

/**
 * Attack on PR #625 (#107): the hidden `task:*` columns cost a query nothing
 * unless it is a saved view of tasks alone, and never become a field.
 */
const TYPES = [
  TASK_TYPE_FILE.type,
  { name: 'project', label: 'Project', properties: [] },
  { name: 'note', label: 'Note', properties: [] },
];
const compile = (text: string, taskRows: boolean) =>
  compileAtlasQuery(parseAtlasQuery(text), { types: TYPES, resolveLink: () => null, taskRows });
const HIDDEN = Object.values(TASK_ROW_COLUMNS);

describe('the hidden task columns stay out of the way (PR #625)', () => {
  it.each([
    'FROM project',
    'FROM note',
    'FROM task, project',
    'FROM project, task WHERE status = "next-action"',
  ])('add no work to %s: the statement is the one compiled without them', (text) => {
    expect(compile(text, true).sql).toBe(compile(text, false).sql);
    expect(compile(text, true).taskRows).toBe(false);
  });

  it.each(['FROM task', ' FROM task WHERE status = "waiting" SHOW due, status GROUP BY status'])(
    'adds exactly the six sub-selects to %s, and none of them is a field',
    (text) => {
      const asked = compile(text, true);
      const plain = compile(text, false);
      expect(asked.taskRows).toBe(true);
      for (const column of HIDDEN) {
        expect(asked.sql.split(`AS "${column}"`)).toHaveLength(2);
        expect(plain.sql).not.toContain(column);
      }
      const selects = (sql: string) => sql.split('(SELECT').length;
      expect(selects(asked.sql) - selects(plain.sql)).toBe(HIDDEN.length);
      const fields = [
        ...resultFields(asked).map((field) => field.key),
        ...asked.columns.map((c) => c.text),
      ];
      expect(fields.some((key) => key.startsWith('task:'))).toBe(false);
      expect(asked.groups.map((group) => group.text)).toEqual(
        plain.groups.map((group) => group.text),
      );
    },
  );
});
