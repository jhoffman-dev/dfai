// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { lineNoteBlocks } from '@dfai/domain/testing';
import { createVaultPath, literatureNoteText } from '@dfai/domain';
import { fakeIndexPort, fakeMarkdown, fakeVaultFs, type OpenNotes } from '@dfai/application';
import type { FoliateBook } from '@dfai/adapters/epub';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import { useBookWrites, usePlacedBookHighlights } from './use-book-highlights.ts';
import { useLiteratureNoteOf, type DocumentPorts } from './use-document-highlights.ts';

/*
 * The book reader tab's reads and writes against a vault in memory (#505):
 * the note found for the EPUB, a highlight written through the application
 * with its CFI and read back placed where it points, find in the book, and
 * a refused write said as a notice.
 */

const VAULT = '/vault';
const BOOK = createVaultPath('Library/fables.epub');
const NOTE = createVaultPath('Library/Fables of Brightwater.md');
const CHAPTERS = [
  'A Hare one day ridiculed the Tortoise.',
  'When the winter came, the Grasshopper starved.',
];

/** A book whose CFIs are `epubcfi(/6/<2(n+1)>!/<start>:<end>)`, as the application's fake makes them. */
const book = {
  sectionCount: CHAPTERS.length,
  metadata: { title: 'Fables of Brightwater', author: null },
  contents: [],
  sectionText: async (section: number) => CHAPTERS[section] ?? '',
  cfiOf: async ({ section, start, end }: { section: number; start: number; end: number }) =>
    `epubcfi(/6/${(section + 1) * 2}!/${start}:${end})`,
  placeOfCfi: async (cfi: string) => {
    const found = /^epubcfi\(\/6\/(\d+)!\/(\d+):(\d+)\)$/.exec(cfi);
    if (found === null) return null;
    const section = Number(found[1]) / 2 - 1;
    return { section, range: { section, start: Number(found[2]), end: Number(found[3]) } };
  },
  sectionOfPath: () => null,
  show: async () => {
    throw new Error('not shown in this test');
  },
  close: () => {},
} satisfies FoliateBook;

function setUp({ dirty = false }: { dirty?: boolean } = {}) {
  const files = new Map<string, string>([
    [
      NOTE,
      literatureNoteText({
        kind: 'epub',
        title: 'Fables of Brightwater',
        author: null,
        file: BOOK,
      }),
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
      notesOfType: async () => [{ path: NOTE, title: 'Fables of Brightwater' }],
    }),
    openNotes,
    onChanged: vi.fn(),
  };
  return { files, ports };
}

function useTab(ports: DocumentPorts) {
  const note = useLiteratureNoteOf({ ports, vault: VAULT, pdf: BOOK }) ?? null;
  const placed = usePlacedBookHighlights({ ports, vault: VAULT, note, book, generation: 1 });
  const writes = useBookWrites({ ports, vault: VAULT, note, book });
  return { note, ...placed, ...writes, placedNotice: placed.notice };
}

describe("a book reader tab's literature note", () => {
  it('is found for the EPUB, takes a highlight with its CFI, and shows it where the CFI points', async () => {
    const { ports, files } = setUp();
    const { result } = renderHook(() => useTab(ports), { wrapper: queryWrapper().wrapper });
    await waitFor(() => expect(result.current.note).toBe(NOTE));
    expect(result.current.highlights).toEqual([]);

    const start = (CHAPTERS[1] as string).indexOf('the Grasshopper');
    await act(() =>
      result.current.actions.onHighlight({
        selection: { section: 1, start, end: start + 15 },
        style: { mark: 'highlight', color: 'blue' },
        comment: 'Too late.',
      }),
    );
    expect(files.get(NOTE)).toContain('> the Grasshopper\n> <!-- atlas:highlight');
    expect(files.get(NOTE)).toContain(`"cfi":"epubcfi(/6/4!/${start}:${start + 15})"`);
    expect(ports.onChanged).toHaveBeenCalled();
    await waitFor(() => expect(result.current.highlights).toHaveLength(1));
    expect(result.current.highlights[0]).toMatchObject({
      quote: 'the Grasshopper',
      comment: 'Too late.',
      placement: { kind: 'cfi', range: { section: 1, start, end: start + 15 } },
    });
    expect(result.current.ids).toHaveLength(1);
  });

  it('edits and removes a highlight through the note', async () => {
    const { ports, files } = setUp();
    const before = files.get(NOTE);
    const { result } = renderHook(() => useTab(ports), { wrapper: queryWrapper().wrapper });
    await waitFor(() => expect(result.current.note).toBe(NOTE));
    await act(() =>
      result.current.actions.onHighlight({
        selection: { section: 0, start: 0, end: 6 },
        style: { mark: 'underline', color: 'yellow' },
      }),
    );
    await waitFor(() => expect(result.current.highlights).toHaveLength(1));
    const id = result.current.highlights[0]?.id as string;
    await act(() => result.current.actions.onEditComment({ id, comment: 'Who laughs last.' }));
    expect(files.get(NOTE)).toContain('> Who laughs last.');
    await act(() => result.current.actions.onRemove(id));
    expect(files.get(NOTE)).toBe(before);
  });

  it('finds a phrase in every chapter', async () => {
    const { ports } = setUp();
    const { result } = renderHook(() => useTab(ports), { wrapper: queryWrapper().wrapper });
    const found = await result.current.actions.onSearch('the');
    expect(found.matches.map((match) => match.section)).toEqual([0, 1, 1]);
  });

  it('says a write the note refused, and takes nothing', async () => {
    const { ports, files } = setUp({ dirty: true });
    const before = files.get(NOTE);
    const { result } = renderHook(() => useTab(ports), { wrapper: queryWrapper().wrapper });
    await waitFor(() => expect(result.current.note).toBe(NOTE));
    let taken = true;
    await act(async () => {
      taken = await result.current.actions.onHighlight({
        selection: { section: 0, start: 0, end: 6 },
        style: { mark: 'highlight', color: 'yellow' },
      });
    });
    expect(taken).toBe(false);
    expect(result.current.notice).toMatch(/unsaved/i);
    expect(files.get(NOTE)).toBe(before);
  });
});
