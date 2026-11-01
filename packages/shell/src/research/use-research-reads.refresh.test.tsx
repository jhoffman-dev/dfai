// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { NoteChange } from '@dfai/domain';
import type { IndexedNote, IndexPort } from '@dfai/application';
import { sqliteIndexPort } from '@dfai/application/testing/sqlite';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import { createReadInvalidator } from '../reads/read-invalidator.ts';
import { useHighlightsRead } from './use-research-reads.ts';

/**
 * A literature note's change is spliced into what All highlights kept: only
 * that note is read again, and a change to any other note reads nothing.
 */

const VAULT = '/v';

function note(path: string, type: string, quotes: string[]): IndexedNote {
  return {
    path,
    title: path.replace(/^.*\//, '').replace(/\.md$/, ''),
    modified: 1,
    size: 0,
    digest: '',
    type,
    body: '',
    summary: '',
    properties: [{ key: 'type', index: 0, text: type, number: null, date: null, json: null }],
    links: [],
    tags: [],
    relations: [],
    blocks: [],
    checks: [],
    progress: null,
    highlights: quotes.map((quote, at) => ({
      id: `h${at}`,
      kind: 'pdf',
      quote,
      comment: '',
      mark: 'highlight',
      color: 'yellow',
      anchor: '{"v":1,"kind":"pdf","page":1}',
    })),
  };
}

const changed = (path: string, type: string): NoteChange => ({
  kind: 'changed',
  path,
  type,
  digest: 'x',
});

async function openHighlights() {
  const sqlite = sqliteIndexPort();
  await sqlite.put([
    note('Library/A.md', 'literature', ['Alpha one']),
    note('Library/B.md', 'literature', ['Beta one']),
    note('Notes/Plain.md', 'note', []),
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
  const view = renderHook(() => useHighlightsRead({ index, vault: VAULT, ready: true }), {
    wrapper,
  });
  await waitFor(() => expect(view.result.current.kind).toBe('ready'));
  const quotes = () =>
    view.result.current.kind === 'ready'
      ? view.result.current.entries.map((each) => each.quote)
      : [];
  return { sqlite, invalidator, statements, quotes };
}

describe('All highlights, told that a note changed', () => {
  it('reads again only the literature note that changed, and shows its new highlights', async () => {
    const { sqlite, invalidator, statements, quotes } = await openHighlights();
    expect(quotes()).toEqual(['Alpha one', 'Beta one']);
    await sqlite.put([note('Library/B.md', 'literature', ['Beta one', 'Beta two'])]);
    statements.length = 0;

    invalidator.noteChanges(VAULT, [changed('Library/B.md', 'literature')]);
    invalidator.indexMoved(VAULT);

    await waitFor(() => expect(quotes()).toEqual(['Alpha one', 'Beta one', 'Beta two']));
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.every((each) => each.parameters.includes('Library/B.md'))).toBe(true);
  });

  it('reads nothing for a change to a note that is not literature', async () => {
    const { invalidator, statements, quotes } = await openHighlights();
    statements.length = 0;

    // Fake timers, so everything the news set off — promises and timers alike — has run when it is checked.
    vi.useFakeTimers();
    try {
      invalidator.noteChanges(VAULT, [changed('Notes/Plain.md', 'note')]);
      invalidator.indexMoved(VAULT);
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }

    expect(statements).toEqual([]);
    expect(quotes()).toEqual(['Alpha one', 'Beta one']);
  });

  it('reads the whole again when the news does not say which notes changed', async () => {
    const { sqlite, invalidator, statements, quotes } = await openHighlights();
    await sqlite.put([note('Library/C.md', 'literature', ['Gamma one'])]);
    statements.length = 0;

    invalidator.indexMoved(VAULT, false);

    await waitFor(() => expect(quotes()).toEqual(['Alpha one', 'Beta one', 'Gamma one']));
    expect(statements.some((each) => !each.parameters.includes('Library/C.md'))).toBe(true);
  });
});
