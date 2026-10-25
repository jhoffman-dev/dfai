import { EpubProtectedError } from '@dfai/application';
import { parentVaultPath, protectedEpubMessage, vaultPathName } from '@dfai/domain';
import { BookReader } from '@dfai/ui';
import type { FoliateBook } from '@dfai/adapters/epub';
import { PageFrameFallback } from '../page-frame-fallback.tsx';
import { appEpubReader } from './app-epub-reader.ts';
import type { DocumentReaderProps } from './document-reader.tsx';
import { missingHighlightNotice } from './missing-highlight.ts';
import { useLiteratureNoteOf } from './use-document-highlights.ts';
import { useBookWrites, usePlacedBookHighlights } from './use-book-highlights.ts';
import { useOpenDocument } from './use-open-document.ts';

/*
 * An EPUB in a reader tab (#505), in the chunk that brings foliate-js, loaded
 * the first time a book opens. It opens the file — a book locked with DRM is
 * refused, said plainly — finds its literature note, and hands the reader
 * the note's highlights placed in the book and the writes its marks make.
 */

export function BookReaderTab(props: DocumentReaderProps) {
  const name = vaultPathName(props.path);
  const open = useOpenDocument({
    fs: props.ports.fs,
    reader: appEpubReader,
    path: props.path,
    failure: (error) =>
      error instanceof EpubProtectedError
        ? protectedEpubMessage(name)
        : `${props.path} could not be opened: ${messageOf(error)}`,
  });
  const chrome = {
    ...(props.onShowSidebar !== undefined && { onShowSidebar: props.onShowSidebar }),
    ...(props.history !== undefined && { history: props.history }),
  };
  if (open.state !== 'open') {
    return (
      <PageFrameFallback {...chrome}>
        {open.state === 'failed' ? (
          <p className="notice pdf-reader__notice" role="alert">
            {open.message}
          </p>
        ) : (
          <p className="pdf-reader__opening">Opening {name}…</p>
        )}
      </PageFrameFallback>
    );
  }
  return <OpenBook {...props} book={open.opened} generation={open.generation} />;
}

function OpenBook(props: DocumentReaderProps & { book: FoliateBook; generation: number }) {
  const { ports, vault, path, book, generation } = props;
  // Undefined while it is looked for: not yet "no note", so nothing is said and nothing marked.
  const found = useLiteratureNoteOf({ ports, vault, pdf: path });
  const note = found ?? null;
  const placed = usePlacedBookHighlights({ ports, vault, note, book, generation });
  const { actions, notice } = useBookWrites({ ports, vault, note, book });
  return (
    <BookReader
      {...actions}
      title={book.metadata.title ?? vaultPathName(path)}
      folder={parentVaultPath(path) || 'Vault'}
      book={book}
      highlights={placed.highlights}
      reveal={props.reveal}
      notice={
        notice ??
        placed.notice ??
        (found === null ? NO_NOTE : missingHighlightNotice(props.reveal, placed.ids, 'book'))
      }
      onOpenNote={note === null ? null : () => props.onOpenNote(note)}
      {...(props.onShowSidebar !== undefined && { onShowSidebar: props.onShowSidebar })}
      {...(props.history !== undefined && { history: props.history })}
    />
  );
}

/** Said over a book no literature note names: it can be read, but highlights have nowhere to go. */
const NO_NOTE =
  'This book has no literature note, so highlights cannot be kept. Add it with “Add EPUB…” in ⌘K to make one.';

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
