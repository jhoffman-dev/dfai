// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createVaultPath } from '@dfai/domain';
import {
  createNoteChanges,
  fakeIndexPort,
  fakeMarkdown,
  fakeVaultFs,
  INDEX_BATCH_SIZE,
  recordingActivity,
} from '@dfai/application';
import { useIndex, type IndexPorts } from './use-index.ts';

const LARKSPUR = '/vaults/Larkspur';
const QUILL = '/vaults/Quill';

/** Something a test holds shut and lets go of. */
function gate() {
  let open = () => {};
  const shut = new Promise<void>((resolve) => (open = resolve));
  return { shut, open };
}

/**
 * A vault of this many notes over an index that holds none, whose every
 * write to the index waits on the gate a test put in its way: `gates[n]`
 * holds the n-th write.
 */
function heldVault(count: number, gates: Record<number, Promise<void>>) {
  const paths = Array.from({ length: count }, (_, n) => `Note ${n}.md`);
  let puts = 0;
  const ports: IndexPorts = {
    fs: fakeVaultFs({
      listNotes: async () =>
        paths.map((path) => ({ name: path, path: createVaultPath(path), modified: 1, size: 4 })),
      readNotes: async (wanted) =>
        wanted.map((path) => ({ path, text: 'note', modified: 1, size: 4 })),
    }),
    index: fakeIndexPort({
      put: async () => {
        puts += 1;
        await gates[puts];
      },
      stats: async () => ({ notes: count, properties: 0, links: 0 }),
    }),
    markdown: fakeMarkdown(),
  };
  return { ports, puts: () => puts };
}

describe('useIndex, attacked (#135)', () => {
  it('says it is working for as long as a sync it was asked for is still writing', async () => {
    const first = gate();
    const second = gate();
    // Two batches a sync: the first sync writes 1 and 2, the refresh behind it 3 and 4.
    const { ports, puts } = heldVault(INDEX_BATCH_SIZE * 2, { 1: first.shut, 4: second.shut });
    const activity = recordingActivity();
    const changes = createNoteChanges({ onError: () => {} });
    const { result } = renderHook(() => useIndex({ ports, vaultKey: LARKSPUR, activity, changes }));
    await waitFor(() => expect(puts()).toBe(1));

    // A change on disk while the vault is first indexed: the watcher asks for a refresh.
    let refreshed: Promise<unknown> = Promise.resolve();
    act(() => {
      refreshed = result.current.refresh();
    });
    first.open();
    // The first build is over; the refresh behind it has written one batch and is
    // writing its second. (Before #138 its first batch put the status back to working.)
    await waitFor(() => expect(puts()).toBe(4));
    await act(async () => {
      await Promise.resolve();
    });

    // The index is being written to: whatever reads it on "ready" reads it half written.
    expect(result.current.status.kind).toBe('working');

    second.open();
    await act(() => refreshed);
    expect(result.current.status.kind).toBe('ready');
  });

  it('does not show one vault how far the last vault got', async () => {
    const second = gate();
    const { ports } = heldVault(INDEX_BATCH_SIZE * 2, { 2: second.shut });
    const activity = recordingActivity();
    const changes = createNoteChanges({ onError: () => {} });
    const { result, rerender } = renderHook(
      ({ vaultKey }: { vaultKey: string }) => useIndex({ ports, vaultKey, activity, changes }),
      { initialProps: { vaultKey: LARKSPUR } },
    );
    const halfway = { done: INDEX_BATCH_SIZE, total: INDEX_BATCH_SIZE * 2 };
    await waitFor(() => expect(result.current.progress.current()).toEqual(halfway));

    // The vault is switched while the first is half indexed.
    rerender({ vaultKey: QUILL });

    // The window says "working" for the new vault, whose build has not begun:
    // the count beside it is the old vault's ("Indexing 50 of 100…").
    expect(result.current.status.kind).toBe('working');
    expect(result.current.progress.current()).toEqual({ done: 0, total: 0 });

    second.open();
    await waitFor(() => expect(result.current.status.kind).toBe('ready'));
  });
});
