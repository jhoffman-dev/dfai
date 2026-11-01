// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createVaultPath, pageThumbnailPath, parseObjectType, type VaultPath } from '@dfai/domain';
import { fakeVaultFs } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import type { PaneEditors } from '../panes/open-editors.ts';
import { thumbnailWroteVault, useThumbnailQueue } from './use-thumbnails.ts';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const DUNE = createVaultPath('Books/Dune.md');
const BOOK = {
  ...parseObjectType({ name: 'book', properties: { art: 'thumbnail' } }),
  path: createVaultPath('.atlas/types/book.md'),
};

/** Panes that all say the same of every note: none open, open and saved, or holding unsaved edits. */
function panesSaying(state: 'closed' | 'clean' | 'dirty'): PaneEditors {
  return {
    register: () => {},
    setPropertiesIfOpen: async () => false,
    savePane: () => {},
    reloadOthers: () => {},
    flushAll: async () => {},
    stateOf: () => state,
    flushHolding: async () => {},
    follow: () => {},
    abandon: () => {},
    dirtyPaths: () => [],
  };
}

function queueOver({ note, panes }: { note: string; panes: 'closed' | 'clean' | 'dirty' }) {
  const text = new Map<string, string>([[DUNE, note]]);
  let modified = 1;
  const fs = fakeVaultFs({
    readTextFile: async (path) => {
      const found = text.get(path);
      if (found === undefined) throw new Error(`no such note: ${path}`);
      return { text: found, modified };
    },
    writeTextFile: async ({ path, contents }) => {
      text.set(path, contents);
      return (modified += 1);
    },
  });
  const capture = vi.fn(async () => PNG);
  const onChanged = vi.fn();
  const hook = renderHook(() =>
    useThumbnailQueue({
      notes: { fs, markdown: remarkMarkdown },
      snapshot: { capture },
      editors: panesSaying(panes),
      types: [BOOK],
      onChanged,
    }),
  );
  return { queue: hook.result.current, capture, onChanged, text };
}

describe('useThumbnailQueue, while a pane holds unsaved edits', () => {
  it('leaves a page being typed in alone, unasked', async () => {
    const { queue, capture } = queueOver({ note: '---\ntype: book\n---\nDraft\n', panes: 'dirty' });
    await expect(queue.request({ path: DUNE, asked: false })).resolves.toEqual({ kind: 'kept' });
    expect(capture).not.toHaveBeenCalled();
  });

  it("still pictures an artifact, whose picture is of its copy and not the note's edits", async () => {
    const { queue } = queueOver({ note: '---\ntype: artifact\n---\n', panes: 'dirty' });
    // Refused by the artifact rule, so it was not stopped for the note's edits.
    await expect(queue.requestOrFail({ path: DUNE, asked: false })).rejects.toThrow(
      'There is no saved copy to picture',
    );
  });
});

describe('useThumbnailQueue, re-reading the tree and the index', () => {
  it('does not, for a picture of a page: it is kept in the cache, which neither shows', async () => {
    const { queue, onChanged } = queueOver({ note: '---\ntype: book\n---\nA\n', panes: 'closed' });
    await expect(queue.request({ path: DUNE, asked: false })).resolves.toMatchObject({
      kind: 'made',
    });
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('does, when Regenerate put the note back to auto', async () => {
    const { queue, onChanged, text } = queueOver({
      note: '---\ntype: book\nart: false\n---\nA\n',
      panes: 'closed',
    });
    await queue.request({ path: DUNE, asked: true });
    expect(text.get(DUNE)).toContain('art: auto');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});

describe('thumbnailWroteVault', () => {
  const made = (path: VaultPath) => ({ kind: 'made', path, cover: '' }) as const;

  it("is an artifact's picture, kept in its copy, or a note written", () => {
    const artifact = createVaultPath('artifacts/q3/atlas-thumbnail.png');
    expect(thumbnailWroteVault({ result: made(artifact), wroteNote: false })).toBe(true);
    expect(thumbnailWroteVault({ result: made(pageThumbnailPath(DUNE)), wroteNote: true })).toBe(
      true,
    );
  });

  it('is not a picture of a page alone, nor nothing made', () => {
    expect(thumbnailWroteVault({ result: made(pageThumbnailPath(DUNE)), wroteNote: false })).toBe(
      false,
    );
    expect(thumbnailWroteVault({ result: { kind: 'kept' }, wroteNote: false })).toBe(false);
  });
});
