import type { ArtifactFileInput } from '@dfai/domain';

/**
 * Files the webview handed over — dropped, or picked one by one or as a
 * folder — as names and bytes. A folder's files keep their place in it
 * (`webkitRelativePath`), so `site/css/app.css` stays under `css/`.
 */
export async function pickedFiles(files: readonly File[]): Promise<ArtifactFileInput[]> {
  return Promise.all(
    files.map(async (file) => ({
      // Empty for a file picked alone — and missing where the engine has no
      // folder picker at all, which `||` covers as well.
      name: file.webkitRelativePath || file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    })),
  );
}

/** The text of the first page among the files, for guessing what they are; null when none is. */
export async function pageTextOf(files: readonly File[]): Promise<string | null> {
  const page = files.find((file) => /\.html?$/i.test(file.name));
  return page === undefined ? null : page.text();
}

/** A page's file name without its extension, as a first guess at a title. */
export function titleFromFiles(files: readonly File[]): string {
  const page = files.find((file) => /\.html?$/i.test(file.name));
  const name = page?.name.replace(/\.html?$/i, '') ?? '';
  return name.toLowerCase() === 'index' ? '' : name;
}
