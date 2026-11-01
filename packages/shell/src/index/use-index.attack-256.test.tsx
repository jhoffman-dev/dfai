// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createVaultPath } from '@dfai/domain';
import {
  createNoteChanges,
  createOwnWrites,
  fakeIndexPort,
  fakeMarkdown,
  fakeVaultFs,
  recordingActivity,
  type IndexEntry,
} from '@dfai/application';
import { useIndex, type IndexPorts } from './use-index.ts';

/**
 * Attack on PR #256 (#254): a sync vouches, through `ownWrites.refreshed`,
 * that the index holds every write recorded before it began, and the echo of
 * such a write is then dropped. The vouch must be true of the notes it names.
 */

const VAULT = '/vaults/Larkspur';
const PLAN = 'Plan.md';

/** One note on a disk, over an index that keeps what it is given, with reads that can fail. */
function aVaultWithOneNote() {
  const disk = { text: '# Plan\n', modified: 1, unreadable: false };
  const held = new Map<string, IndexEntry>();
  const ports: IndexPorts = {
    fs: fakeVaultFs({
      listNotes: async () => [
        {
          name: PLAN,
          path: createVaultPath(PLAN),
          modified: disk.modified,
          size: disk.text.length,
        },
      ],
      // The host leaves out a note it could not read, as `read_notes_at` does.
      readNotes: async (paths) =>
        disk.unreadable
          ? []
          : paths.map((path) => ({
              path,
              text: disk.text,
              modified: disk.modified,
              size: disk.text.length,
            })),
    }),
    index: fakeIndexPort({
      manifest: async () => [...held.values()],
      put: async (notes) => {
        for (const note of notes) {
          held.set(note.path, {
            ...note,
            path: note.path,
            modified: note.modified,
            size: note.size,
          });
        }
      },
      stats: async () => ({ notes: held.size, properties: 0, links: 0 }),
    }),
    markdown: fakeMarkdown(),
  };
  return { disk, held, ports };
}

describe('attack #256: what a sync vouches for', () => {
  it('does not vouch for a write whose note the sync could not read', async () => {
    const { disk, held, ports } = aVaultWithOneNote();
    const ownWrites = createOwnWrites({ clock: { now: () => 0 } });
    const { result } = renderHook(() =>
      useIndex({
        ports,
        vaultKey: VAULT,
        activity: recordingActivity(),
        changes: createNoteChanges({ onError: () => {} }),
        ownWrites,
      }),
    );
    await waitFor(() => expect(result.current.status.kind).toBe('ready'));
    expect(held.get(PLAN)?.modified).toBe(1);

    // The app saves; the sync after it finds the note held by another program for a moment.
    disk.text = '# Plan\n\nSaved by the app.\n';
    disk.modified = 2;
    ownWrites.record({
      vault: VAULT,
      path: PLAN,
      left: { kind: 'text', text: disk.text, modified: disk.modified },
    });
    disk.unreadable = true;
    await act(async () => {
      await result.current.refresh();
    });
    disk.unreadable = false;

    // The index still holds the old version, so the save's echo must not be dropped.
    expect(held.get(PLAN)?.modified).toBe(1);
    expect(ownWrites.refreshedAt({ vault: VAULT, path: PLAN })).toBeNull();
  });
});
