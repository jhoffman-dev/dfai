import { BlobReader, configure, ZipReader, type ZipEntry } from 'foliate-js/vendor/zip.js';
import type { Loader } from 'foliate-js/epub.js';
import { EpubUnreadableError } from '@dfai/application';

/*
 * An EPUB's archive, read from its bytes with the zip.js foliate-js vendors
 * (#505): each file by its path, as text or as a blob. Nothing is fetched:
 * the bytes are already here, and zip.js is told to start no worker.
 *
 * A ZIP can be a bomb: a megabyte on disk that inflates to a gigabyte, in
 * the app's own process (ADR-0045 §6). The archive is refused when it is
 * opened if any file says it inflates past `MOST_FILE_BYTES`, all of them
 * past `MOST_BOOK_BYTES`, or a file of more than `RATIO_FROM_BYTES` says it
 * inflates more than `MOST_RATIO` times over; and since what a file says
 * can lie, a file is refused while it inflates the moment it passes the
 * size it said. A ZIP's directory can be a bomb too: a file listed costs
 * memory as the archive is opened, however empty it says it is, so an
 * archive listing more than `MOST_FILES` files is refused, by the count its
 * directory declares, as its first entry is read. The directory's bytes
 * are still read whole first, so what they cost is bounded only by the size
 * of the archive itself.
 */

const MIB = 1024 * 1024;
/** The most one file of a book may inflate to: far past any chapter, picture or font. */
export const MOST_FILE_BYTES = 64 * MIB;
/** The most a whole book may inflate to. */
export const MOST_BOOK_BYTES = 512 * MIB;
/** How many times over a file may inflate; text deflates about five times, a bomb a thousand. */
export const MOST_RATIO = 100;
/** Below this, a file is too small to be a bomb, however well it deflates. */
export const RATIO_FROM_BYTES = MIB;
/** The most files a book's archive may list; a long book with every picture has a few thousand. */
export const MOST_FILES = 10_000;

/** The book's archive, as foliate-js's parser reads it, and the names of every file in it. */
export interface BookArchive extends Loader {
  readonly entries: readonly string[];
  loadText(name: string): Promise<string | null>;
  loadBlob(name: string, type?: string): Promise<Blob | null>;
}

/** What a file of the archive says of its sizes. */
export interface DeclaredSizes {
  readonly filename: string;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
}

/** Why an archive whose files say these sizes is a bomb; null when it is not. */
export function bombReason(entries: readonly DeclaredSizes[]): string | null {
  let total = 0;
  for (const { filename, compressedSize, uncompressedSize } of entries) {
    if (uncompressedSize > MOST_FILE_BYTES) {
      return `its file ${filename} inflates past ${MOST_FILE_BYTES / MIB} MB`;
    }
    if (uncompressedSize > RATIO_FROM_BYTES && uncompressedSize > compressedSize * MOST_RATIO) {
      return `its file ${filename} inflates more than ${MOST_RATIO} times over`;
    }
    total += uncompressedSize;
  }
  return total > MOST_BOOK_BYTES ? `it inflates past ${MOST_BOOK_BYTES / MIB} MB` : null;
}

/** The archive in `bytes`; throws `EpubUnreadableError` for a bomb, and zip.js's own error for no ZIP. */
export async function openArchive(bytes: Uint8Array): Promise<BookArchive> {
  configure({ useWebWorkers: false });
  // A copy, so the caller's bytes stay theirs whatever the archive does with its own.
  const reader = new ZipReader(new BlobReader(new Blob([bytes.slice()])));
  const files = new Map<string, ZipEntry>();
  let listed = 0;
  // zip.js says the count its directory declares before it yields the first entry.
  const counted = (_index: number, total: number) => {
    listed = Math.max(listed, total);
  };
  // zip.js makes exactly the count declared, so no more entries come than were counted.
  for await (const entry of reader.getEntriesGenerator({ onprogress: counted })) {
    if (listed > MOST_FILES) throw tooMany();
    if (!entry.directory) files.set(entry.filename, entry);
  }
  const bomb = bombReason([...files.values()]);
  if (bomb !== null) throw new EpubUnreadableError(bomb);
  const load = async (name: string, type?: string) => {
    const entry = files.get(name);
    return entry === undefined ? null : inflated(entry, type);
  };
  return {
    entries: [...files.keys()],
    loadText: async (name) => (await load(name))?.text() ?? null,
    loadBlob: load,
    getSize: (name) => files.get(name)?.uncompressedSize ?? 0,
    sha1: async (text) =>
      new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text))),
  };
}

/** The file `entry` inflated, as a blob of `type`, refused the moment it passes the size it declared. */
async function inflated(entry: ZipEntry, type?: string): Promise<Blob> {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  const writable = new WritableStream<Uint8Array<ArrayBuffer>>({
    write(chunk) {
      size += chunk.length;
      // Erroring the stream stops zip.js inflating; it rejects with an error of its own.
      if (size > entry.uncompressedSize) throw new Error('past its declared size');
      chunks.push(chunk);
    },
  });
  try {
    await entry.getData(writable);
  } catch (error) {
    if (size > entry.uncompressedSize) throw lies(entry);
    throw error;
  }
  if (size > entry.uncompressedSize) throw lies(entry);
  return new Blob(chunks, type === undefined ? {} : { type });
}

const tooMany = () => new EpubUnreadableError(`it lists more than ${MOST_FILES} files`);

const lies = (entry: ZipEntry) =>
  new EpubUnreadableError(`its file ${entry.filename} inflates past the size it declares`);
