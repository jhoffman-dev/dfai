// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createVaultPath, NO_LINKS, type NoteLinks } from '@dfai/domain';
import { fakeIndexPort, fakeVaultFs, type OpenNotes } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { createIndexStatusStore } from '../index/index-status-store.ts';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import { vaultReadKey } from '../reads/query-client.ts';
import { createReadInvalidator } from '../reads/read-invalidator.ts';
import { useVaultGraph } from './use-vault-graph.ts';
import { useUnlinkedMentions } from './use-unlinked-mentions.ts';

/** An index holding two notes, one linking the other. */
function graphIndex() {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('graph:notes')) {
      return {
        columns: ['path', 'title', 'type'],
        rows: [
          ['a.md', 'A', null],
          ['b.md', 'B', null],
        ],
        truncated: false,
      };
    }
    if (sql.includes('graph:links')) {
      return { columns: ['source', 'target'], rows: [['a.md', 'b.md']], truncated: false };
    }
    return { columns: ['source', 'key', 'value'], rows: [], truncated: false };
  });
  return { index: fakeIndexPort({ query }), query };
}

describe('useVaultGraph', () => {
  it('waits for the index, then reads the graph once, and again only when told it changed', async () => {
    const { index, query } = graphIndex();
    const { client, wrapper } = queryWrapper();
    const { result, rerender } = renderHook(
      ({ ready }) => useVaultGraph({ index, vaultKey: '/vault', ready }),
      { initialProps: { ready: false }, wrapper },
    );
    expect(result.current.kind).toBe('loading');
    expect(query).not.toHaveBeenCalled();

    rerender({ ready: true });
    await waitFor(() => expect(result.current.kind).toBe('ready'));
    const state = result.current;
    expect(state.kind === 'ready' && state.graph.edges.map((edge) => edge.id)).toEqual([
      'link::a.md->b.md',
    ]);
    const reads = query.mock.calls.length;

    // Drawn again with nothing changed: the same answer, nothing asked.
    rerender({ ready: true });
    expect(result.current).toBe(state);
    expect(query.mock.calls.length).toBe(reads);

    await act(() => client.invalidateQueries({ queryKey: vaultReadKey('/vault', 'graph') }));
    await waitFor(() => expect(query.mock.calls.length).toBe(reads * 2));
  });

  it('reads each vault’s graph under its own key', async () => {
    const { index, query } = graphIndex();
    const { client, wrapper } = queryWrapper();
    const { rerender } = renderHook(
      ({ vaultKey }) => useVaultGraph({ index, vaultKey, ready: true }),
      { initialProps: { vaultKey: '/one' }, wrapper },
    );
    await waitFor(() => expect(client.getQueryData(vaultReadKey('/one', 'graph'))).toBeDefined());
    const reads = query.mock.calls.length;

    rerender({ vaultKey: '/two' });
    await waitFor(() => expect(client.getQueryData(vaultReadKey('/two', 'graph'))).toBeDefined());
    expect(query.mock.calls.length).toBe(reads * 2);
  });

  it('says why when the index cannot be read', async () => {
    const index = fakeIndexPort({
      query: async () => {
        throw new Error('no such table: links');
      },
    });
    const { result } = renderHook(
      () => useVaultGraph({ index, vaultKey: '/vault', ready: true }),
      queryWrapper(),
    );
    await waitFor(() => expect(result.current.kind).toBe('failed'));
    expect(result.current.kind === 'failed' && result.current.message).toBe(
      'The index could not be read: no such table: links',
    );
  });
});

const atlas = createVaultPath('DFAI.md');
const mentioning = createVaultPath('journal.md');
const text = 'Worked on DFAI today.\n';

function mentionPorts(state: 'closed' | 'dirty' = 'closed') {
  const writeTextFile = vi.fn(async () => 2);
  const openNotes: OpenNotes = {
    state: () => state,
    setPropertiesIfOpen: async () => false,
    reload: vi.fn(),
  };
  return {
    writeTextFile,
    ports: {
      index: fakeIndexPort({
        search: async () => [{ path: mentioning, title: 'journal', snippet: '' }],
      }),
      fs: fakeVaultFs({
        readNotes: async () => [{ path: mentioning, text, modified: 1, size: text.length }],
        readTextFile: async () => ({ text, modified: 1 }),
        writeTextFile,
      }),
      markdown: remarkMarkdown,
      openNotes,
    },
  };
}

function mentionsOf(ports: ReturnType<typeof mentionPorts>['ports'], onChanged = vi.fn()) {
  const links: NoteLinks = NO_LINKS;
  const status = createIndexStatusStore();
  status.setState({ vault: '/v', phase: 'ready', revision: 1 });
  const { client, wrapper } = queryWrapper();
  const reads = createReadInvalidator({ client });
  const hook = renderHook(
    ({ path }) =>
      useUnlinkedMentions({
        ports,
        note: { path, title: 'DFAI' },
        links,
        index: { status, vault: '/v' },
        onChanged,
      }),
    { initialProps: { path: atlas }, wrapper },
  );
  /** The index settles having found `path` changed. */
  const changed = (path: string) =>
    act(() => {
      reads.noteChanges('/v', [{ kind: 'changed', path, type: null, digest: 'b', before: 'a' }]);
      status.setState({ revision: status.getState().revision + 1 });
      reads.indexMoved('/v');
    });
  return { ...hook, changed };
}

describe('useUnlinkedMentions', () => {
  it('looks for nothing until asked, then lists the notes naming this one', async () => {
    const { ports } = mentionPorts();
    const search = vi.spyOn(ports.index, 'search');
    const { result } = mentionsOf(ports);
    expect(result.current.state).toEqual({ kind: 'idle' });
    expect(search).not.toHaveBeenCalled();

    act(() => result.current.find());
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
    expect(result.current.state).toEqual({
      kind: 'ready',
      mentions: [{ path: 'journal.md', title: 'journal', excerpt: 'Worked on DFAI today.' }],
    });
  });

  it('looks again for any note changed once asked, and hears nothing of the index before', async () => {
    const { ports } = mentionPorts();
    const search = vi.spyOn(ports.index, 'search');
    const { result, changed } = mentionsOf(ports);

    await changed('Notes/Unrelated.md');
    await act(() => new Promise((turn) => setTimeout(turn, 0)));
    expect(search).not.toHaveBeenCalled();

    act(() => result.current.find());
    await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    await changed('Notes/Unrelated.md');
    await waitFor(() => expect(search).toHaveBeenCalledTimes(2));
  });

  it('forgets what it found when another note opens', async () => {
    const { ports } = mentionPorts();
    const { result, rerender } = mentionsOf(ports);
    act(() => result.current.find());
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));

    rerender({ path: createVaultPath('Other.md') });
    expect(result.current.state).toEqual({ kind: 'idle' });
  });

  it('links a mention, then says the vault changed', async () => {
    const { ports, writeTextFile } = mentionPorts();
    const onChanged = vi.fn();
    const { result } = mentionsOf(ports, onChanged);
    act(() => result.current.link(mentioning));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(writeTextFile).toHaveBeenCalledWith({
      path: mentioning,
      contents: 'Worked on [[DFAI]] today.\n',
      expectedModified: 1,
    });
  });

  it('says why a mention could not be linked', async () => {
    const { ports, writeTextFile } = mentionPorts('dirty');
    const { result } = mentionsOf(ports);
    act(() => result.current.link(mentioning));
    await waitFor(() => expect(result.current.state.kind).toBe('failed'));
    expect(result.current.state).toEqual({
      kind: 'failed',
      message: 'journal has unsaved changes. Save it first.',
    });
    expect(writeTextFile).not.toHaveBeenCalled();
  });
});
