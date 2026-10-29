import { describe, expect, it } from 'vitest';
import { parseObjectType, typeViewSelectSql } from '@dfai/domain';
import { viewSpecsFor } from './run-view.ts';

describe('viewSpecsFor', () => {
  it('asks for a column per declared property, with its kind and whether it holds several', () => {
    const task = parseObjectType({
      name: 'task',
      properties: { due: 'date', points: 'number', tags: { kind: 'text', many: true } },
    });
    expect(viewSpecsFor([task])).toEqual([
      {
        name: 'task',
        select: typeViewSelectSql({
          name: 'task',
          columns: [
            { key: 'due', kind: 'date', many: false },
            { key: 'points', kind: 'number', many: false },
            { key: 'tags', kind: 'text', many: true },
          ],
          progress: true,
        }),
      },
    ]);
  });

  it('asks for each note’s checklist progress, unless the type declares its own (P30-03)', () => {
    const goal = parseObjectType({ name: 'goal', properties: { Progress: 'number' } });
    expect(viewSpecsFor([goal])).toEqual([
      {
        name: 'goal',
        select: typeViewSelectSql({
          name: 'goal',
          columns: [{ key: 'Progress', kind: 'number', many: false }],
          progress: false,
        }),
      },
    ]);
    expect(viewSpecsFor([goal])[0]?.select).not.toContain('n.progress');
  });

  // A type file written by hand can declare a key the editor refuses; its
  // column would sit beside the view's own and SQLite would call it
  // `modified:1`, a name no query can write without quoting.
  it('leaves out a declared property named like a column every view already has', () => {
    const task = parseObjectType({
      name: 'task',
      properties: { modified: 'date', path: 'text', title: 'text', summary: 'text', due: 'date' },
    });
    const select = viewSpecsFor([task])[0]?.select ?? '';
    expect(select).toContain('AS "due"');
    for (const key of ['modified', 'path', 'title', 'summary']) {
      expect(select).not.toContain(`p.key = '${key}' AND COALESCE`);
    }
  });

  it('makes no view for a type whose name is no identifier', () => {
    expect(viewSpecsFor([parseObjectType({ name: 'drop table', properties: {} })])).toEqual([]);
  });
});
