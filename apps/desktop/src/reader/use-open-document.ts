import { useEffect, useState } from 'react';
import type { VaultPath } from '@dfai/domain';
import type { VaultFsPort } from '@dfai/application';

/*
 * The document a reader tab shows (#504, #505), open for as long as the tab
 * is: a PDF held by pdf.js in its worker, or a book held by foliate-js with
 * the addresses its pictures are shown from. Either is a thing to let go of
 * rather than a read to keep in the query cache (ADR-0040): it is opened when
 * the tab shows the file and closed when the tab goes or moves to another file.
 */

export type OpenDocument<D> =
  | { readonly state: 'opening' }
  | { readonly state: 'open'; readonly opened: D; readonly generation: number }
  | { readonly state: 'failed'; readonly message: string };

let generations = 0;

export function useOpenDocument<D extends { close(): unknown }>({
  fs,
  reader,
  path,
  failure = (error) => `${path} could not be opened: ${messageOf(error)}`,
}: {
  fs: Pick<VaultFsPort, 'readBinaryFile'>;
  reader: { open(bytes: Uint8Array): Promise<D> };
  path: VaultPath;
  /** What the tab says when the file cannot be opened. */
  failure?: (error: unknown) => string;
}): OpenDocument<D> {
  const [open, setOpen] = useState<OpenDocument<D>>({ state: 'opening' });
  // Read when a file fails, never a reason to open it again.
  const [describe] = useState(() => failure);
  useEffect(() => {
    let live = true;
    let holding: D | null = null;
    setOpen({ state: 'opening' });
    fs.readBinaryFile(path)
      .then((bytes) => reader.open(new Uint8Array(bytes)))
      .then(
        (opened) => {
          holding = opened;
          if (!live) return void letGo(opened);
          generations += 1;
          setOpen({ state: 'open', opened, generation: generations });
        },
        (error: unknown) => live && setOpen({ state: 'failed', message: describe(error) }),
      );
    return () => {
      live = false;
      if (holding !== null) letGo(holding);
    };
  }, [fs, reader, path, describe]);
  return open;
}

/** Closes a document; a failure there leaves nothing to tidy. */
function letGo(document: { close(): unknown }): void {
  try {
    void Promise.resolve(document.close()).catch(() => undefined);
  } catch {
    // A close that throws at once is as spent as one that fails later.
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
