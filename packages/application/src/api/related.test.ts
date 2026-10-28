import { describe, expect, it } from 'vitest';
import { apiFixture, bodyOf, codeOf, VAULT } from '../testing/api-fixture.ts';
import type { RelatedAnswer, RelatedQuery } from '../embeddings/related-by-meaning.ts';
import type { SemanticAccess } from '../embeddings/semantic-search.ts';
import { relatedEngine } from '../testing/related-engine.ts';

const PROGRESS = { done: 4, total: 4, failure: null };

const FILES = {
  'Plan.md': 'Pay day moves to Friday.\n',
  'Budget.md': 'See [[Plan]].\n',
  'Home/Garden.md': 'Bees.\n',
};

/** The index's graph: three notes, and Budget linking to Plan. */
const graphIndex = {
  query: async (sql: string) => {
    if (sql.includes('graph:notes'))
      return {
        columns: ['path', 'title', 'type'],
        rows: Object.keys(FILES).map((path) => [path, path.replace(/^.*\//, ''), null]),
        truncated: false,
      };
    if (sql.includes('graph:links'))
      return { columns: ['source', 'target'], rows: [['Budget.md', 'Plan.md']], truncated: false };
    return { columns: [], rows: [], truncated: false };
  },
};

function recordingRelated(answer: Partial<RelatedAnswer> = {}, on = true) {
  const asked: RelatedQuery[] = [];
  const access: SemanticAccess = {
    isOn: () => on,
    search: async () => {
      throw new Error('related notes never search');
    },
    related: async (query) => {
      asked.push(query);
      return {
        notes: [
          { path: 'Home/Garden.md', title: 'Garden', target: 'Garden', score: 0.62 },
          { path: '.atlas/templates/Plan.md', title: 'Plan', target: 'x', score: 0.5 },
        ],
        embedded: true,
        progress: PROGRESS,
        ...answer,
      };
    },
  };
  return { asked, access };
}

const relatedGet = (path: string, query: Record<string, string> = {}) => ({
  method: 'GET' as const,
  path: `/v1/notes/${encodeURIComponent(path)}/related`,
  query,
});

describe('GET /v1/notes/{path}/related', () => {
  it('answers the notes close in meaning, each with the link to write, in the vault named', async () => {
    const { asked, access } = recordingRelated();
    const vaults: string[] = [];
    const api = apiFixture({
      files: FILES,
      index: graphIndex,
      semantic: (vault) => {
        vaults.push(vault);
        return access;
      },
    });

    const response = await api.send(relatedGet('Plan.md', { limit: '3' }));

    expect(response.status).toBe(200);
    expect(vaults).toEqual([VAULT.absolutePath]);
    expect(bodyOf(response)).toEqual({
      related: [{ path: 'Home/Garden.md', title: 'Garden', link: '[[Garden]]', score: 0.62 }],
      embedded: true,
      progress: PROGRESS,
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.path).toBe('Plan.md');
    expect(asked[0]!.limit).toBe(3);
    // Budget links here: already connected, so never offered.
    expect([...asked[0]!.exclude.linked]).toEqual(['Budget.md']);
  });

  it('says so while the note has no meanings cached yet', async () => {
    const { access } = recordingRelated({ notes: [], embedded: false });
    const api = apiFixture({ files: FILES, index: graphIndex, semantic: () => access });
    const response = await api.send(relatedGet('Plan.md'));
    expect(response.status).toBe(200);
    expect(bodyOf(response)).toEqual({ related: [], embedded: false, progress: PROGRESS });
  });

  it('answers semantic_off where search by meaning is off, reading nothing of the index', async () => {
    const { asked, access } = recordingRelated({}, false);
    const queries: string[] = [];
    const index = {
      query: async (sql: string) => {
        queries.push(sql);
        return graphIndex.query(sql);
      },
    };
    const api = apiFixture({ files: FILES, index, semantic: () => access });
    const response = await api.send(relatedGet('Plan.md'));
    expect(codeOf(response)).toBe('semantic_off');
    expect(asked).toHaveLength(0);
    expect(queries).toEqual([]);
  });

  it('answers query_failed where the app offers no search by meaning', async () => {
    const api = apiFixture({ files: FILES, index: graphIndex });
    expect(codeOf(await api.send(relatedGet('Plan.md')))).toBe('query_failed');
  });

  it('refuses a note that is not there, and a limit out of range', async () => {
    const { access } = recordingRelated();
    const api = apiFixture({ files: FILES, index: graphIndex, semantic: () => access });
    expect(codeOf(await api.send(relatedGet('Gone.md')))).toBe('not_found');
    expect(codeOf(await api.send(relatedGet('Plan.md', { limit: '0' })))).toBe('invalid');
    expect(codeOf(await api.send(relatedGet('Plan.md', { limit: '51' })))).toBe('invalid');
  });

  it('says why, without paths, when the cache cannot answer', async () => {
    const access: SemanticAccess = {
      isOn: () => true,
      search: async () => ({ hits: [], progress: PROGRESS }),
      related: async () => {
        throw new Error('the cache at /Users/someone/vault/.atlas-cache is torn');
      },
    };
    const api = apiFixture({ files: FILES, index: graphIndex, semantic: () => access });
    const response = await api.send(relatedGet('Plan.md'));
    expect(codeOf(response)).toBe('query_failed');
    expect(JSON.stringify(bodyOf(response))).not.toContain('/Users/someone');
  });
});

describe('GET /v1/notes/{path}/related, from the app’s own cache', () => {
  it('never answers a note gone from the vault whose forget is still queued', async () => {
    const notes = {
      'Plan.md': 'Mara Quill moves payday to Friday.',
      'Payroll/Wages.md': 'Wages are paid on the last Friday.',
      'Old/Salary.md': 'The salary was paid weekly.',
    };
    const { engine, busy, remove } = relatedEngine(notes, { vault: VAULT.absolutePath });
    await engine.start();
    await engine.settled();
    busy('Old/Salary.md');
    remove('Payroll/Wages.md');
    const api = apiFixture({ files: notes, index: graphIndex, semantic: () => engine });

    const response = await api.send(relatedGet('Plan.md'));

    expect(response.status).toBe(200);
    const paths = (bodyOf(response) as { related: { path: string }[] }).related.map(
      (note) => note.path,
    );
    expect(paths).toContain('Old/Salary.md');
    expect(paths).not.toContain('Payroll/Wages.md');
  });
});
