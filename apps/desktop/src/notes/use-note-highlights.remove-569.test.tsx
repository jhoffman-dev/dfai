// @vitest-environment jsdom
/**
 * A block's Delete on a highlight (#569) goes through the literature note's
 * own write, `removeHighlight`: the pane's typing written first, a Kindle
 * highlight leaving its tombstone in the note (ADR-0043 §5), and a write
 * that cannot land told of in a toast rather than lost.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import {
  appendHighlights,
  createVaultPath,
  literatureNoteText,
  readHighlights,
} from '@dfai/domain';
import { fakeVaultFs, openNote, type OpenNote, type OpenNotes } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { useNoteHighlights } from './use-note-highlights.ts';

const noteBlocks = (text: string) => remarkMarkdown.noteBlocks(text);
const BOOK = createVaultPath('Library/Brightwater.md');

/** A fixed random source: the same ids on every run. */
function drawn(): () => number {
  let at = 0;
  return () => ((at++ * 7 + 3) % 36) / 36;
}

const TEXT = appendHighlights({
  text: literatureNoteText({
    kind: 'kindle',
    title: 'Brightwater',
    author: 'Tobias Fenn',
    asin: 'B0EXAMPLE1',
    file: null,
  }),
  highlights: [
    {
      quote: 'The tide keeps its own hours.',
      anchor: { kind: 'kindle', location: { start: 41, end: 44 }, annotationId: 'A1' },
      comment: 'Lit by Mara.',
    },
  ],
  random: drawn(),
  noteBlocks,
}).text;
const ID = readHighlights(TEXT, noteBlocks)[0]?.id ?? '';

const openNotes = {
  state: () => 'clean',
  setPropertiesIfOpen: async () => false,
  reload: () => {},
} as unknown as OpenNotes;

async function removing({ refuseWrite = false }: { refuseWrite?: boolean } = {}) {
  const files = new Map([[BOOK as string, { text: TEXT, modified: 1 }]]);
  const fs = fakeVaultFs({
    readTextFile: async (path) => ({ ...files.get(path)! }),
    writeTextFile: async ({ path, contents }) => {
      if (refuseWrite) throw new Error('the disk is full');
      files.set(path, { text: contents, modified: 2 });
      return 2;
    },
  });
  const open: OpenNote = await openNote({ fs, markdown: remarkMarkdown, path: BOOK });
  const order: string[] = [];
  const flush = vi.fn(async () => {
    order.push('flush');
  });
  const onChanged = vi.fn(() => order.push('changed'));
  const show = vi.fn(() => 0);
  const hook = renderHook(() =>
    useNoteHighlights({
      fs,
      markdown: remarkMarkdown,
      openNotes,
      flush,
      path: BOOK,
      open,
      onChanged,
      toasts: { show },
    }),
  );
  return { files, hook, order, onChanged, show };
}

describe("a highlight's Delete from its block's menu", () => {
  it('starts from a note holding the highlight (the premise)', () => {
    expect(ID).not.toBe('');
    expect(TEXT).toContain('The tide keeps its own hours.');
  });

  it("removes it by the note's own write, which leaves the Kindle highlight's tombstone", async () => {
    const { files, hook, order } = await removing();
    hook.result.current?.removeHighlight?.(ID);
    await waitFor(() => expect(order).toEqual(['flush', 'changed']));
    const written = files.get(BOOK)?.text ?? '';
    expect(written).not.toContain('The tide keeps its own hours.');
    expect(written).toContain('atlas:highlight-removed');
  });

  it('tells the person in a toast when the write is refused, and reads nothing again', async () => {
    const { hook, onChanged, show } = await removing({ refuseWrite: true });
    hook.result.current?.removeHighlight?.(ID);
    await waitFor(() => expect(show).toHaveBeenCalledTimes(1));
    expect(show).toHaveBeenCalledWith({
      message: 'The highlight could not be deleted: the disk is full',
      tone: 'error',
    });
    expect(onChanged).not.toHaveBeenCalled();
  });
});
