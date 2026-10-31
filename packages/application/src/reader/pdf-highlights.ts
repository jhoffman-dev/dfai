import {
  areaHighlight,
  areaImageName,
  heldHighlight,
  imageFolderFor,
  readHighlights,
  readLiteratureNote,
  splitFrontmatter,
  textHighlight,
  type AppendedHighlight,
  type HighlightBlock,
  type HighlightStyle,
  type ImagePlacement,
  type LiteratureNote,
  type NewHighlight,
  type PageRect,
  type PdfPageText,
  type TextSelection,
  type VaultPath,
} from '@dfai/domain';
import {
  addHighlight,
  type LiteratureNoteWritePorts,
} from '../highlights/literature-note-writes.ts';
import { writeImageUnderFreeName } from '../notes/embed-image.ts';
import type { Rng } from '../ports.ts';
import type { VaultFsPort } from '../vault/ports.ts';
import { UnsavedTypingError } from '../vault/update-links.ts';

/*
 * What the reader writes into a PDF's literature note (#504): a highlight of
 * words picked on a page, or of a box dragged on a page with no words, whose
 * picture is saved beside the vault's images first so the note can show it.
 */

/** Words picked on a page could not be made a highlight: only space, or nothing the page can draw. */
export class NothingToHighlightError extends Error {
  constructor() {
    super('Nothing was selected to highlight: pick some words on the page.');
    this.name = 'NothingToHighlightError';
  }
}

type WritePorts = LiteratureNoteWritePorts & { readonly rng: Rng };

/** Adds a highlight of the words `selection` picks on `page` to the note, and answers its id. */
export async function highlightSelection(
  ports: WritePorts,
  {
    note,
    selection,
    page,
    style,
    comment,
  }: {
    note: VaultPath;
    selection: TextSelection;
    page: PdfPageText;
    style: HighlightStyle;
    comment?: string;
  },
): Promise<AppendedHighlight> {
  const highlight = textHighlight({
    selection,
    page,
    style,
    ...(comment !== undefined && { comment }),
  });
  if (highlight === null) throw new NothingToHighlightError();
  return addHighlight(ports, { path: note, highlight });
}

/**
 * Saves the picture of `box` on page `page` of `pdf`, then adds an area
 * highlight showing it to the note. `picture` draws the box as a PNG, and is
 * asked only when the note is free to be written (no unsaved typing in it)
 * and does not already hold that area: a repeat makes no picture at all
 * (ADR-0043). The picture is made for the highlight alone: when the note
 * then refuses it, the picture is put in the Trash again — it is DFAI's own
 * file, made a moment ago — but only once the note, read again, is seen not
 * to embed it, since a write can land and still report a failure.
 */
export async function highlightArea(
  ports: WritePorts & {
    readonly fs: Pick<
      VaultFsPort,
      'listDirectory' | 'createFolder' | 'writeBinaryFile' | 'trashEntry'
    >;
  },
  {
    note,
    pdf,
    page,
    box,
    picture,
    placement,
    style,
    comment,
  }: {
    note: VaultPath;
    pdf: VaultPath;
    page: number;
    box: PageRect;
    picture: () => Promise<Uint8Array>;
    placement: ImagePlacement;
    style: HighlightStyle;
    comment?: string;
  },
): Promise<AppendedHighlight> {
  if (ports.openNotes.state(note) === 'dirty') throw new UnsavedTypingError(note);
  const folder = imageFolderFor({ notePath: note, placement });
  const name = areaImageName({ file: pdf, page });
  const area = (image: string) =>
    areaHighlight({ page, box, image, style, ...(comment !== undefined && { comment }) });
  const held = await heldInNote(ports, { note, highlight: area(`${folder}/${name}`) });
  if (held !== null) return { id: held, added: false };
  const image = await writeImageUnderFreeName({
    fs: ports.fs,
    folder,
    name,
    bytes: await picture(),
  });
  try {
    const added = await addHighlight(ports, { path: note, highlight: area(image) });
    if (!added.added) await discardUnlessEmbedded(ports, { note, image });
    return added;
  } catch (error) {
    await discardUnlessEmbedded(ports, { note, image });
    throw error;
  }
}

/** The id of the highlight the note already holds for `highlight`'s passage, or null. */
async function heldInNote(
  ports: Pick<LiteratureNoteWritePorts, 'fs' | 'markdown'>,
  { note, highlight }: { note: VaultPath; highlight: NewHighlight },
): Promise<string | null> {
  const { text } = await ports.fs.readTextFile(note);
  return heldHighlight({ text, highlight, noteBlocks: (body) => ports.markdown.noteBlocks(body) });
}

/**
 * Puts the picture in the Trash unless the note, read again, embeds it. The
 * re-read only sees writes that landed before it: a write embedding the
 * picture that lands between the re-read and the trash is not caught. The
 * port's compare-and-trash (`trashEntry`'s `unchanged`, #235) could catch it
 * by holding the note still; this does not use it yet.
 */
async function discardUnlessEmbedded(
  ports: { readonly fs: Pick<VaultFsPort, 'readTextFile' | 'trashEntry'> },
  { note, image }: { note: VaultPath; image: VaultPath },
): Promise<void> {
  try {
    const { text } = await ports.fs.readTextFile(note);
    if (text.includes(`![[${image}]]`)) return;
    await ports.fs.trashEntry({ path: image });
  } catch {
    // The refusal that sent us here is the news. A note that cannot be read again may embed the
    // picture, so it is kept; a picture left unlinked in the vault costs nothing.
  }
}

/** A literature note as the reader reads it: what it is of, and its highlights. */
export interface ReadLiteratureNote {
  readonly source: LiteratureNote | null;
  readonly highlights: readonly HighlightBlock[];
}

/** Reads the note at `note`: what it says it is a note of, and every highlight it holds. */
export async function readLiteratureNoteAt(
  ports: Pick<LiteratureNoteWritePorts, 'markdown'> & {
    readonly fs: Pick<VaultFsPort, 'readTextFile'>;
  },
  note: VaultPath,
): Promise<ReadLiteratureNote> {
  const { text } = await ports.fs.readTextFile(note);
  const frontmatter = ports.markdown.frontmatterProperties(splitFrontmatter(text).frontmatter);
  const source = readLiteratureNote(frontmatter);
  if (source === null) return { source: null, highlights: [] };
  return { source, highlights: readHighlights(text, (body) => ports.markdown.noteBlocks(body)) };
}
