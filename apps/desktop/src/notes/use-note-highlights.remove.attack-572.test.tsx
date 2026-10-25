// @vitest-environment jsdom
/**
 * Attack on PR #572 (#569): two highlights deleted from their blocks' menus
 * in quick succession. Each Delete is the note's own write against the text
 * it just read; the file system refuses a write whose expected text is no
 * longer on disk, as the real one does. Both deletes are the person's word,
 * so both land, each leaving its Kindle tombstone. Fictional data only.
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
    },
    {
      quote: 'Larkspur grows by the harbour wall.',
      anchor: { kind: 'kindle', location: { start: 90, end: 93 }, annotationId: 'A2' },
    },
  ],
  random: drawn(),
  noteBlocks,
}).text;
const IDS = readHighlights(TEXT, noteBlocks).map((block) => block.id);

const openNotes = {
  state: () => 'clean',
  setPropertiesIfOpen: async () => false,
  reload: () => {},
} as unknown as OpenNotes;

describe('two highlights deleted one straight after the other', () => {
  it('starts from a note holding both (the premise)', () => {
    expect(IDS).toHaveLength(2);
  });

  it('removes both, each leaving its tombstone, and tells of no failure', async () => {
    const files = new Map([[BOOK as string, { text: TEXT, modified: 1 }]]);
    const fs = fakeVaultFs({
      readTextFile: async (path) => ({ ...files.get(path)! }),
      writeTextFile: async ({ path, contents, expectedText }) => {
        const now = files.get(path)!;
        // As the host's write: refused when the file is not the text it was read as.
        if (expectedText !== undefined && expectedText !== now.text) {
          throw new Error('The note changed on disk.');
        }
        files.set(path, { text: contents, modified: now.modified + 1 });
        return now.modified + 1;
      },
    });
    const open: OpenNote = await openNote({ fs, markdown: remarkMarkdown, path: BOOK });
    const onChanged = vi.fn();
    const show = vi.fn(() => 0);
    const hook = renderHook(() =>
      useNoteHighlights({
        fs,
        markdown: remarkMarkdown,
        openNotes,
        flush: async () => {},
        path: BOOK,
        open,
        onChanged,
        toasts: { show },
      }),
    );
    hook.result.current?.removeHighlight?.(IDS[0]!);
    hook.result.current?.removeHighlight?.(IDS[1]!);
    await waitFor(() => expect(onChanged.mock.calls.length + show.mock.calls.length).toBe(2));
    const written = files.get(BOOK)?.text ?? '';
    expect(show).not.toHaveBeenCalled();
    expect(readHighlights(written, noteBlocks)).toEqual([]);
    expect(written.match(/atlas:highlight-removed/g)).toHaveLength(2);
  });
});
