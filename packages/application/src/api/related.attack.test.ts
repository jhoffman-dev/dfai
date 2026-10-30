import { describe, expect, it } from 'vitest';
import { apiFixture, bodyOf, codeOf, VAULT } from '../testing/api-fixture.ts';
import type { SemanticAccess } from '../embeddings/semantic-search.ts';
import { relatedEngine } from '../testing/related-engine.ts';

const NOTES = {
  'Plan.md': 'Mara Quill moves payday to Friday.',
  'Payroll/Wages.md': 'Wages are paid on the last Friday.',
  'Home/Garden.md': 'Tobias Fenn keeps bees.',
  '.atlas/templates/Meeting.md': 'Payday meeting agenda.',
};

const emptyGraph = {
  query: async () => ({ columns: [], rows: [], truncated: false }),
};

const relatedGet = (path: string) => ({
  method: 'GET' as const,
  path: `/v1/notes/${encodeURIComponent(path)}/related`,
  query: {},
});

describe('GET /v1/notes/{path}/related, attacked', () => {
  it('refuses a path out of the vault or into .atlas without asking the cache', async () => {
    let asked = 0;
    const access: SemanticAccess = {
      isOn: () => true,
      search: async () => ({ hits: [], progress: { done: 0, total: 0, failure: null } }),
      related: async () => {
        asked += 1;
        return { notes: [], embedded: true, progress: { done: 0, total: 0, failure: null } };
      },
    };
    const api = apiFixture({ files: NOTES, index: emptyGraph, semantic: () => access });
    for (const path of ['../outside.md', 'Home/../../outside.md', '.atlas/templates/Meeting.md'])
      expect(['invalid', 'not_found']).toContain(codeOf(await api.send(relatedGet(path))));
    expect(asked).toBe(0);
  });

  it('never puts a vector, or anything but the four fields, in the answer', async () => {
    const { engine } = relatedEngine(NOTES, { vault: VAULT.absolutePath });
    await engine.start();
    await engine.settled();
    const api = apiFixture({ files: NOTES, index: emptyGraph, semantic: () => engine });
    const body = bodyOf(await api.send(relatedGet('Plan.md'))) as {
      related: Record<string, unknown>[];
    };
    expect(body.related.length).toBeGreaterThan(0);
    for (const note of body.related)
      expect(Object.keys(note).sort()).toEqual(['link', 'path', 'score', 'title']);
    expect(body.related.map((note) => note.path)).not.toContain('.atlas/templates/Meeting.md');
  });

  it('says not embedded, with no notes, for a note the cache has not read', async () => {
    const { engine } = relatedEngine(NOTES, { vault: VAULT.absolutePath });
    await engine.start();
    await engine.settled();
    const files = { ...NOTES, 'Fresh.md': 'Written a moment ago.' };
    const api = apiFixture({ files, index: emptyGraph, semantic: () => engine });
    const response = await api.send(relatedGet('Fresh.md'));
    expect(bodyOf(response)).toMatchObject({ related: [], embedded: false });
  });
});
