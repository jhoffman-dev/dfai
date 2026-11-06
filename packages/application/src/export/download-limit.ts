import { ExportError } from './ports.ts';

/**
 * The most an export handed over as a browser download may hold, its notes
 * and pictures together (#779). A browser keeps it all in memory, then
 * again as the zip, so this stays well inside what an iPad's tab is allowed
 * before Safari reloads it.
 */
export const MAX_DOWNLOAD_EXPORT_BYTES = 200 * 1024 * 1024;

const sizeWords = (bytes: number) =>
  bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)} MB` : `${bytes} bytes`;

/** Refuses, in the person's words, a download whose files come to more than `limit` bytes. */
export function refuseOversizedDownload(
  totalBytes: number,
  limit: number = MAX_DOWNLOAD_EXPORT_BYTES,
): void {
  if (totalBytes <= limit) return;
  throw new ExportError(
    'too-large',
    `This export is too large to download here: its notes and pictures come to more than ${sizeWords(limit)}. Export fewer notes at once, or export on the Mac.`,
  );
}
