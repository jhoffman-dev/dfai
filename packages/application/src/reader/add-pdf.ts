import { looksLikePdf, type PdfMetadata, type VaultPath } from '@dfai/domain';
import {
  addToLibrary,
  messageOf,
  type AddedDocument,
  type LibraryFs,
  type PickedDocument,
} from './library-copy.ts';
import { PdfUnreadableError, type PdfReaderPort } from './ports.ts';

/*
 * Adding a PDF to the library (#504, ADR-0043 §1): a copy of the file goes
 * into the library folder under a name its note can link, and a literature
 * note is made beside it, titled from the PDF's own metadata
 * (`addToLibrary`). pdf.js reads the title; a PDF it cannot open is refused.
 */

/** Why a PDF was not added, in words to show the person. */
export class PdfNotAddedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfNotAddedError';
  }
}

export interface AddPdfPorts {
  readonly fs: LibraryFs;
  readonly reader: PdfReaderPort;
}

/**
 * Copies `pdf` into `folder` and makes its literature note there. Refused,
 * with nothing written, for a file that is not a PDF, is empty or too large,
 * or cannot be read (`PdfNotAddedError`); a note that cannot be made takes
 * the copy back out (`addToLibrary`).
 */
export async function addPdfToLibrary(
  ports: AddPdfPorts,
  { pdf, folder }: { pdf: PickedDocument; folder: VaultPath },
): Promise<AddedDocument> {
  return addToLibrary(ports.fs, {
    picked: pdf,
    folder,
    format: {
      kind: 'pdf',
      looksRight: looksLikePdf,
      metadata: (bytes) => readMetadata(ports.reader, { bytes, name: pdf.name }),
      refuse: (message) => new PdfNotAddedError(message),
    },
  });
}

async function readMetadata(
  reader: PdfReaderPort,
  { bytes, name }: { bytes: Uint8Array; name: string },
): Promise<PdfMetadata> {
  let opened;
  try {
    opened = await reader.open(bytes);
  } catch (error) {
    const reason = error instanceof PdfUnreadableError ? error.reason : messageOf(error);
    throw new PdfNotAddedError(`“${name}” could not be read as a PDF: ${reason}`);
  }
  try {
    return await opened.metadata();
  } catch {
    // A PDF can be readable and its document information not: the note is then titled by the file's name.
    return { title: null, author: null };
  } finally {
    await opened.close();
  }
}
