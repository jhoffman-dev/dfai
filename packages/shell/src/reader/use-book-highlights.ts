import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import {
  editHighlightComment,
  highlightBookSelection,
  placeBookHighlights,
  removeHighlight,
  searchBook,
  type PlacedBookHighlight,
} from '@dfai/application';
import { plainQuote, type HighlightBlock, type VaultPath } from '@dfai/domain';
import type { BookReaderActions, ReaderBookHighlight } from '@dfai/ui';
import { yieldToHost, type FoliateBook } from '@dfai/adapters/epub';
import { scopedReadKey, scopedReadMeta } from '../reads/query-client.ts';
import {
  useNoteHighlights,
  useNoteWriting,
  type DocumentPorts,
} from './use-document-highlights.ts';

/*
 * A book's literature note as its reader tab uses it (#505): its highlights
 * placed in the open book, and the writes the reader makes to it. Every read
 * is a query (ADR-0040), read again when the note changes; every write is
 * the application's, against the version just read.
 */

/** The highlights placed in the open book, in the order they come in it. */
export function usePlacedBookHighlights({
  ports,
  vault,
  note,
  book,
  generation,
}: {
  ports: DocumentPorts;
  vault: string;
  note: VaultPath | null;
  book: FoliateBook;
  generation: number;
}): {
  readonly highlights: readonly ReaderBookHighlight[];
  /** The ids of the note's highlights, placed or not; null until the note is read. */
  readonly ids: readonly string[] | null;
  readonly notice: string | null;
} {
  const read = useNoteHighlights({ ports, vault, note });
  const blocks = read.data ?? NONE;
  const ids = useMemo(() => read.data?.map((block) => block.id) ?? null, [read.data]);
  const signature = useMemo(() => blocks.map(signatureOf).join('\n'), [blocks]);
  const placements = useQuery({
    // The open book is this tab's own, told apart by when it was opened.
    queryKey: scopedReadKey(vault, 'epub-placements', note, generation, signature),
    queryFn: () => placeBookHighlights({ book, blocks, pause: yieldToHost }),
    meta: scopedReadMeta({ notes: note === null ? [] : [note] }),
    enabled: blocks.length > 0,
  });
  const highlights = useMemo(
    () => (blocks.length === 0 ? [] : (placements.data ?? []).map(shownHighlight)),
    [placements.data, blocks],
  );
  const failure = read.error ?? placements.error;
  return {
    highlights,
    ids,
    notice: failure === null ? null : `The highlights could not be shown: ${messageOf(failure)}`,
  };
}

const NONE: readonly HighlightBlock[] = [];

const signatureOf = (block: HighlightBlock) =>
  JSON.stringify([block.id, block.quote, block.comment, block.style, block.anchor]);

const shownHighlight = ({ block, placement }: PlacedBookHighlight): ReaderBookHighlight => ({
  id: block.id,
  quote: plainQuote(block.quote).replace(/\s+/g, ' '),
  comment: block.comment,
  style: block.style,
  placement,
});

/** What the book reader's marks write, and the notice when one is refused. */
export function useBookWrites({
  ports,
  vault,
  note,
  book,
}: {
  ports: DocumentPorts;
  vault: string;
  note: VaultPath | null;
  book: FoliateBook;
}): { actions: BookReaderActions; notice: string | null } {
  const { writing, notice } = useNoteWriting({ ports, vault, note });
  const actions = useMemo<BookReaderActions>(
    () => ({
      onHighlight: ({ selection, style, comment }) =>
        writing((path, write) =>
          highlightBookSelection(write, {
            note: path,
            book,
            selection,
            style,
            ...(comment !== undefined && { comment }),
          }),
        ),
      onEditComment: ({ id, comment }) =>
        writing((path, write) => editHighlightComment(write, { path, id, comment })),
      onRemove: (id) => writing((path, write) => removeHighlight(write, { path, id })),
      onSearch: (phrase) => searchBook(book, phrase, yieldToHost),
    }),
    [book, writing],
  );
  return { actions, notice };
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
