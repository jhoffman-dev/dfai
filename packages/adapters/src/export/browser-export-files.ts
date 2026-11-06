import type { DestinationRequest, ExportDestination, ExportFilesPort } from '@dfai/application';
import { SHARED_ATTACHMENTS_FOLDER } from '@dfai/domain';
import type { BrowserDownload } from './browser-download.ts';

/** Packs files into a zip: the path inside it, and the bytes there. */
export type ZipFiles = (files: Readonly<Record<string, Uint8Array>>) => Uint8Array;

export interface BrowserExportFilesDeps {
  readonly download: BrowserDownload;
  /** Loaded on the first export that needs a zip, so the library is not in the page until then. */
  readonly loadZip: () => Promise<ZipFiles>;
}

/** One destination, held until it is finished: what it was asked as, and each file written to it. */
interface Pending {
  readonly request: DestinationRequest;
  readonly destination: ExportDestination;
  readonly files: Map<string, Uint8Array>;
}

const MARKDOWN = 'text/markdown;charset=utf-8';
const ZIP = 'application/zip';

/**
 * Where an export goes in a browser (#774): a download. A browser asks for
 * no place, so `choose` names the download at once; the files written are
 * held, and finishing hands them over — one note alone as its `.md` file,
 * anything with pictures or several notes as a `.zip`, its pictures in
 * `attachments/`. A discarded export downloads nothing.
 */
export function browserExportFiles({ download, loadZip }: BrowserExportFilesDeps): ExportFilesPort {
  const pending = new Map<string, Pending>();
  let made = 0;
  return {
    choose(request) {
      made += 1;
      const destination = destinationFor(request, `download-${made}`);
      pending.set(destination.id, { request, destination, files: new Map() });
      return Promise.resolve(destination);
    },
    async write({ destination, path, bytes }) {
      const held = pending.get(destination.id);
      if (held === undefined) throw new Error('This export is already finished.');
      if (held.files.has(path)) throw new Error(`“${path}” was written twice.`);
      held.files.set(checkedPath(path), bytes.slice());
    },
    async finish({ id }, { discard }) {
      const held = pending.get(id);
      pending.delete(id);
      if (held === undefined || discard) return;
      await download(await packed(held, loadZip));
    },
  };
}

/** The download a request becomes: a file alone keeps its name; anything more is a zip. */
function destinationFor(request: DestinationRequest, id: string): ExportDestination {
  if (request.kind === 'folder') {
    return { id, path: `${request.folderName}.zip`, companion: null };
  }
  if (request.companionSuffix === null) {
    return { id, path: request.suggestedName, companion: null };
  }
  return {
    id,
    path: `${stemOf(request.suggestedName, request.extension)}.zip`,
    companion: SHARED_ATTACHMENTS_FOLDER,
  };
}

const stemOf = (name: string, extension: string) =>
  name.endsWith(`.${extension}`) ? name.slice(0, -(extension.length + 1)) : name;

/** What the export wrote, as the one file handed over. */
async function packed(
  { request, destination, files }: Pending,
  loadZip: () => Promise<ZipFiles>,
): Promise<{ name: string; type: string; bytes: Uint8Array }> {
  const alone = files.get('');
  if (destination.companion === null && request.kind === 'file') {
    if (alone === undefined || files.size !== 1) {
      throw new Error(`The export of ${destination.path} did not write its one file.`);
    }
    return { name: destination.path, type: MARKDOWN, bytes: alone };
  }
  const entries = Object.fromEntries(
    [...files].map(([path, bytes]) => [path === '' ? mainFileName(request) : path, bytes]),
  );
  const zip = await loadZip();
  return { name: destination.path, type: ZIP, bytes: zip(entries) };
}

/** The picked file's own name, for the note it is inside the zip. */
function mainFileName(request: DestinationRequest): string {
  if (request.kind === 'file') return request.suggestedName;
  throw new Error('A folder export names every file it writes.');
}

/**
 * A path inside the download, as the export names it: relative, with no
 * part that climbs out — so the zip unpacks only into its own folder.
 */
function checkedPath(path: string): string {
  const parts = path.split(/[\\/]/);
  if (path.startsWith('/') || parts.some((part) => part === '..' || part === '.')) {
    throw new Error(`“${path}” is not a path inside the export.`);
  }
  return path;
}
