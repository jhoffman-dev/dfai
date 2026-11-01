// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createTagRenames, fakeIndexPort, fakeVaultFs } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import type { TagCount } from '@dfai/domain';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import { useVaultTags } from './use-vault-tags.ts';
import { useTagsPage, type TagsPagePorts } from './use-tags-page.ts';

const COUNTS: TagCount[] = [
  { key: 'idea', name: 'Idea', count: 2 },
  { key: 'para/area', name: 'para/area', count: 5 },
];

/** An index holding two tags, and one note using `idea`. */
function tagIndex({ failNotes = false } = {}) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('tags:counts')) {
      return {
        columns: ['key', 'name', 'count'],
        rows: COUNTS.map((tag) => [tag.key, tag.name, tag.count]),
        truncated: false,
      };
    }
    if (failNotes) throw new Error('the index is gone');
    return { columns: ['path', 'title', 'count'], rows: [['a.md', 'A', 2]], truncated: false };
  });
  return { index: fakeIndexPort({ query }), query };
}

function vault(files: Record<string, string>) {
  const disk = new Map(Object.entries(files));
  const fs = fakeVaultFs({
    readNotes: async (paths) =>
      paths.map((path) => ({ path, text: disk.get(path) ?? '', modified: 1, size: 1 })),
    readTextFile: async (path) => ({ text: disk.get(path) ?? '', modified: 1 }),
    writeTextFile: async ({ path, contents }) => {
      disk.set(path, contents);
      return 2;
    },
  });
  return { fs, disk };
}

const closed = { state: () => 'closed' as const, flush: async () => {}, reload: () => {} };

describe('useVaultTags', () => {
  it('waits for the index, then reads the tags and suggests from them', async () => {
    const { index, query } = tagIndex();
    const { result, rerender } = renderHook(
      ({ ready }) => useVaultTags({ index, vaultKey: '/vault', ready }),
      { initialProps: { ready: false }, wrapper: queryWrapper().wrapper },
    );
    expect(result.current.state.kind).toBe('loading');
    expect(result.current.suggest('id')).toEqual([{ kind: 'create', name: 'id' }]);
    expect(query).not.toHaveBeenCalled();

    rerender({ ready: true });
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
    // What was typed comes first, to create; the vault's tag after it.
    expect(result.current.suggest('id')[1]).toEqual({ kind: 'existing', name: 'Idea', count: 2 });
  });

  it('says when the tags could not be read', async () => {
    const index = fakeIndexPort({ query: async () => Promise.reject(new Error('locked')) });
    const { result } = renderHook(
      () => useVaultTags({ index, vaultKey: '/vault', ready: true }),
      queryWrapper(),
    );
    await waitFor(() =>
      expect(result.current.state).toEqual({
        kind: 'failed',
        message: 'The tags could not be read: locked',
      }),
    );
  });
});

function page({
  selected = 'idea' as string | null,
  files = { 'a.md': 'An #Idea and #idea.\n' } as Record<string, string>,
  failNotes = false,
} = {}) {
  const { index } = tagIndex({ failNotes });
  const { fs, disk } = vault(files);
  const renames = createTagRenames().forVault('/vault');
  const ports: TagsPagePorts = { index, fs, markdown: remarkMarkdown, editors: closed, renames };
  const onChanged = vi.fn();
  const onSelect = vi.fn();
  const hook = renderHook(
    ({ key }) =>
      useTagsPage({ ports, counts: COUNTS, selected: key, indexKey: 'k', onChanged, onSelect }),
    { initialProps: { key: selected } },
  );
  return { ...hook, disk, onChanged, onSelect, renames };
}

describe('useTagsPage', () => {
  it('builds the tree in the order asked for', () => {
    const { result } = page({ selected: null });
    expect(result.current.tree.map((node) => node.label)).toEqual(['Idea', 'para']);
    act(() => result.current.setSort('frequency'));
    expect(result.current.tree.map((node) => node.label)).toEqual(['para', 'Idea']);
    expect(result.current.node).toBeNull();
  });

  it('lists the chosen tag’s notes', async () => {
    const { result } = page();
    expect(result.current.node?.name).toBe('Idea');
    expect(result.current.notes.kind).toBe('loading');
    await waitFor(() =>
      expect(result.current.notes).toEqual({
        kind: 'ready',
        notes: [{ path: 'a.md', title: 'A', count: 2 }],
      }),
    );
  });

  it('says why the notes could not be listed', async () => {
    const { result } = page({ failNotes: true });
    await waitFor(() =>
      expect(result.current.notes).toEqual({ kind: 'failed', message: 'the index is gone' }),
    );
  });

  it('refuses a name a tag cannot have without reading anything', () => {
    const { result } = page();
    act(() => result.current.preview('#123'));
    expect(result.current.rename.kind).toBe('refused');
  });

  it('previews, then renames, then chooses the tag under its new name', async () => {
    const { result, disk, onChanged, onSelect } = page();
    act(() => result.current.preview('#Thought'));
    await waitFor(() => expect(result.current.rename.kind).toBe('planned'));
    expect(disk.get('a.md')).toBe('An #Idea and #idea.\n');

    act(() => result.current.confirm());
    await waitFor(() => expect(result.current.notice).toBe('Renamed in 1 note.'));
    expect(disk.get('a.md')).toBe('An #Thought and #Thought.\n');
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('thought');
    expect(result.current.rename.kind).toBe('idle');
  });

  it('renames through the vault’s queue, agreeing to a merge only when the preview showed one', async () => {
    const { result, renames } = page();
    const rename = vi.spyOn(renames, 'rename');

    act(() => result.current.preview('#Thought'));
    await waitFor(() => expect(result.current.rename.kind).toBe('planned'));
    act(() => result.current.confirm());
    await waitFor(() => expect(rename).toHaveBeenCalledTimes(1));
    expect(rename.mock.calls[0]?.[0]).toMatchObject({ merge: false });

    // `#para` is in use as the parent of `#para/area`: the preview says it merges.
    act(() => result.current.preview('#para'));
    await waitFor(() => expect(result.current.rename.kind).toBe('planned'));
    act(() => result.current.confirm());
    await waitFor(() => expect(rename).toHaveBeenCalledTimes(2));
    expect(rename.mock.calls[1]?.[0]).toMatchObject({ merge: true });
  });

  it('says why when the rename is refused at the moment of writing', async () => {
    const { result, renames } = page();
    vi.spyOn(renames, 'rename').mockRejectedValue(new Error('#Thought is in use already.'));
    act(() => result.current.preview('#Thought'));
    await waitFor(() => expect(result.current.rename.kind).toBe('planned'));
    act(() => result.current.confirm());
    await waitFor(() =>
      expect(result.current.rename).toEqual({
        kind: 'refused',
        message: '#Thought is in use already.',
      }),
    );
  });

  it('leaves a half-done rename behind when another tag is chosen', async () => {
    const { result, rerender } = page();
    act(() => result.current.preview('#Thought'));
    await waitFor(() => expect(result.current.rename.kind).toBe('planned'));
    rerender({ key: 'para/area' });
    expect(result.current.rename.kind).toBe('idle');
  });

  it('cancels a preview', async () => {
    const { result } = page();
    act(() => result.current.preview('#Thought'));
    await waitFor(() => expect(result.current.rename.kind).toBe('planned'));
    act(() => result.current.cancel());
    expect(result.current.rename.kind).toBe('idle');
  });
});
