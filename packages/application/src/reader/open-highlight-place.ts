import {
  DOCUMENT_EXTENSIONS,
  documentKindOf,
  documentLinkTarget,
  highlightOpening,
  isVisibleEntry,
  namesDocument,
  HIDDEN_DIRECTORY_NAMES,
  VAULT_WALK_DEPTH,
  readerLinkLabel,
  readHighlights,
  readLiteratureNote,
  vaultPathName,
  type DocumentKind,
  type HighlightOpening,
  type VaultPath,
} from '@dfai/domain';
import type { MarkdownPort } from '../notes/ports.ts';
import type { VaultFsPort } from '../vault/ports.ts';
import { readLiteratureNoteAt } from './pdf-highlights.ts';

/*
 * Following a highlight back to its place (#506): a transcluded highlight, a
 * link to one, the "Open in PDF" or "Open in EPUB" of one in its own note, and the library's
 * rows (#507) all ask here where a block of a note opens — the source's
 * reader at the highlight, or the note at the block — and open it there.
 * Which kind opens what is the domain's rule (`highlightOpening`); this reads
 * the note it is asked about.
 */

/** What reading a note's highlights needs. */
export interface HighlightPlacePorts {
  readonly fs: Pick<VaultFsPort, 'readTextFile'>;
  readonly markdown: Pick<MarkdownPort, 'frontmatterProperties' | 'noteBlocks'>;
}

/** Opens what a highlight leads to, where the caller's click asked. */
export interface HighlightPlaceOpener {
  /** The document's reader, brought to the highlight and flashing it. */
  openDocument(args: { readonly path: VaultPath; readonly highlightId: string }): void;
  /** The note, scrolled to the block. */
  openNote(args: { readonly path: VaultPath; readonly blockId: string }): void;
}

/** Where following block `blockId` of `note` leads: the source's reader, or the note at the block. */
export async function whereHighlightOpens(
  ports: HighlightPlacePorts,
  { note, blockId }: { note: VaultPath; blockId: string },
): Promise<HighlightOpening> {
  let read: Awaited<ReturnType<typeof readLiteratureNoteAt>>;
  try {
    read = await readLiteratureNoteAt(ports, note);
  } catch {
    // A note that cannot be read just now is opened anyway: its page says
    // why it cannot be shown, which is more use than a click that does nothing.
    return { kind: 'note', note, blockId };
  }
  const literature =
    read.source === null
      ? null
      : { source: read.source, highlightIds: read.highlights.map((highlight) => highlight.id) };
  return highlightOpening({ note, blockId, literature });
}

/**
 * Opens highlight `highlightId` of literature note `note` where it lives:
 * in its reader for a PDF or an EPUB, at its block in the note for a Kindle
 * book. What the library and all-highlights views
 * (#507) call for a row; resolves to where it opened.
 */
export async function openHighlightPlace(
  ports: HighlightPlacePorts & { readonly opener: HighlightPlaceOpener },
  { note, highlightId }: { note: VaultPath; highlightId: string },
): Promise<HighlightOpening> {
  const opening = await whereHighlightOpens(ports, { note, blockId: highlightId });
  if (opening.kind === 'reader') {
    ports.opener.openDocument({ path: opening.document, highlightId: opening.highlightId });
  } else {
    ports.opener.openNote({ path: opening.note, blockId: opening.blockId });
  }
  return opening;
}

/** The highlights of an open literature note that offer to open in its reader, and in what words. */
export interface ReaderHighlightLinks {
  /** "Open in PDF", "Open in EPUB". */
  readonly label: string;
  readonly ids: ReadonlySet<string>;
}

/**
 * Which highlights of a note, as its file reads, offer to open in a reader
 * ("Open in PDF") — every one of a PDF's literature note — or null for a
 * note whose source has no reader in the app, or that is no literature note.
 */
export function readerHighlightLinks(
  markdown: Pick<MarkdownPort, 'noteBlocks'>,
  note: { readonly properties: Readonly<Record<string, unknown>>; readonly text: string },
): ReaderHighlightLinks | null {
  const label = readerLinkLabel(readLiteratureNote(note.properties));
  if (label === null) return null;
  const highlights = readHighlights(note.text, (text) => markdown.noteBlocks(text));
  return { label, ids: new Set(highlights.map((highlight) => highlight.id)) };
}

/** What finding the document a wiki link names needs: the vault's files. */
export interface LinkedDocumentPorts {
  readonly fs: Pick<VaultFsPort, 'listFiles'>;
}

/**
 * The document a wiki link `[[…pdf]]` or `[[…epub]]` names among the files
 * the vault holds, or null when the vault has none so called or the link is
 * to anything else (`documentLinkTarget`). The vault is read for its files of
 * the link's kind, not the literature notes' `file:` lines, so a document
 * with no literature note is found; a read that fails is the caller's to say.
 */
export async function linkedDocument(
  ports: LinkedDocumentPorts,
  target: string,
): Promise<VaultPath | null> {
  const kind = namesDocument(target);
  if (kind === null) return null;
  return documentLinkTarget(target, await listVaultDocuments(ports, kind));
}

/**
 * Every document of `kind` in user space, in one walk by the host told what
 * to skip as the note walk is, hidden entries left out as everywhere
 * (`isVisibleEntry`).
 */
async function listVaultDocuments(
  { fs }: LinkedDocumentPorts,
  kind: DocumentKind,
): Promise<VaultPath[]> {
  const files = await fs.listFiles({
    extension: DOCUMENT_EXTENSIONS[kind],
    skipDirectories: HIDDEN_DIRECTORY_NAMES,
    maxDepth: VAULT_WALK_DEPTH,
  });
  return files.filter(
    (path) =>
      documentKindOf(path) === kind &&
      isVisibleEntry({ kind: 'file', name: vaultPathName(path), path }),
  );
}
