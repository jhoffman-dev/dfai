import { useCallback, useState } from 'react';
import {
  addEpubToLibrary,
  addPdfToLibrary,
  type AddedDocument,
  type PickedDocument,
  type VaultFsPort,
} from '@dfai/application';
import {
  libraryFolder,
  SOURCE_KIND_NAMES,
  type DocumentKind,
  type ObjectType,
  type VaultPath,
} from '@dfai/domain';

/*
 * Adding PDFs (#504) or EPUBs (#505) from the dialog: each file dropped or
 * picked is copied into the library and given its literature note, one
 * after another, and the first one added opens in its reader. The reader
 * that reads a document's title — pdf.js, foliate-js — is loaded only when
 * the first of its kind is added.
 */

export interface AddToLibraryState {
  readonly folder: VaultPath;
  readonly adding: boolean;
  readonly error: string | null;
  readonly add: (files: readonly File[]) => Promise<void>;
  readonly reset: () => void;
}

type Adder = (
  fs: VaultFsPort,
  args: { picked: PickedDocument; folder: VaultPath },
) => Promise<AddedDocument>;

/** Each kind's use-case, with its reader loaded on first use. */
const ADDERS: Readonly<Record<DocumentKind, () => Promise<Adder>>> = {
  pdf: async () => {
    const { appPdfReader } = await import('./app-pdf-reader.ts');
    return (fs, { picked, folder }) =>
      addPdfToLibrary({ fs, reader: appPdfReader }, { pdf: picked, folder });
  },
  epub: async () => {
    const { appEpubReader } = await import('./app-epub-reader.ts');
    return (fs, { picked, folder }) =>
      addEpubToLibrary({ fs, reader: appEpubReader }, { epub: picked, folder });
  },
};

export function useAddToLibrary({
  kind,
  fs,
  types,
  today,
  onAdded,
}: {
  kind: DocumentKind;
  fs: VaultFsPort;
  types: readonly Pick<ObjectType, 'name' | 'folder'>[];
  today: () => string;
  /**
   * Told of what was added once all of it is in, and whether every file was:
   * the tree is read again, and the first opened when nothing was refused.
   */
  onAdded: (outcome: { added: readonly AddedDocument[]; allAdded: boolean }) => void;
}): AddToLibraryState {
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const folder = libraryFolder({ types, today: today() });
  const add = useCallback(
    async (files: readonly File[]) => {
      setAdding(true);
      setError(null);
      const added: AddedDocument[] = [];
      const refused: string[] = [];
      try {
        // Loading the reader can fail (the chunk missing, a flaky disk): that is said, and the dialog is usable again.
        const addOne = await ADDERS[kind]();
        for (const file of files) {
          try {
            added.push(await addOne(fs, { picked: pickedDocument(file), folder }));
          } catch (failure) {
            refused.push(messageOf(failure));
          }
        }
      } catch (failure) {
        refused.push(
          `The ${SOURCE_KIND_NAMES[kind]} reader could not be loaded: ${messageOf(failure)}`,
        );
      } finally {
        setAdding(false);
      }
      setError(refused.length === 0 ? null : refused.join(' '));
      if (added.length > 0) onAdded({ added, allAdded: refused.length === 0 });
    },
    [kind, fs, folder, onAdded],
  );
  return { folder, adding, error, add, reset: () => setError(null) };
}

const pickedDocument = (file: File): PickedDocument => ({
  name: file.name,
  size: file.size,
  bytes: async () => new Uint8Array(await file.arrayBuffer()),
});

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
