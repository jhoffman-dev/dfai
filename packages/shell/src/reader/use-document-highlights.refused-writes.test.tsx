// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { lineNoteBlocks } from '@dfai/domain/testing';
import { createVaultPath, literatureNoteText, pdfPageText, type PdfPageText } from '@dfai/domain';
import { fakeIndexPort, fakeMarkdown, fakeVaultFs, type OpenNotes } from '@dfai/application';
import type { PdfJsDocument } from '@dfai/adapters/pdf';
import { PdfReader } from '@dfai/ui';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import {
  useLiteratureNoteOf,
  usePlacedHighlights,
  useReaderWrites,
  type DocumentPorts,
} from './use-document-highlights.ts';

/*
 * Regression tests for the PDF reader (#504, review of PR #515): a comment edited in the
 * Highlights panel while the note has unsaved typing in a pane.
 */

Range.prototype.getBoundingClientRect ??= () => new DOMRect(0, 0, 0, 0);

const VAULT = '/vault';
const PDF = createVaultPath('Library/The Lantern Keepers.pdf');
const NOTE = createVaultPath('Library/The Lantern Keepers.md');
const PAGE: PdfPageText = pdfPageText([
  {
    text: 'A light kept is a promise kept.',
    box: { x: 0.1, y: 0.2, width: 0.31, height: 0.02 },
    endsLine: false,
  },
]);

const opened = {
  pageCount: 1,
  pageSize: async () => ({ width: 612, height: 792 }),
  pageText: async () => PAGE,
  metadata: async () => ({ title: null, author: null }),
  outline: async () => [],
  close: async () => {},
  drawPage: () => ({ done: Promise.resolve(), cancel: () => {} }),
  pictureOf: async () => new Uint8Array([137, 80, 78, 71]),
} satisfies PdfJsDocument;

function setUp() {
  const files = new Map<string, string>([
    [
      NOTE,
      literatureNoteText({ kind: 'pdf', title: 'The Lantern Keepers', author: null, file: PDF }),
    ],
  ]);
  const typing = { dirty: false };
  const base = fakeMarkdown();
  const openNotes: OpenNotes = {
    state: () => (typing.dirty ? 'dirty' : 'closed'),
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
  return { files, ports, typing };
}

function useTab(ports: DocumentPorts) {
  const note = useLiteratureNoteOf({ ports, vault: VAULT, pdf: PDF }) ?? null;
  const { highlights } = usePlacedHighlights({ ports, vault: VAULT, note, opened, generation: 1 });
  const writes = useReaderWrites({ ports, vault: VAULT, note, pdf: PDF, opened });
  return { note, highlights, ...writes };
}

function Tab({ ports }: { ports: DocumentPorts }) {
  const { highlights, actions, notice } = useTab(ports);
  return (
    <PdfReader
      {...actions}
      title="The Lantern Keepers.pdf"
      folder="Library"
      pdf={opened}
      firstPageSize={{ width: 612, height: 792 }}
      outline={[]}
      highlights={highlights}
      reveal={null}
      notice={notice}
      onOpenNote={() => {}}
    />
  );
}

describe('a comment edited in the panel while the note has unsaved typing', () => {
  it('keeps the comment the person typed in the open form when the save is refused', async () => {
    const { ports, typing, files } = setUp();
    const { wrapper } = queryWrapper();
    const seeded = renderHook(() => useTab(ports), { wrapper });
    await waitFor(() => expect(seeded.result.current.note).toBe(NOTE));
    await act(() =>
      seeded.result.current.actions.onHighlight({
        selection: { page: 1, start: 0, end: 12 },
        style: { mark: 'highlight', color: 'yellow' },
      }),
    );
    seeded.unmount();

    render(<Tab ports={ports} />, { wrapper });
    await userEvent.click(await screen.findByRole('button', { name: 'Add comment' }));
    typing.dirty = true;
    const before = files.get(NOTE);
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Comment' }),
      'Said twice, by two keepers.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Refused, and said so: the note is unchanged.
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(files.get(NOTE)).toBe(before);
    // What was typed is still there to save again, as the form promises.
    expect(screen.getByRole('textbox', { name: 'Comment' })).toHaveProperty(
      'value',
      'Said twice, by two keepers.',
    );
  });
});
