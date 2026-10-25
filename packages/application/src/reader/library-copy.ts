import {
  checkIncomingDocument,
  joinVaultPath,
  libraryFileName,
  literatureDetails,
  literatureNoteFileName,
  literatureNoteText,
  notADocumentMessage,
  numberedFileName,
  SOURCE_KIND_NAMES,
  type DocumentKind,
  type IncomingDocument,
  type PdfMetadata,
  type VaultPath,
} from '@dfai/domain';
import { placeUnderFreeName } from '../vault/place-under-free-name.ts';
import type { VaultFsPort } from '../vault/ports.ts';

/*
 * Adding a document to the library (#504, #505, ADR-0043 §1): a copy of the
 * file goes into the library folder under a name its note can link, and a
 * literature note is made beside it, titled from the document's own
 * metadata. The original is only read, never moved or changed; the copy is
 * never written into again, so it stays byte for byte what was added. What
 * makes a PDF or an EPUB readable is the caller's (`addPdfToLibrary`,
 * `addEpubToLibrary`); the copy and the note are made here, alike for both.
 */

/** A document picked or dropped: its name and size, and a way to read its bytes. */
export interface PickedDocument extends IncomingDocument {
  /** Read only once the name and size have passed, so a file far too large is refused unread. */
  readonly bytes: () => Promise<Uint8Array>;
}

/** What adding a document made: the copy in the vault and its literature note. */
export interface AddedDocument {
  readonly file: VaultPath;
  readonly note: VaultPath;
  readonly title: string;
}

export type LibraryFs = Pick<
  VaultFsPort,
  'listDirectory' | 'createFolder' | 'createNote' | 'writeBinaryFile' | 'trashEntry'
>;

/** How one kind of document is told apart, read and refused. */
export interface DocumentFormat {
  readonly kind: DocumentKind;
  /** Whether the bytes read are this kind of document, by how they start. */
  readonly looksRight: (bytes: Uint8Array) => boolean;
  /** Its title and author; throws, through `refuse`, when it cannot be read. */
  readonly metadata: (bytes: Uint8Array) => Promise<PdfMetadata>;
  /** The error a refusal is thrown as, in words to show the person. */
  readonly refuse: (message: string) => Error;
}

/**
 * Copies `picked` into `folder` and makes its literature note there. Refused,
 * with nothing written, for a file that is not of the format's kind, is
 * empty or too large, or cannot be read. The copy is written first, and when
 * the note then cannot be made the copy is put in the Trash again — a retry
 * would otherwise find it and number a second copy beside it — and the error
 * says so; when even that fails, it says where the copy stayed.
 */
export async function addToLibrary(
  fs: LibraryFs,
  { picked, folder, format }: { picked: PickedDocument; folder: VaultPath; format: DocumentFormat },
): Promise<AddedDocument> {
  const check = checkIncomingDocument(picked, format.kind);
  if (check.kind === 'refused') throw format.refuse(check.message);
  const bytes = await picked.bytes();
  if (!format.looksRight(bytes)) throw format.refuse(notADocumentMessage(picked.name, format.kind));
  const metadata = await format.metadata(bytes);
  const file = await placeUnderFreeName({
    fs,
    folder,
    name: libraryFileName(picked.name, format.kind),
    place: (path) => fs.writeBinaryFile({ path, bytes, offset: 0 }),
  }).catch((error: unknown) => {
    throw format.refuse(`“${picked.name}” could not be saved in ${folder}: ${messageOf(error)}`);
  });
  const { title, author } = literatureDetails({ metadata, file });
  const note = await createLiteratureNote(fs, {
    folder,
    kind: format.kind,
    title,
    author,
    file,
  }).catch(async (error: unknown) => {
    throw format.refuse(await withoutCopy(fs, { file, kind: format.kind, cause: error }));
  });
  return { file, note, title };
}

/** Makes the note under a name numbered clear of the folder's, as a second copy of one book needs. */
async function createLiteratureNote(
  fs: LibraryFs,
  {
    folder,
    kind,
    title,
    author,
    file,
  }: {
    folder: VaultPath;
    kind: DocumentKind;
    title: string;
    author: string | null;
    file: VaultPath;
  },
): Promise<VaultPath> {
  const contents = literatureNoteText({ kind, title, author, file });
  const taken = (await fs.listDirectory(folder)).map((entry) => entry.name);
  const note = joinVaultPath(
    folder,
    numberedFileName({ name: literatureNoteFileName(title), taken }),
  );
  await fs.createNote({ path: note, contents });
  return note;
}

/** Puts the copy the note failed to follow in the Trash, and says what is left of it. */
async function withoutCopy(
  fs: LibraryFs,
  { file, kind, cause }: { file: VaultPath; kind: DocumentKind; cause: unknown },
): Promise<string> {
  const failure = `The note for the ${SOURCE_KIND_NAMES[kind]} could not be made: ${messageOf(cause)}`;
  try {
    await fs.trashEntry({ path: file });
    return `${failure} Nothing was added.`;
  } catch (trashing) {
    return `${failure} The ${SOURCE_KIND_NAMES[kind]} was saved as ${file} and could not be removed: ${messageOf(trashing)}`;
  }
}

export const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
