import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import {
  allPageTexts,
  editHighlightComment,
  findLiteratureNote,
  highlightArea,
  highlightSelection,
  placeHighlights,
  readLiteratureNoteAt,
  removeHighlight,
  type IndexPort,
  type MarkdownPort,
  type OpenNotes,
  type PlacedHighlight,
  type VaultFsPort,
} from '@dfai/application';
import {
  findInDocument,
  LITERATURE_NOTE_TYPE,
  plainQuote,
  type HighlightBlock,
  type VaultPath,
} from '@dfai/domain';
import type { ReaderActions, ReaderHighlight } from '@dfai/ui';
import type { PdfJsDocument } from '@dfai/adapters/pdf';
import { browserImagePlacementStore } from '../notes/browser-image-placement-store.ts';
import { cryptoRng } from '../random.ts';
import { scopedReadKey, scopedReadMeta } from '../reads/query-client.ts';

/*
 * A document's literature note as its reader tab uses it (#504, #505): which note it is,
 * its highlights placed on the open document, and the writes the reader
 * makes to it. Every read is a query (ADR-0040), read again when the note
 * changes; every write is the application's, against the version just read.
 */

export interface DocumentPorts {
  readonly fs: VaultFsPort;
  readonly markdown: MarkdownPort;
  readonly index: IndexPort;
  readonly openNotes: OpenNotes;
  /** Re-reads the tree and the index after a write. */
  readonly onChanged: () => void;
}

/** The literature note whose `file:` is `pdf` (or a book), read again when any literature note changes. */
export function useLiteratureNoteOf({
  ports,
  vault,
  pdf,
}: {
  ports: DocumentPorts;
  vault: string;
  pdf: VaultPath;
}): VaultPath | null | undefined {
  const { data } = useQuery({
    queryKey: scopedReadKey(vault, 'literature-note-of', pdf),
    queryFn: () => findLiteratureNote(ports, pdf),
    meta: scopedReadMeta({ types: [LITERATURE_NOTE_TYPE] }),
  });
  return data;
}

/** The note's highlights, read again when the note changes. */
export function useNoteHighlights({
  ports,
  vault,
  note,
}: {
  ports: DocumentPorts;
  vault: string;
  note: VaultPath | null;
}) {
  return useQuery({
    queryKey: scopedReadKey(vault, 'literature-highlights', note),
    queryFn: async () => (await readLiteratureNoteAt(ports, note as VaultPath)).highlights,
    meta: scopedReadMeta({ notes: note === null ? [] : [note] }),
    enabled: note !== null,
  });
}

/** The highlights placed on the open document, in reading order. */
export function usePlacedHighlights({
  ports,
  vault,
  note,
  opened,
  generation,
}: {
  ports: DocumentPorts;
  vault: string;
  note: VaultPath | null;
  opened: PdfJsDocument;
  generation: number;
}): {
  readonly highlights: readonly ReaderHighlight[];
  /** The ids of the note's highlights, placed or not; null until the note is read. */
  readonly ids: readonly string[] | null;
  readonly notice: string | null;
} {
  const read = useNoteHighlights({ ports, vault, note });
  const highlights = read.data ?? NONE;
  const ids = useMemo(() => read.data?.map((block) => block.id) ?? null, [read.data]);
  const signature = useMemo(() => highlights.map(signatureOf).join('\n'), [highlights]);
  const placements = useQuery({
    // The open document is this tab's own, told apart by when it was opened.
    queryKey: scopedReadKey(vault, 'pdf-placements', note, generation, signature),
    queryFn: () => placeHighlights({ opened, blocks: highlights }),
    meta: scopedReadMeta({ notes: note === null ? [] : [note] }),
    enabled: highlights.length > 0,
  });
  const shown = useMemo(
    () => (highlights.length === 0 ? [] : (placements.data ?? []).map(shownHighlight)),
    [placements.data, highlights],
  );
  const failure = read.error ?? placements.error;
  return {
    highlights: shown,
    ids,
    notice: failure === null ? null : `The highlights could not be shown: ${messageOf(failure)}`,
  };
}

const NONE: readonly HighlightBlock[] = [];

const signatureOf = (block: HighlightBlock) =>
  JSON.stringify([block.id, block.quote, block.comment, block.style, block.anchor]);

const shownHighlight = ({ block, placement }: PlacedHighlight): ReaderHighlight => ({
  id: block.id,
  quote: plainQuote(block.quote).replace(/\s+/g, ' '),
  comment: block.comment,
  style: block.style,
  placement,
});

/**
 * A write into the literature note, against the version just read: false,
 * and its refusal said in `notice`, when it was not taken; the note's
 * highlights are read again either way.
 */
export function useNoteWriting({
  ports,
  vault,
  note,
}: {
  ports: DocumentPorts;
  vault: string;
  note: VaultPath | null;
}): {
  writing: (write: (note: VaultPath, ports: WritePorts) => Promise<unknown>) => Promise<boolean>;
  notice: string | null;
} {
  const client = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const writing = useCallback(
    async (write: (note: VaultPath, ports: WritePorts) => Promise<unknown>): Promise<boolean> => {
      if (note === null) return false;
      try {
        await write(note, { ...ports, rng: cryptoRng });
        setNotice(null);
        return true;
      } catch (error) {
        setNotice(messageOf(error));
        return false;
      } finally {
        await client.invalidateQueries({
          queryKey: scopedReadKey(vault, 'literature-highlights', note),
        });
        ports.onChanged();
      }
    },
    [client, note, ports, vault],
  );
  return { writing, notice };
}

/** What the PDF reader's marks write, and the notice when one is refused. */
export function useReaderWrites({
  ports,
  vault,
  note,
  pdf,
  opened,
}: {
  ports: DocumentPorts;
  vault: string;
  note: VaultPath | null;
  pdf: VaultPath;
  opened: PdfJsDocument;
}): { actions: ReaderActions; notice: string | null } {
  const { writing, notice } = useNoteWriting({ ports, vault, note });
  const actions = useMemo<ReaderActions>(
    () => ({
      onHighlight: ({ selection, style, comment }) =>
        writing(async (path, write) =>
          highlightSelection(write, {
            note: path,
            selection,
            page: await opened.pageText(selection.page),
            style,
            ...(comment !== undefined && { comment }),
          }),
        ),
      onHighlightArea: ({ page, box, style, comment }) =>
        writing((path, write) =>
          highlightArea(write, {
            note: path,
            pdf,
            page,
            box,
            picture: () => opened.pictureOf({ page, box, scale: 2 }),
            placement: browserImagePlacementStore.read(),
            style,
            ...(comment !== undefined && { comment }),
          }),
        ),
      onEditComment: ({ id, comment }) =>
        writing((path, write) => editHighlightComment(write, { path, id, comment })),
      onRemove: (id) => writing((path, write) => removeHighlight(write, { path, id })),
      onSearch: async (phrase) => findInDocument(await allPageTexts(opened), phrase),
    }),
    [opened, pdf, writing],
  );
  return { actions, notice };
}

export type WritePorts = DocumentPorts & { readonly rng: typeof cryptoRng };

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
