// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createVaultPath, EMPTY_GRAPH, type VaultGraph } from '@dfai/domain';
import {
  fakeIndexPort,
  fakeVaultFs,
  type RelatedAnswer,
  type RelatedQuery,
} from '@dfai/application';
import { createBrowserDismissedRelatedStore } from './browser-related-stores.ts';
import { createTrailMemory } from './trail-memory.ts';
import { useRelatedNotes, type RelatedPorts } from './use-related-notes.ts';

const PLAN = createVaultPath('Plan.md');
const GARDEN = createVaultPath('Home/Garden.md');
const HONEY = createVaultPath('Home/Honey.md');
const PROGRESS = { done: 3, total: 3, failure: null };

afterEach(() => window.localStorage.clear());

function setUp({
  open = true,
  answer = {},
  graph = EMPTY_GRAPH,
}: { open?: boolean; answer?: Partial<RelatedAnswer>; graph?: VaultGraph | null } = {}) {
  const related = vi.fn<(query: RelatedQuery) => Promise<RelatedAnswer>>(async () => ({
    notes: [
      { path: GARDEN, title: 'Garden', target: 'Garden', score: 0.8 },
      { path: HONEY, title: 'Honey', target: 'Honey', score: 0.6 },
    ],
    embedded: true,
    progress: PROGRESS,
    ...answer,
  }));
  let shut = !open;
  const ports: RelatedPorts = {
    semantic: { isOn: () => true, related, settled: async () => {} },
    idle: { idle: async () => {} },
    dismissed: createBrowserDismissedRelatedStore('/vault'),
    panel: { isOpen: () => !shut, setOpen: (to) => (shut = !to) },
    trails: createTrailMemory(),
  };
  const files = new Map([['Plan.md', 'Pay day moves to Friday.\n']]);
  const order: string[] = [];
  const fs = fakeVaultFs({
    readTextFile: async (path) => ({ text: files.get(path) ?? '', modified: 1 }),
    writeTextFile: async ({ path, contents }) => {
      order.push('write');
      files.set(path, contents);
      return 2;
    },
  });
  const editor = {
    flush: vi.fn(async () => {
      order.push('flush');
    }),
    reload: vi.fn(() => {
      order.push('reload');
    }),
  };
  const onChanged = vi.fn();
  const index = fakeIndexPort({
    manifest: async () =>
      ['Plan.md', 'Home/Garden.md', 'Home/Honey.md'].map((path) => ({
        path,
        digest: path,
        type: null,
        modified: 1,
        size: 1,
      })),
  });
  const hook = renderHook(() =>
    useRelatedNotes({
      ports,
      graph,
      path: PLAN,
      fs,
      index,
      editor,
      onChanged,
      trailHere: false,
    }),
  );
  return { hook, related, ports, files, editor, order, onChanged };
}

describe('the open note’s related notes', () => {
  it('looks for nothing while the section is shut', async () => {
    const { hook, related } = setUp({ open: false });
    await act(async () => {});
    expect(hook.result.current.open).toBe(false);
    expect(related).not.toHaveBeenCalled();
  });

  it('looks once opened, and remembers it was left open on this Mac', async () => {
    const { hook, related, ports } = setUp({ open: false });
    act(() => hook.result.current.toggle());
    await waitFor(() => expect(hook.result.current.state.kind).toBe('ready'));
    expect(related).toHaveBeenCalledOnce();
    expect(ports.panel.isOpen()).toBe(true);
  });

  it('waits for the graph before looking, so linked notes are never offered', async () => {
    const { hook, related } = setUp({ graph: null });
    await act(async () => {});
    expect(related).not.toHaveBeenCalled();
    expect(hook.result.current.state).toEqual({ kind: 'loading' });
  });

  it('accepts by saving the editor, writing the link, then reading the note again', async () => {
    const { hook, files, order, onChanged } = setUp();
    await waitFor(() => expect(hook.result.current.state.kind).toBe('ready'));
    act(() => hook.result.current.accept(GARDEN));
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(order).toEqual(['flush', 'write', 'reload']);
    expect(files.get('Plan.md')).toBe('Pay day moves to Friday.\n\n## Related\n\n- [[Garden]]\n');
    const state = hook.result.current.state;
    expect(state.kind === 'ready' && state.notes.map((note) => note.path)).toEqual([HONEY]);
  });

  it('dismisses for this note, on this Mac, and asks again without it', async () => {
    const { hook, related } = setUp();
    await waitFor(() => expect(hook.result.current.state.kind).toBe('ready'));
    act(() => hook.result.current.dismiss(HONEY));
    const state = hook.result.current.state;
    expect(state.kind === 'ready' && state.notes.map((note) => note.path)).toEqual([GARDEN]);
    await waitFor(() => expect(related).toHaveBeenCalledTimes(2));
    expect([...related.mock.calls[1]![0].exclude.dismissed]).toEqual([HONEY]);
    expect([...createBrowserDismissedRelatedStore('/vault').dismissed(PLAN)]).toEqual([HONEY]);
  });

  it('looks again once a build still reading the vault settles, and not for a note read empty', async () => {
    const reading = setUp({
      answer: { notes: [], embedded: false, progress: { done: 1, total: 9, failure: null } },
    });
    await waitFor(() => expect(reading.related).toHaveBeenCalledTimes(2));
    const read = setUp({
      answer: { notes: [], embedded: false, progress: { done: 9, total: 9, failure: null } },
    });
    await waitFor(() => expect(read.hook.result.current.state.kind).toBe('not-built'));
    await act(async () => {});
    expect(read.related).toHaveBeenCalledOnce();
  });

  it('says the note is not read for meaning yet, with how far the build is', async () => {
    const { hook } = setUp({
      answer: { notes: [], embedded: false, progress: { done: 1, total: 9, failure: null } },
    });
    await waitFor(() =>
      expect(hook.result.current.state).toEqual({ kind: 'not-built', done: 1, total: 9 }),
    );
  });

  it('says why a link could not be written', async () => {
    const { hook, editor } = setUp();
    editor.flush.mockRejectedValueOnce(new Error('Plan has unsaved changes'));
    await waitFor(() => expect(hook.result.current.state.kind).toBe('ready'));
    act(() => hook.result.current.accept(GARDEN));
    await waitFor(() =>
      expect(hook.result.current.state).toEqual({
        kind: 'failed',
        message: 'Plan has unsaved changes',
      }),
    );
  });
});
