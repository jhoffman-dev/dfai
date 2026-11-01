// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { NoteChange } from '@dfai/domain';
import type { IndexedNote, IndexPort } from '@dfai/application';
import { sqliteIndexPort } from '@dfai/application/testing/sqlite';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import { createReadInvalidator } from '../reads/read-invalidator.ts';
import { useLibraryRead } from './use-research-reads.ts';

/**
 * Regression, found verifying PR #525: a literature note filed under a note
 * of no covered type (`project: [[Garden]]`, Garden untyped) shows that
 * note's title. Its retitle re-resolves the row in the index without changing
 * the row's own note, so only the untyped note's path says so in the news.
 */

const VAULT = '/v';

function note(path: string, title: string, relations: IndexedNote['relations'] = []): IndexedNote {
  const literature = path.startsWith('Library/');
  return {
    path,
    title,
    modified: 1,
    size: 0,
    digest: title,
    type: literature ? 'literature' : null,
    body: '',
    summary: '',
    properties: literature
      ? [{ key: 'type', index: 0, text: 'literature', number: null, date: null, json: null }]
      : [],
    links: [],
    tags: [],
    relations,
    blocks: [],
    checks: [],
    progress: null,
    highlights: [],
  };
}

const FILED_UNDER_GARDEN: IndexedNote['relations'] = [
  { key: 'project', index: 0, target: 'Garden', name: 'garden', path: 'Notes/Garden.md' },
];

const retitled = (path: string): NoteChange => ({
  kind: 'changed',
  path,
  type: null,
  digest: 'retitled',
  before: 'Garden',
});

async function openLibrary() {
  const sqlite = sqliteIndexPort();
  await sqlite.put([
    note('Notes/Garden.md', 'Garden'),
    note('Library/Seeds.md', 'Seeds', FILED_UNDER_GARDEN),
    note('Library/Soil.md', 'Soil'),
  ]);
  const statements: { sql: string; parameters: readonly (string | number | null)[] }[] = [];
  const index: Pick<IndexPort, 'query'> = {
    query: (sql, parameters) => {
      statements.push({ sql, parameters });
      return sqlite.query(sql, parameters);
    },
  };
  const { client, wrapper } = queryWrapper();
  const invalidator = createReadInvalidator({ client });
  const view = renderHook(() => useLibraryRead({ index, vault: VAULT, ready: true }), { wrapper });
  await waitFor(() => expect(view.result.current.kind).toBe('ready'));
  const projectsOf = (path: string) =>
    view.result.current.kind === 'ready'
      ? view.result.current.entries
          .find((entry) => entry.path === path)
          ?.projects.map((project) => project.name)
      : undefined;
  return { sqlite, invalidator, statements, projectsOf };
}

describe('the Library, told that an untyped note it files a source under changed (PR #525 regression)', () => {
  it('shows the new title, reading again only the sources filed under it', async () => {
    const { sqlite, invalidator, statements, projectsOf } = await openLibrary();
    expect(projectsOf('Library/Seeds.md')).toEqual(['Garden']);
    await sqlite.put([note('Notes/Garden.md', 'Kitchen garden')]);
    statements.length = 0;

    invalidator.noteChanges(VAULT, [retitled('Notes/Garden.md')]);
    invalidator.indexMoved(VAULT);

    await waitFor(() => expect(projectsOf('Library/Seeds.md')).toEqual(['Kitchen garden']));
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.every((each) => each.parameters.includes('Library/Seeds.md'))).toBe(true);
  });
});
