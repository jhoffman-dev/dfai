import { describe, expect, it } from 'vitest';
import { createVaultPath } from '@dfai/domain';
import type { OpenNote } from '@dfai/application';
import { pageHeading } from './page-heading.ts';

const note = (path: string, properties: Record<string, unknown>): OpenNote =>
  ({ path: createVaultPath(path), properties }) as unknown as OpenNote;

describe('pageHeading', () => {
  it('heads a template as a template under Templates, even one that makes dashboards', () => {
    const heading = pageHeading({
      note: note('.atlas/templates/Dashboard.md', { atlas: 'dashboard', widgets: [] }),
      typeName: null,
      sql: null,
    });
    expect(heading).toMatchObject({
      kind: 'template',
      crumb: { icon: 'template', parent: 'Templates' },
      title: { text: 'Dashboard' },
    });
  });

  it('heads a typed note by its folder, its type and its own title', () => {
    const heading = pageHeading({
      note: note('tasks/A15-03.md', { type: 'task', title: 'Leftovers' }),
      typeName: 'task',
      sql: 'SELECT 1',
    });
    expect(heading).toEqual({
      kind: 'note',
      crumb: { icon: 'folder', parent: 'tasks' },
      title: { text: 'Leftovers', source: 'property' },
      description: null,
      path: 'tasks/A15-03.md',
      sql: null,
    });
  });

  it('heads a view under Views, drawn by its layout, with its description and SQL', () => {
    const heading = pageHeading({
      note: note('.atlas/views/Board.md', {
        atlas: 'view',
        type: 'task',
        layout: 'board',
        groupBy: 'status',
        description: 'Every task, by status.',
      }),
      typeName: null,
      sql: 'SELECT path FROM notes',
    });
    expect(heading).toMatchObject({
      kind: 'view',
      crumb: { icon: 'board', parent: 'Views' },
      title: { text: 'Board', source: 'file' },
      description: 'Every task, by status.',
      sql: 'SELECT path FROM notes',
    });
  });

  it('heads a dashboard under Dashboards, and ignores a description that is not text', () => {
    const heading = pageHeading({
      note: note('.atlas/dashboards/Progress.md', {
        atlas: 'dashboard',
        widgets: [],
        description: 3,
      }),
      typeName: null,
      sql: null,
    });
    expect(heading).toMatchObject({
      kind: 'dashboard',
      crumb: { icon: 'chart', parent: 'Dashboards' },
      description: null,
    });
  });
});
