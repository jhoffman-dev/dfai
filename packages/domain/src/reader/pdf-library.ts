import {
  LIBRARY_HOME,
  LITERATURE_NOTE_TYPE,
  safeSourceFileName,
} from '../highlights/literature-note.ts';
import { homeFolderOf } from '../home-folders/home-folder.ts';
import type { ObjectType } from '../types/property-def.ts';
import { fitFileNameStem } from '../vault/file-name-bytes.ts';
import {
  cleanEntryName,
  linkableEntryName,
  NUMBERED_NOTE_ENDING,
  noteFileName,
} from '../vault/new-note.ts';
import { createVaultPath, vaultPathName, type VaultPath } from '../vault/vault-path.ts';
import {
  DOCUMENT_EXTENSIONS,
  documentKindOf,
  withoutDocumentExtension,
  type DocumentKind,
} from './document-kind.ts';

/*
 * Adding a PDF to the library (#504, ADR-0043 §1): what the copy in the vault
 * is called, what its literature note says, and which files are taken. The
 * copy's name is the file's own, made safe for the note's `file:` link; the
 * note's title is the PDF's own title when it has a real one, else the name.
 */

/** The most a document in the vault may be: what the host writes or reads in one file. */
export const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;

/** What a document picked or dropped is, before its bytes are read. */
export interface IncomingDocument {
  readonly name: string;
  readonly size: number;
}

export type DocumentCheck =
  { readonly kind: 'accepted' } | { readonly kind: 'refused'; readonly message: string };

/** How a document of each kind is named to the person: "a PDF", "an EPUB". */
const DOCUMENT_NAMES: Readonly<Record<DocumentKind, string>> = { pdf: 'a PDF', epub: 'an EPUB' };

/** What the person is told of a file named `name` that is not a `kind` document: by its name, or by its bytes. */
export const notADocumentMessage = (name: string, kind: DocumentKind): string =>
  `“${name}” is not ${DOCUMENT_NAMES[kind]}.`;

/**
 * Whether a file picked or dropped can be added as a `kind` document: one by
 * its name, not empty, not past the host's size.
 */
export function checkIncomingDocument(file: IncomingDocument, kind: DocumentKind): DocumentCheck {
  const shown = `“${file.name}”`;
  const named = DOCUMENT_NAMES[kind];
  if (documentKindOf(file.name) !== kind) {
    return { kind: 'refused', message: notADocumentMessage(file.name, kind) };
  }
  if (file.size === 0) return { kind: 'refused', message: `${shown} is empty.` };
  if (file.size > MAX_DOCUMENT_BYTES) {
    const megabytes = (file.size / 1024 / 1024).toFixed(1);
    const most = MAX_DOCUMENT_BYTES / 1024 / 1024;
    const article = named.charAt(0).toUpperCase() + named.slice(1);
    return {
      kind: 'refused',
      message: `${shown} is ${megabytes} MB. ${article} in the library can be at most ${most} MB.`,
    };
  }
  return { kind: 'accepted' };
}

/**
 * Whether `bytes` start as a PDF does. A PDF may have up to a kilobyte of
 * anything before its `%PDF-` header, which every reader allows.
 */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const head = String.fromCharCode(...bytes.subarray(0, 1024));
  return head.includes('%PDF-');
}

/** Whether a name or a path is a PDF's. */
export const isPdfName = (name: string): boolean => documentKindOf(name) === 'pdf';

/**
 * The name the copy of a `kind` document in the vault is saved under: the
 * file's own, cleaned of what no filesystem takes and of what a wiki link
 * means something by, cut by whole characters so it still fits a file name
 * on disk once numbered (` 2`, ` 3`, …), and ending in `.pdf` or `.epub`.
 */
export function libraryFileName(name: string, kind: DocumentKind): string {
  const extension = `.${DOCUMENT_EXTENSIONS[kind]}`;
  const cleaned = cleanEntryName(safeSourceFileName(withoutDocumentExtension(name)));
  // What follows the stem, with the room a number needs when the name is taken.
  const stem = fitFileNameStem(cleaned, ` 9999${extension}`);
  return `${stem === '' ? 'Untitled' : stem}${extension}`;
}

/**
 * The file name of a PDF's literature note: its title made a name a wiki
 * link can reach (no `#`, `^`, `|`, `[`, `]`) and cut by whole characters to
 * fit a file name on disk with room to be numbered. `Untitled` when the
 * title leaves nothing.
 */
export function literatureNoteFileName(title: string): string {
  return noteFileName(fitFileNameStem(linkableEntryName(title), NUMBERED_NOTE_ENDING));
}

/** What follows an area picture's stem: ` p9999 area.png`, and the room a number needs. */
const NUMBERED_AREA_ENDING = ' p9999 area 9999.png';

/** Titles a PDF's metadata gives that name a tool, a template or nothing at all, not the work. */
const PLACEHOLDER_TITLE =
  /^(untitled|title|document|microsoft word - .*|.*\.(docx?|pdf|tex|indd))$/i;

/** What a document says about itself: a PDF's information, as pdf.js reads it, or an EPUB's package metadata. */
export interface PdfMetadata {
  readonly title: string | null;
  readonly author: string | null;
}

/**
 * The literature note's title and author for a document saved as `file`:
 * its own title when it names the work, else the file's name without
 * `.pdf` or `.epub`; its author when it gives one.
 */
export function literatureDetails({ metadata, file }: { metadata: PdfMetadata; file: VaultPath }): {
  title: string;
  author: string | null;
} {
  const title = metadata.title?.trim() ?? '';
  const author = metadata.author?.trim() ?? '';
  return {
    title:
      title !== '' && !PLACEHOLDER_TITLE.test(title)
        ? title
        : withoutDocumentExtension(vaultPathName(file)),
    author: author === '' ? null : author,
  };
}

/**
 * The name an area's picture is saved under: the PDF's name, its page, and
 * that it is an area. The PDF's name is made one a note can embed — a PDF
 * the person put in the vault themselves may hold `#`, `[`, `]`, `^` or `|` —
 * and cut to fit a file name on disk.
 */
export function areaImageName({ file, page }: { file: VaultPath; page: number }): string {
  const stem = linkableEntryName(vaultPathName(file).replace(/\.pdf$/i, ''));
  const fitted = fitFileNameStem(stem, NUMBERED_AREA_ENDING);
  return `${fitted === '' ? 'Untitled' : fitted} p${page} area.png`;
}

/**
 * The folder a PDF and its literature note are added to: the literature
 * type's home (ADR-0038), `Library` unless the vault's type file says
 * otherwise, and `Library` still when it says the type has none.
 */
export function libraryFolder({
  types,
  today,
}: {
  types: readonly Pick<ObjectType, 'name' | 'folder'>[];
  today: string;
}): VaultPath {
  return (
    homeFolderOf({ properties: { type: LITERATURE_NOTE_TYPE }, types, today }) ??
    createVaultPath(LIBRARY_HOME)
  );
}
