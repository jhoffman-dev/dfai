import { describe, expect, it } from 'vitest';
import type { ObjectType } from '../types/property-def.ts';
import { compileViewQuery } from './view-query.ts';
import { typeTableQuery } from './type-table.ts';

const task: ObjectType = {
  name: 'task',
  label: 'Task',
  properties: [
    {
      key: 'status',
      label: 'Status',
      kind: 'select',
      required: false,
      options: ['todo', 'done'],
      target: null,
      many: false,
    },
    {
      key: 'due',
      label: 'Due',
      kind: 'date',
      required: false,
      options: [],
      target: null,
      many: false,
    },
  ],
};

describe('typeTableQuery', () => {
  it('lists the notes of that type', () => {
    expect(typeTableQuery(task).type).toBe('task');
  });

  it('shows a column per declared property, in the order the type declares them', () => {
    expect(typeTableQuery(task).columns).toEqual(['status', 'due']);
  });

  it('filters nothing out: the section says how many notes there are', () => {
    expect(typeTableQuery(task).filters).toEqual([]);
  });

  it('sorts by title, so the table is the same on the way back', () => {
    expect(typeTableQuery(task).sorts).toEqual([{ key: 'title', direction: 'asc' }]);
  });

  it('compiles to SQL against that type, with nothing of the type name bound', () => {
    const { sql } = compileViewQuery(typeTableQuery(task));
    expect(sql).toContain('FROM "v_task"');
    expect(sql).toContain('"status"');
    expect(sql).toContain(`ORDER BY NULLIF("title", '') ASC NULLS LAST`);
  });

  it('asks for nothing but path and title when a type declares no properties', () => {
    const { sql } = compileViewQuery(
      typeTableQuery({ name: 'note', label: 'Note', properties: [] }),
    );
    expect(sql.startsWith('SELECT "path", "title"\n')).toBe(true);
  });
});
