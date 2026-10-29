import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createVaultPath } from '@dfai/domain';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const { tauriIndex } = await import('./tauri-index.ts');

describe('tauriIndex', () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
  });

  it('opens the index, and passes on whether the host had to make it', async () => {
    invoke.mockResolvedValue({ fresh: true });
    await expect(tauriIndex.open()).resolves.toEqual({ fresh: true });
    expect(invoke).toHaveBeenCalledWith('index_open');
  });

  it('clears the index', async () => {
    await tauriIndex.clear();
    expect(invoke).toHaveBeenCalledWith('index_clear');
  });

  it('asks for the manifest', async () => {
    invoke.mockResolvedValue([{ path: 'a.md', modified: 1, size: 2 }]);
    await expect(tauriIndex.manifest()).resolves.toEqual([{ path: 'a.md', modified: 1, size: 2 }]);
    expect(invoke).toHaveBeenCalledWith('index_manifest');
  });

  it('sends notes to be indexed', async () => {
    const notes = [
      {
        path: 'a.md',
        title: 'A',
        modified: 1,
        size: 2,
        type: 'meeting',
        digest: '1a2b3c4d',
        body: 'text',
        summary: 'text',
        properties: [],
        links: [],
        tags: [{ key: 'idea', name: 'Idea' }],
        relations: [
          { key: 'owner', index: 0, target: 'Julie', name: 'julie', path: 'people/Julie.md' },
        ],
        blocks: [{ id: 'f3k9x2', text: 'The plan' }],
        checks: [{ done: true, text: 'Book the hall' }],
        progress: 100,
        highlights: [
          {
            id: 'k3x9q2',
            kind: 'pdf' as const,
            quote: 'All warfare is based on deception.',
            comment: '',
            mark: 'highlight' as const,
            color: 'yellow',
            anchor: '{"v":1,"kind":"pdf","page":3}',
          },
        ],
      },
    ];
    await tauriIndex.put(notes);
    expect(invoke).toHaveBeenCalledWith('index_put', { vault: null, notes });

    // Said to be one vault's, it names the vault, for the host to refuse it once another is open.
    await tauriIndex.put(notes, { vault: '/vaults/Larkspur' });
    expect(invoke).toHaveBeenLastCalledWith('index_put', { vault: '/vaults/Larkspur', notes });
  });

  it('removes notes by path', async () => {
    await tauriIndex.remove([createVaultPath('a.md')]);
    expect(invoke).toHaveBeenCalledWith('index_remove', { vault: null, paths: ['a.md'] });

    await tauriIndex.remove([createVaultPath('a.md')], { vault: '/vaults/Larkspur' });
    expect(invoke).toHaveBeenLastCalledWith('index_remove', {
      vault: '/vaults/Larkspur',
      paths: ['a.md'],
    });
  });

  it('runs a search with its limit', async () => {
    invoke.mockResolvedValue([]);
    await tauriIndex.search('"week"*', 20);
    expect(invoke).toHaveBeenCalledWith('index_search', {
      query: '"week"*',
      limit: 20,
      skipPrefix: null,
      highlights: false,
    });
  });

  it('hands the host the prefix a search leaves out', async () => {
    invoke.mockResolvedValue([]);
    await tauriIndex.search('"week"*', 20, { skipPrefix: 'archive/' });
    expect(invoke).toHaveBeenCalledWith('index_search', {
      query: '"week"*',
      limit: 20,
      skipPrefix: 'archive/',
      highlights: false,
    });
  });

  it('asks the host for the highlights too when the search wants them (#507)', async () => {
    invoke.mockResolvedValue([
      { path: 'Library/Art.md', title: 'Art', snippet: '<<war>>', block: 'k3x9q2' },
    ]);
    const hits = await tauriIndex.search('"war"*', 20, { highlights: true });
    expect(invoke).toHaveBeenCalledWith('index_search', {
      query: '"war"*',
      limit: 20,
      skipPrefix: null,
      highlights: true,
    });
    expect(hits).toEqual([
      { path: 'Library/Art.md', title: 'Art', snippet: '<<war>>', block: 'k3x9q2' },
    ]);
  });

  it('asks for the notes of a type', async () => {
    invoke.mockResolvedValue([{ path: 'a.md', title: 'Ada' }]);
    await expect(tauriIndex.notesOfType('person')).resolves.toEqual([
      { path: 'a.md', title: 'Ada' },
    ]);
    expect(invoke).toHaveBeenCalledWith('index_notes_of_type', { type: 'person' });
  });

  it('asks for backlinks', async () => {
    invoke.mockResolvedValue(['b.md']);
    await expect(tauriIndex.backlinks(createVaultPath('a.md'))).resolves.toEqual(['b.md']);
    expect(invoke).toHaveBeenCalledWith('index_backlinks', { path: 'a.md' });
  });

  it('rebuilds the views for the types it is given', async () => {
    const types = [{ name: 'task', select: 'SELECT n.path AS "path" FROM files AS n' }];
    await tauriIndex.rebuildViews(types);
    expect(invoke).toHaveBeenCalledWith('index_rebuild_views', { types });
  });

  it('runs a query with its parameters bound', async () => {
    invoke.mockResolvedValue({ columns: ['title'], rows: [['A']], truncated: false });
    const result = await tauriIndex.query('SELECT "title" FROM "v_task" LIMIT ?', [50]);
    expect(invoke).toHaveBeenCalledWith('index_query', {
      sql: 'SELECT "title" FROM "v_task" LIMIT ?',
      parameters: [50],
    });
    expect(result.rows).toEqual([['A']]);
  });

  it('reports the index statistics', async () => {
    invoke.mockResolvedValue({ notes: 3, properties: 4, links: 5 });
    await expect(tauriIndex.stats()).resolves.toEqual({ notes: 3, properties: 4, links: 5 });
  });

  it('turns a host refusal into a real error', async () => {
    invoke.mockImplementation(() => Promise.reject('the index is not open'));
    await expect(tauriIndex.stats()).rejects.toThrow('the index is not open');
  });
});
