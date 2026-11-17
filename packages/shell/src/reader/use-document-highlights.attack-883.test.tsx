// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { lineNoteBlocks } from '@dfai/domain/testing';
import { createVaultPath, literatureNoteText, pdfPageText, type PdfPageText } from '@dfai/domain';
import { fakeIndexPort, fakeMarkdown, fakeVaultFs, type OpenNotes } from '@dfai/application';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import {
  useLiteratureNoteOf,
  usePlacedHighlights,
  useReaderWrites,
  type DocumentPorts,
} from './use-document-highlights.ts';
import type { PdfJsDocument } from '@dfai/adapters/pdf';

/*
 * Attack on #883: what a reader tab's writes do while queued behind each other.
 */

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
function useTab(ports: DocumentPorts, doc: PdfJsDocument, vault: string) {
  const note = useLiteratureNoteOf({ ports, vault, pdf: PDF }) ?? null;
  const { highlights } = usePlacedHighlights({ ports, vault, note, opened: doc, generation: 1 });
  const writes = useReaderWrites({ ports, vault, note, pdf: PDF, opened: doc });
  return { note, highlights, ...writes };
}

async function withTwoHighlights(vault: string, doc: PdfJsDocument = opened) {
  const { ports, files } = setUp();
  const rendered = renderHook(() => useTab(ports, doc, vault), {
    wrapper: queryWrapper().wrapper,
  });
  const { result } = rendered;
  await waitFor(() => expect(result.current.note).toBe(NOTE));
  for (const at of [1, 2]) {
    await act(() =>
      result.current.actions.onHighlight({
        selection: { page: at, start: 0, end: 7 },
        style: { mark: 'highlight', color: 'yellow' },
      }),
    );
  }
  await waitFor(() => expect(result.current.highlights).toHaveLength(2));
  const ids = result.current.highlights.map((highlight) => highlight.id);
  return { ports, files, result, ids, rendered };
}

describe('attack #883: a reader tab’s queued writes', () => {
  it('a removal does not wait on a new highlight’s page text, which reads no note', async () => {
    let stuck = false;
    const slowPages: PdfJsDocument = {
      ...opened,
      // Once stuck, page text never answers (a page pdf.js never finishes extracting).
      pageText: (at: number) =>
        stuck ? new Promise<PdfPageText>(() => {}) : Promise.resolve(PAGES[at - 1] as PdfPageText),
    };
    const { files, result, ids } = await withTwoHighlights('/vault-slow-page', slowPages);
    stuck = true;
    act(() => {
      void result.current.actions.onHighlight({
        selection: { page: 1, start: 8, end: 13 },
        style: { mark: 'highlight', color: 'blue' },
      });
    });
    let removed: boolean | 'pending' = 'pending';
    act(() => {
      void result.current.actions.onRemove(ids[0] as string).then((answer) => (removed = answer));
    });
    await waitFor(() => expect(removed).toBe(true), { timeout: 500 });
    expect(files.get(NOTE)).not.toContain(`^${ids[0]}`);
  });

  it('a second removal of a highlight, queued behind its first, raises no notice: it is gone', async () => {
    const { files, result, ids } = await withTwoHighlights('/vault-twice');
    let removals: Promise<boolean[]> = Promise.resolve([]);
    act(() => {
      removals = Promise.all([
        result.current.actions.onRemove(ids[0] as string),
        result.current.actions.onRemove(ids[0] as string),
      ]);
    });
    await act(async () => void (await removals));
    expect(files.get(NOTE)).not.toContain(`^${ids[0]}`);
    expect(result.current.notice).toBeNull();
  });

  it('queued removals from a tab closed meanwhile all land and answer', async () => {
    const { files, result, ids, rendered } = await withTwoHighlights('/vault-closed');
    let removals: Promise<boolean[]> = Promise.resolve([]);
    act(() => {
      removals = Promise.all(ids.map((id) => result.current.actions.onRemove(id)));
    });
    rendered.unmount();
    await expect(removals).resolves.toEqual([true, true]);
    expect(files.get(NOTE)).not.toContain('atlas:highlight');
  });
});
