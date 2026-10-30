// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createVaultPath, EMPTY_GRAPH, type VaultPath } from '@dfai/domain';
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

/** A disk that, like the real one, refuses a write against a modification time it no longer has. */
function setUp() {
  const related = vi.fn<(query: RelatedQuery) => Promise<RelatedAnswer>>(async () => ({
    notes: [
      { path: GARDEN, title: 'Garden', target: 'Garden', score: 0.8 },
      { path: HONEY, title: 'Honey', target: 'Honey', score: 0.6 },
    ],
    embedded: true,
    progress: PROGRESS,
  }));
  const ports: RelatedPorts = {
    semantic: { isOn: () => true, related, subscribe: () => () => {} },
    idle: { idle: async () => {} },
    dismissed: createBrowserDismissedRelatedStore('/vault'),
    panel: { isOpen: () => true, setOpen: () => {} },
    trails: createTrailMemory(),
  };
  const files = new Map([['Plan.md', 'Pay day moves to Friday.\n']]);
  let modified = 1;
  const fs = fakeVaultFs({
    readTextFile: async (path) => ({ text: files.get(path) ?? '', modified }),
    writeTextFile: async ({ path, contents, expectedModified }) => {
      if (expectedModified !== modified) throw new Error('Plan changed on disk');
      files.set(path, contents);
      modified += 1;
      return modified;
    },
  });
  const editor = { flush: vi.fn(async () => {}), reload: vi.fn() };
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
  const onChanged = vi.fn();
  const hook = renderHook(
    ({ path }: { path: VaultPath }) =>
      useRelatedNotes({
        ports,
        graph: EMPTY_GRAPH,
        path,
        fs,
        index,
        editor,
        onChanged,
        trailHere: false,
      }),
    { initialProps: { path: PLAN } },
  );
  return { hook, related, files, onChanged };
}

describe('Related notes in the window, attacked', () => {
  it('links once, and says nothing failed, when Link is pressed twice quickly', async () => {
    const { hook, files, onChanged } = setUp();
    await waitFor(() => expect(hook.result.current.state.kind).toBe('ready'));
    act(() => {
      hook.result.current.accept(GARDEN);
      hook.result.current.accept(GARDEN);
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    await act(async () => {});
    expect(files.get('Plan.md')).toBe('Pay day moves to Friday.\n\n## Related\n\n- [[Garden]]\n');
    const state = hook.result.current.state;
    const problems = state.kind === 'ready' ? state.notes.filter((note) => note.problem) : [];
    expect(problems).toEqual([]);
  });

  it('does not look again when the note is drawn again with nothing changed', async () => {
    const { hook, related } = setUp();
    await waitFor(() => expect(hook.result.current.state.kind).toBe('ready'));
    hook.rerender({ path: PLAN });
    await act(async () => {});
    expect(related).toHaveBeenCalledOnce();
  });
});
