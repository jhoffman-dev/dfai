import type { ZipFiles } from './browser-export-files.ts';

/**
 * fflate's zip writer (#774), fetched the first time an export needs a zip:
 * the library is a chunk of its own, not in the page that starts. Stored,
 * not compressed: pictures are compressed already, and a note is small.
 */
export async function loadZipFiles(): Promise<ZipFiles> {
  const { zipSync } = await import('fflate');
  return (files) => zipSync(files, { level: 0 });
}
