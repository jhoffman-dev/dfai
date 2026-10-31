// @vitest-environment jsdom
/**
 * Adversarial (P30-01): what the Inbox offers to file a note under. Every
 * choice it offers must be one Process accepts — a project or an area still
 * in use, not one waiting in the Inbox itself, whose pick is only refused.
 */
import { describe, expect, it } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import {
  fakeIndexPort,
  fakeMarkdown,
  fakeVaultFs,
  recordingActivity,
  type ArchivePorts,
} from '@dfai/application';
import { useInbox } from './use-inbox.ts';

function ports(): ArchivePorts {
  return {
    fs: fakeVaultFs(),
    markdown: fakeMarkdown(),
    index: fakeIndexPort({
      query: async () => ({ columns: ['path', 'title', 'type'], rows: [], truncated: false }),
      notesOfType: async (type: string) =>
        type === 'project'
          ? [
              { path: 'Projects/Larkspur.md', title: 'Larkspur' },
              // Captured as a project, still waiting to be processed itself.
              { path: 'Inbox/Hedge maze.md', title: 'Hedge maze' },
            ]
          : [],
    }),
    editors: {
      state: () => 'closed',
      flush: async () => {},
      follow: () => {},
      abandon: () => {},
      reload: () => {},
    },
  };
}

describe('useInbox — what it offers to file under', () => {
  it('does not offer a project that is itself still in the Inbox', async () => {
    const stable = ports();
    const activity = recordingActivity();
    const { result } = renderHook(() =>
      useInbox({
        ports: stable,
        notePaths: [],
        vaultKey: '/vaults/a',
        types: [],
        clock: { today: () => '2026-10-11' },
        indexKey: '1',
        open: true,
        onSettled: () => {},
        activity,
        closing: { beforeClose: async () => () => {} },
      }),
    );

    await waitFor(() => expect(result.current.filing.length).toBeGreaterThan(0));
    expect(result.current.filing.map((choice) => choice.path)).toEqual(['Projects/Larkspur.md']);
  });
});
