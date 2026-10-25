import {
  looksLikeEpub,
  protectedEpubMessage,
  type PdfMetadata,
  type VaultPath,
} from '@dfai/domain';
import {
  addToLibrary,
  messageOf,
  type AddedDocument,
  type LibraryFs,
  type PickedDocument,
} from './library-copy.ts';
import { EpubProtectedError, EpubUnreadableError, type EpubReaderPort } from './epub-ports.ts';

/*
 * Adding an EPUB to the library (#505, ADR-0043 §1): a copy of the file goes
 * into the library folder under a name its note can link, and a literature
 * note of kind `epub` is made beside it, titled and authored from the book's
 * own package metadata (`addToLibrary`). A book locked with DRM is refused,
 * plainly, before anything is written: it could never be read.
 */

/** Why an EPUB was not added, in words to show the person. */
export class EpubNotAddedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EpubNotAddedError';
  }
}

export interface AddEpubPorts {
  readonly fs: LibraryFs;
  readonly reader: EpubReaderPort;
}

/**
 * Copies `epub` into `folder` and makes its literature note there. Refused,
 * with nothing written, for a file that is not an EPUB, is empty or too
 * large, is protected with DRM, or cannot be read (`EpubNotAddedError`).
 */
export async function addEpubToLibrary(
  ports: AddEpubPorts,
  { epub, folder }: { epub: PickedDocument; folder: VaultPath },
): Promise<AddedDocument> {
  return addToLibrary(ports.fs, {
    picked: epub,
    folder,
    format: {
      kind: 'epub',
      looksRight: looksLikeEpub,
      metadata: (bytes) => readMetadata(ports.reader, { bytes, name: epub.name }),
      refuse: (message) => new EpubNotAddedError(message),
    },
  });
}

async function readMetadata(
  reader: EpubReaderPort,
  { bytes, name }: { bytes: Uint8Array; name: string },
): Promise<PdfMetadata> {
  let opened;
  try {
    opened = await reader.open(bytes);
  } catch (error) {
    if (error instanceof EpubProtectedError)
      throw new EpubNotAddedError(protectedEpubMessage(name));
    const reason = error instanceof EpubUnreadableError ? error.reason : messageOf(error);
    throw new EpubNotAddedError(`“${name}” could not be read as an EPUB: ${reason}`);
  }
  try {
    return opened.metadata;
  } finally {
    opened.close();
  }
}
