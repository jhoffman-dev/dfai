/*
 * Where the build put each chunk loaded on first use, as `vite.config.ts`
 * writes it into index.html: `<meta name="atlas-chunks" content='{"graph-page":
 * "assets/graph-page-….js"}'>`. A development server writes none: it serves
 * each module fresh, so there is nothing to look up.
 */

const CHUNK_FILES_META = 'meta[name="atlas-chunks"]';

function chunkFiles(): Readonly<Record<string, string>> {
  const content = document.querySelector(CHUNK_FILES_META)?.getAttribute('content');
  if (content === null || content === undefined) return {};
  try {
    return JSON.parse(content) as Record<string, string>;
  } catch (cause) {
    // A broken map only costs the fresh copy: the chunk is then imported as usual.
    console.warn('The chunk map in index.html could not be read:', cause);
    return {};
  }
}

/** Where the chunk named `name` is, under a new address for `attempt`; null where it is not known. */
export function chunkAddress(name: string, attempt: number): string | null {
  const file = chunkFiles()[name];
  if (file === undefined) return null;
  const address = new URL(file, document.baseURI);
  address.searchParams.set('attempt', String(attempt));
  return address.href;
}

/**
 * Imports the chunk named `name` under a new address for each `attempt`. A
 * module that failed to parse or to run is kept failed by the browser under
 * its address, so importing it there again cannot succeed. Null where the
 * chunk's file is not known.
 */
export const importAgain =
  (name: string) =>
  (attempt: number): Promise<unknown> | null => {
    const address = chunkAddress(name, attempt);
    return address === null ? null : import(/* @vite-ignore */ address);
  };

/** Loads the whole window again: the way back when a chunk will not load in place. */
export const reloadWindow = (): void => window.location.reload();
