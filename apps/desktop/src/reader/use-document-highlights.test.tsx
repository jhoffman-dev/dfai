// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { lineNoteBlocks } from '@dfai/domain/testing';
import {
  createVaultPath,
  literatureNoteText,
  pdfPageText,
  type PdfPageText,
  type VaultPath,
} from '@dfai/domain';
import { fakeIndexPort, fakeMarkdown, fakeVaultFs, type OpenNotes } from '@dfai/application';
import type { PdfJsDocument, PdfJsReader } from '@dfai/adapters/pdf';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import {
  useLiteratureNoteOf,
  usePlacedHighlights,
  useReaderWrites,
  type DocumentPorts,
} from './use-document-highlights.ts';
import { useOpenDocument } from './use-open-document.ts';

/*
 * The reader tab's reads and writes against a vault in memory (#504): the
 * note found for the PDF, a highlight written through the application and
 * read back placed on its page, and a refused write said as a notice.
 */

const VAULT = '/vault';
const PDF = createVaultPath('Library/The Lantern Keepers.pdf');
const NOTE = createVaultPath('Library/The Lantern Keepers.md');

const page = (text: string): PdfPageText =>
  pdfPageText([
    { text, box: { x: 0.1, y: 0.2, width: text.length * 0.01, height: 0.02 }, endsLine: false },
  ]);
const PAGES = [page('A light kept is a promise kept.'), page('Fog came in from the north.')];

const opened = {
  pageCount: PAGES.length,
  pageSize: async () => ({ width: 612, height: 792 }),
  pageText: async (at: number) => PAGES[at - 1] as PdfPageText,
  metadata: async () => ({ title: null, author: null }),
  outline: async () => [],
  close: async () => {},
  drawPage: () => ({ done: Promise.resolve(), cancel: () => {} }),
  pictureOf: async () => new Uint8Array([137, 80, 78, 71]),
} satisfies PdfJsDocument;

function setUp({ dirty = false }: { dirty?: boolean } = {}) {
  const files = new Map<string, string>([
    [
      NOTE,
      literatureNoteText({ kind: 'pdf', title: 'The Lantern Keepers', author: null, file: PDF }),
    ],
  ]);
  const base = fakeMarkdown();
  const openNotes: OpenNotes = {
    state: () => (dirty ? 'dirty' : 'closed'),
    setPropertiesIfOpen: async () => false,
    reload: () => {},
  };
  const ports: DocumentPorts = {
    fs: fakeVaultFs({
      readTextFile: async (path) => ({ text: files.get(path) ?? '', modified: 1 }),
      readNotes: async (paths) =>
        paths.map((path) => ({ path, text: files.get(path) ?? '', modified: 1, size: 1 })),
      writeTextFile: async ({ path, contents }) => {
        files.set(path, contents);
        return 2;
      },
    }),
    markdown: {
      ...base,
      noteBlocks: lineNoteBlocks,
      frontmatterProperties: (frontmatter) =>
        Object.fromEntries(
          Object.entries(base.frontmatterProperties(frontmatter)).map(([key, value]) => [
            key,
            typeof value === 'string' && value.startsWith('"') ? JSON.parse(value) : value,
          ]),
        ),
    },
    index: fakeIndexPort({
      notesOfType: async () => [{ path: NOTE, title: 'The Lantern Keepers' }],
    }),
    openNotes,
    onChanged: vi.fn(),
  };
  return { files, ports };
}

function useTab(ports: DocumentPorts) {
  const note = useLiteratureNoteOf({ ports, vault: VAULT, pdf: PDF }) ?? null;
  const { highlights } = usePlacedHighlights({ ports, vault: VAULT, note, opened, generation: 1 });
  const writes = useReaderWrites({ ports, vault: VAULT, note, pdf: PDF, opened });
  return { note, highlights, ...writes };
}

describe("a reader tab's literature note", () => {
  it('is found for the PDF, takes a highlight, and shows it placed on its page', async () => {
    const { ports, files } = setUp();
    const { result } = renderHook(() => useTab(ports), { wrapper: queryWrapper().wrapper });
    await waitFor(() => expect(result.current.note).toBe(NOTE));
    expect(result.current.highlights).toEqual([]);

    await act(() =>
      result.current.actions.onHighlight({
        selection: { page: 2, start: 0, end: 8 },
        style: { mark: 'highlight', color: 'purple' },
        comment: 'Spring.',
      }),
    );
    expect(files.get(NOTE)).toContain('> Fog came\n> <!-- atlas:highlight');
    expect(ports.onChanged).toHaveBeenCalled();
    await waitFor(() => expect(result.current.highlights).toHaveLength(1));
    expect(result.current.highlights[0]).toMatchObject({
      quote: 'Fog came',
      comment: 'Spring.',
      style: { mark: 'highlight', color: 'purple' },
      placement: { kind: 'words', page: 2 },
    });
    expect(result.current.notice).toBeNull();
  });

  it('says so when the note’s highlights cannot be read, rather than showing none', async () => {
    const { ports } = setUp();
    const unreadable: DocumentPorts = {
      ...ports,
      fs: { ...ports.fs, readTextFile: async () => Promise.reject(new Error('disk gone')) },
    };
    const found = renderHook(
      () => {
        const placed = usePlacedHighlights({
          ports: unreadable,
          vault: VAULT,
          note: NOTE,
          opened,
          generation: 1,
        });
        return placed;
      },
      { wrapper: queryWrapper().wrapper },
    );
    await waitFor(() =>
      expect(found.result.current.notice).toBe('The highlights could not be shown: disk gone'),
    );
    expect(found.result.current.highlights).toEqual([]);
  });

  it('edits and removes a highlight through the note', async () => {
    const { ports, files } = setUp();
    const { result } = renderHook(() => useTab(ports), { wrapper: queryWrapper().wrapper });
    await waitFor(() => expect(result.current.note).toBe(NOTE));
    await act(() =>
      result.current.actions.onHighlight({
        selection: { page: 1, start: 0, end: 7 },
        style: { mark: 'underline', color: 'blue' },
      }),
    );
    await waitFor(() => expect(result.current.highlights).toHaveLength(1));
    const id = result.current.highlights[0]?.id as string;
    await act(() => result.current.actions.onEditComment({ id, comment: 'Kept.' }));
    expect(files.get(NOTE)).toContain('> Kept.\n');
    await act(() => result.current.actions.onRemove(id));
    await waitFor(() => expect(result.current.highlights).toEqual([]));
    expect(files.get(NOTE)).not.toContain('atlas:highlight');
  });

  it('saves an area’s picture and its highlight', async () => {
    const { ports, files } = setUp();
    const written: { path: VaultPath; bytes: Uint8Array }[] = [];
    const fs = {
      ...ports.fs,
      listDirectory: async () => [],
      writeBinaryFile: async ({ path, bytes }: { path: VaultPath; bytes: Uint8Array }) => {
        written.push({ path, bytes });
        return bytes.length;
      },
    };
    const { result } = renderHook(() => useTab({ ...ports, fs }), {
      wrapper: queryWrapper().wrapper,
    });
    await waitFor(() => expect(result.current.note).toBe(NOTE));
    await act(() =>
      result.current.actions.onHighlightArea({
        page: 2,
        box: { x: 0.1, y: 0.1, width: 0.3, height: 0.2 },
        style: { mark: 'highlight', color: 'yellow' },
      }),
    );
    expect(written.map((file) => file.path)).toEqual([
      'attachments/The Lantern Keepers p2 area.png',
    ]);
    expect(files.get(NOTE)).toContain('> ![[attachments/The Lantern Keepers p2 area.png]]');
  });

  it('says why a write was refused, and writes nothing', async () => {
    const { ports, files } = setUp({ dirty: true });
    const before = files.get(NOTE);
    const { result } = renderHook(() => useTab(ports), { wrapper: queryWrapper().wrapper });
    await waitFor(() => expect(result.current.note).toBe(NOTE));
    await act(() =>
      result.current.actions.onHighlight({
        selection: { page: 1, start: 0, end: 7 },
        style: { mark: 'highlight', color: 'yellow' },
      }),
    );
    expect(result.current.notice).toMatch(/unsaved/i);
    expect(files.get(NOTE)).toBe(before);
  });

  it('finds a phrase on every page', async () => {
    const { ports } = setUp();
    const { result } = renderHook(() => useTab(ports), { wrapper: queryWrapper().wrapper });
    const found = await result.current.actions.onSearch('kept');
    expect(found.matches.map((match) => [match.page, match.start])).toEqual([
      [1, 8],
      [1, 26],
    ]);
  });
});

describe('the PDF a reader tab opens', () => {
  it('is opened from the vault’s bytes and closed when the tab goes', async () => {
    const close = vi.fn(async () => {});
    const reader: PdfJsReader = { open: async () => ({ ...opened, close }) };
    const fs = fakeVaultFs({ readBinaryFile: async () => new ArrayBuffer(8) });
    const { result, unmount } = renderHook(() => useOpenDocument({ fs, reader, path: PDF }));
    expect(result.current.state).toBe('opening');
    await waitFor(() => expect(result.current.state).toBe('open'));
    unmount();
    expect(close).toHaveBeenCalled();
  });

  it('says the file could not be opened, and why', async () => {
    const reader: PdfJsReader = {
      open: async () => {
        throw new Error('it is damaged');
      },
    };
    const fs = fakeVaultFs({ readBinaryFile: async () => new ArrayBuffer(8) });
    const { result } = renderHook(() => useOpenDocument({ fs, reader, path: PDF }));
    await waitFor(() =>
      expect(result.current).toEqual({
        state: 'failed',
        message: 'Library/The Lantern Keepers.pdf could not be opened: it is damaged',
      }),
    );
  });
});
