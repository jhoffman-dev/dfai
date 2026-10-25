import { describe, expect, it } from 'vitest';
import { apiFixture, bodyOf, codeOf, VAULT } from '../testing/api-fixture.ts';
import { EmbeddingError } from '../embeddings/ports.ts';
import type {
  SemanticAnswer,
  SemanticQuery,
  SemanticAccess,
} from '../embeddings/semantic-search.ts';

const PROGRESS = { done: 3, total: 5, failure: null };

function recordingSearch(answer: Partial<SemanticAnswer> = {}) {
  const asked: SemanticQuery[] = [];
  const search: SemanticAccess = {
    isOn: () => true,
    search: async (query) => {
      asked.push(query);
      return {
        hits: [
          {
            path: 'Meetings/Standup.md',
            title: 'Standup',
            text: 'Pay day moves to Friday.',
            heading: 'Payroll',
            block: 'k3x9a1',
            link: '[[Standup#^k3x9a1]]',
            score: 0.81,
          },
          {
            path: 'Archive/Old.md',
            title: 'Old',
            text: 'Wages were paid monthly.',
            heading: null,
            block: null,
            link: '[[Old]]',
            score: 0.5,
          },
        ],
        progress: PROGRESS,
        ...answer,
      };
    },
  };
  return { asked, search };
}

const semanticGet = (query: Record<string, string>) => ({
  method: 'GET' as const,
  path: '/v1/search',
  query: { mode: 'semantic', ...query },
});

describe('GET /v1/search?mode=semantic', () => {
  it('answers with blocks by meaning, each with its link, and the build’s progress', async () => {
    const { asked, search } = recordingSearch();
    const vaults: string[] = [];
    const api = apiFixture({
      semantic: (vault) => {
        vaults.push(vault);
        return search;
      },
    });

    const response = await api.send(semanticGet({ q: 'when are wages paid', limit: '5' }));

    expect(response.status).toBe(200);
    expect(vaults).toEqual([VAULT.absolutePath]);
    expect(asked).toEqual([{ query: 'when are wages paid', limit: 5, includeArchived: false }]);
    expect(bodyOf(response)).toEqual({
      hits: [
        {
          path: 'Meetings/Standup.md',
          title: 'Standup',
          text: 'Pay day moves to Friday.',
          heading: 'Payroll',
          block: 'k3x9a1',
          link: '[[Standup#^k3x9a1]]',
          score: 0.81,
        },
        {
          path: 'Archive/Old.md',
          title: 'Old',
          text: 'Wages were paid monthly.',
          heading: null,
          block: null,
          link: '[[Old]]',
          score: 0.5,
          archived: true,
        },
      ],
      progress: PROGRESS,
    });
  });

  it('passes includeArchived on, and the default limit', async () => {
    const { asked, search } = recordingSearch();
    const api = apiFixture({ semantic: () => search });
    await api.send(semanticGet({ q: 'pay', includeArchived: 'true' }));
    expect(asked).toEqual([{ query: 'pay', limit: 20, includeArchived: true }]);
  });

  it('leaves out a hit the API could not then read', async () => {
    const { search } = recordingSearch({
      hits: [
        {
          path: '.atlas/proposals/p.md',
          title: 'p',
          text: 'x',
          heading: null,
          block: null,
          link: '[[p]]',
          score: 1,
        },
      ],
    });
    const api = apiFixture({ semantic: () => search });
    expect(bodyOf(await api.send(semanticGet({ q: 'x' })))['hits']).toEqual([]);
  });

  it('says semantic search is not available where the app has none', async () => {
    const response = await apiFixture().send(semanticGet({ q: 'pay' }));
    expect(codeOf(response)).toBe('query_failed');
    expect(bodyOf(response)['error']).toMatchObject({
      message: 'Semantic search is not available in this vault',
    });
    const none = await apiFixture({ semantic: () => null }).send(semanticGet({ q: 'pay' }));
    expect(codeOf(none)).toBe('query_failed');
  });

  it('never turns search by meaning on: a vault where it is off answers semantic_off, asking nothing', async () => {
    const { asked, search } = recordingSearch();
    const api = apiFixture({ semantic: () => ({ ...search, isOn: () => false }) });
    const response = await api.send(semanticGet({ q: 'pay' }));
    expect(response.status).toBe(409);
    expect(codeOf(response)).toBe('semantic_off');
    expect(JSON.stringify(bodyOf(response))).toContain('turn it on from ⌘K');
    expect(asked).toEqual([]);
  });

  it('refuses a q longer than 1000 characters, and takes one of exactly 1000', async () => {
    const { asked, search } = recordingSearch();
    const api = apiFixture({ semantic: () => search });
    const refused = await api.send(semanticGet({ q: 'x'.repeat(1_001) }));
    expect(codeOf(refused)).toBe('invalid');
    expect(JSON.stringify(bodyOf(refused))).toContain('at most 1000 characters');
    expect((await api.send(semanticGet({ q: 'x'.repeat(1_000) }))).status).toBe(200);
    expect(asked).toHaveLength(1);
  });

  it('says why when the model cannot answer', async () => {
    const api = apiFixture({
      semantic: () => ({
        isOn: () => true,
        search: async () => {
          throw new EmbeddingError('the model could not be fetched: offline');
        },
      }),
    });
    const response = await api.send(semanticGet({ q: 'pay' }));
    expect(codeOf(response)).toBe('query_failed');
    expect(JSON.stringify(bodyOf(response))).toContain('offline');
  });

  it('refuses a mode it does not know, and a missing q', async () => {
    const api = apiFixture({ semantic: () => recordingSearch().search });
    expect(codeOf(await api.send(semanticGet({ q: 'pay', mode: 'vibes' })))).toBe('invalid');
    expect(codeOf(await api.send(semanticGet({})))).toBe('invalid');
  });

  it('searches by words when the mode is words or not said', async () => {
    const { asked, search } = recordingSearch();
    const api = apiFixture({ semantic: () => search });
    await api.send(semanticGet({ q: 'pay', mode: 'words' }));
    await api.send({ method: 'GET', path: '/v1/search', query: { q: 'pay' } });
    expect(asked).toEqual([]);
  });
});
