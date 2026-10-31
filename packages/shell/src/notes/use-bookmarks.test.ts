// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createVaultPath, pageThumbnailPath } from '@dfai/domain';
import {
  fakeIndexPort,
  fakeMarkdown,
  fakeVaultFs,
  type IndexPort,
  type MarkdownPort,
} from '@dfai/application';
import { useBookmarks } from './use-bookmarks.ts';

/** A body is read as one paragraph holding its text. */
const markdown: MarkdownPort = {
  ...fakeMarkdown(),
  parseBody: (body) => ({
    blocks: [],
    doc: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: body.trim() }] }],
    },
  }),
};

const rome = createVaultPath('Trips/Rome.md');
const link = { target: 'Rome', heading: null, alias: null };

/** A vault holding the note and the picture files named; any other file cannot be read. */
function vaultWith(noteText: string, pictures: readonly string[]) {
  const readBinaryFile = vi.fn(async (path: string) => {
    if (!pictures.includes(path)) throw new Error(`No such file: ${path}`);
    return new TextEncoder().encode(path).buffer;
  });
  const fs = fakeVaultFs({
    readNotes: async () => [{ path: rome, text: noteText, modified: 1, size: noteText.length }],
    readBinaryFile,
  });
  return { fs, readBinaryFile };
}

function bookmarksOver(
  fs: ReturnType<typeof fakeVaultFs>,
  index: IndexPort = fakeIndexPort({
    manifest: async () => [{ path: rome, modified: 1, size: 1, digest: '', type: null }],
  }),
) {
  return renderHook(() =>
    useBookmarks({
      fs,
      markdown,
      index,
      notePath: createVaultPath('Plans.md'),
      notePaths: [rome],
      types: [],
      revision: 'r1',
    }),
  ).result;
}

afterEach(() => vi.unstubAllGlobals());

describe('useBookmarks', () => {
  it('draws a card from the linked note, with the first of its pictures that loads', async () => {
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => 'blob:cover',
      revokeObjectURL: () => {},
    });
    const { fs, readBinaryFile } = vaultWith(
      '---\nthumbnail: auto\ncover: art/rome.png\ndescription: Ten days.\n---\nBody\n',
      ['Trips/art/rome.png'],
    );
    const result = bookmarksOver(fs);

    expect(await result.current.load(link)).toEqual({
      kind: 'note',
      title: 'Rome',
      summary: 'Ten days.',
      place: 'Trips',
      archived: false,
      picture: 'blob:cover',
    });
    // The picture of the page is tried first, then the cover, each from the linked note.
    const tried = readBinaryFile.mock.calls.map(([path]) => path);
    expect(tried[0]).toContain(pageThumbnailPath(rome).split('/').at(-1));
    expect(tried.at(-1)).toBe('Trips/art/rome.png');
    expect(result.current.revision).toBe('r1');
  });

  it('draws the icon when none of the pictures is there', async () => {
    const { fs } = vaultWith('---\ncover: gone.png\n---\nBody\n', []);
    const card = await bookmarksOver(fs).current.load(link);
    expect(card).toMatchObject({ kind: 'note', picture: null, summary: 'Body' });
  });

  it('says a link to no note is missing', async () => {
    const { fs } = vaultWith('Body\n', []);
    const card = await bookmarksOver(fs).current.load({ ...link, target: 'Paris' });
    expect(card).toEqual({ kind: 'missing', label: 'Paris' });
  });
});

describe('useBookmarks, as notes are saved (A22-01)', () => {
  /** Blob URLs made and let go, by name. */
  function blobs() {
    let made = 0;
    const revoked: string[] = [];
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => `blob:${(made += 1)}`,
      revokeObjectURL: (url: string) => revoked.push(url),
    });
    return { made: () => made, revoked };
  }

  function vault() {
    const state = { modified: 1, text: '---\ncover: rome.png\n---\nBody\n' };
    const readNotes = vi.fn(async (paths: readonly string[]) =>
      paths.map((path) => ({ path, text: state.text, modified: state.modified, size: 1 })),
    );
    const fs = fakeVaultFs({
      readNotes,
      readBinaryFile: async (path) => {
        if (path !== 'Trips/rome.png') throw new Error(`No such file: ${path}`);
        return new ArrayBuffer(1);
      },
    });
    const index = fakeIndexPort({
      manifest: async () => [
        { path: rome, modified: state.modified, size: 1, digest: '', type: null },
      ],
    });
    return { fs, index, readNotes, state };
  }

  function hookOver({ fs, index }: ReturnType<typeof vault>) {
    return renderHook(
      ({ revision }) =>
        useBookmarks({
          fs,
          markdown,
          index,
          notePath: createVaultPath('Plans.md'),
          notePaths: [rome],
          types: [],
          revision,
        }),
      { initialProps: { revision: 'r1' } },
    );
  }

  it('reads the cards asked for together in one read', async () => {
    blobs();
    const files = vault();
    const { result } = hookOver(files);
    const cards = await Promise.all([
      result.current.load(link),
      result.current.load({ ...link, alias: 'the city' }),
    ]);
    expect(cards.map((card) => card.kind)).toEqual(['note', 'note']);
    expect(files.readNotes).toHaveBeenCalledTimes(1);
  });

  it('keeps a card, and its picture, while the note it opens is unchanged', async () => {
    const urls = blobs();
    const files = vault();
    const { result, rerender } = hookOver(files);
    const first = await result.current.load(link);
    expect(first).toMatchObject({ picture: 'blob:1' });

    // Another note — this one, say — was saved.
    rerender({ revision: 'r2' });
    const second = await result.current.load(link);
    expect(second).toBe(first);
    expect(files.readNotes).toHaveBeenCalledTimes(1);
    expect(urls.made()).toBe(1);
    expect(urls.revoked).toEqual([]);
  });

  it('reads a card again when its note changed, letting its old picture go', async () => {
    const urls = blobs();
    const files = vault();
    const { result, rerender, unmount } = hookOver(files);
    await result.current.load(link);

    files.state.modified = 2;
    files.state.text = '---\ncover: rome.png\n---\nRewritten\n';
    rerender({ revision: 'r2' });
    const again = await result.current.load(link);
    expect(again).toMatchObject({ summary: 'Rewritten', picture: 'blob:2' });
    expect(urls.revoked).toEqual(['blob:1']);

    // Closing the note lets go of the rest.
    unmount();
    expect(urls.revoked).toContain('blob:2');
  });
});
