import { ARTIFACT_THUMBNAIL, isThumbnailName } from './artifact-thumbnail.ts';

/*
 * Which files a saved copy may hold, and where inside its folder they may go.
 *
 * A copy is written from outside the app — a dropped folder, a Claude session
 * over the local API — so every name is checked here before anything touches
 * the disk: relative, inside the copy's folder, nothing hidden, and only the
 * kinds of file a web page is made of. Markdown is deliberately not one of
 * them, so nothing in a copy is ever taken for a note.
 */

/** The page a copy opens on. */
export const ARTIFACT_ENTRY = 'index.html';

/** What each allowed extension is served as. */
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  woff2: 'font/woff2',
};

/** The extensions a copy may hold, for saying so in a refusal. */
export const ARTIFACT_FILE_EXTENSIONS: readonly string[] = Object.keys(MEDIA_TYPES);

const TEXT_EXTENSIONS = new Set(['html', 'htm', 'css', 'js', 'json', 'svg']);

/**
 * The largest file a copy may hold, 32 MiB: what the host will read back to
 * show it. Written as a literal so its type is the number itself, which the API
 * contract hands to clients that keep their own copy (ApiMaxArtifactFileBytes).
 */
export const MAX_ARTIFACT_FILE_BYTES = 33_554_432;

/** How many files one copy may hold. */
export const MAX_ARTIFACT_FILES = 200;

/** How deep inside the copy's folder a file may sit: `assets/img/logo.png` is three. */
const MAX_DEPTH = 4;
const MAX_NAME_LENGTH = 200;

function extensionOf(name: string): string {
  const last = name.split('/').at(-1) ?? '';
  const dot = last.lastIndexOf('.');
  return dot <= 0 ? '' : last.slice(dot + 1).toLowerCase();
}

/** What a file in a copy is served as; `application/octet-stream` for anything else. */
export function artifactMediaType(name: string): string {
  return MEDIA_TYPES[extensionOf(name)] ?? 'application/octet-stream';
}

export function isArtifactTextFile(name: string): boolean {
  return TEXT_EXTENSIONS.has(extensionOf(name));
}

export function isArtifactPage(name: string): boolean {
  const extension = extensionOf(name);
  return extension === 'html' || extension === 'htm';
}

/**
 * Why a name cannot be a file in a copy, or null when it can.
 *
 * The name is relative to the copy's folder, with `/` between folders. Refused:
 * an empty or absolute name, a backslash, a control character, `.` or `..`, an
 * empty or hidden segment, more than four levels, any extension not in
 * `ARTIFACT_FILE_EXTENSIONS`, and the name DFAI keeps for the copy's
 * thumbnail, which a file of the page's own must never take.
 */
export function artifactFileRefusal(name: string): string | null {
  if (name === '') return 'a file needs a name';
  if (name.length > MAX_NAME_LENGTH) return `a file name is at most ${MAX_NAME_LENGTH} characters`;
  if (name.startsWith('/')) return 'a file name must be relative to the artifact';
  // Checked apart from the segments: a backslash is a separator on Windows, and
  // `..\x` would be one harmless-looking segment here and an escape there.
  if (/[\\\p{Cc}]/u.test(name)) return 'a file name cannot hold a backslash or a control character';

  const segments = name.split('/');
  if (segments.length > MAX_DEPTH) return `a file sits at most ${MAX_DEPTH} folders deep`;
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return 'a file name cannot leave the artifact’s folder';
  }
  if (segments.some((segment) => segment.startsWith('.'))) return 'a file cannot be hidden';
  if (!(extensionOf(name) in MEDIA_TYPES)) {
    return `only ${ARTIFACT_FILE_EXTENSIONS.join(', ')} files can be saved`;
  }
  if (isThumbnailName(name)) return `${ARTIFACT_THUMBNAIL} is kept for the thumbnail DFAI makes`;
  return null;
}

/** A file on its way into a copy. */
export interface ArtifactFileInput {
  /** Relative to the copy's folder, or to wherever it was picked from. */
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** What will be written, and what was left behind and why. */
export interface ArtifactCopyPlan {
  readonly files: readonly ArtifactFileInput[];
  readonly skipped: readonly { readonly name: string; readonly reason: string }[];
}

/**
 * What a set of picked or dropped files becomes as a copy.
 *
 * A folder picked whole arrives as `folder/index.html`, `folder/app.css`; the
 * one folder they share is taken off, so the copy holds `index.html`. A page
 * that is not called `index.html` becomes it when it is the only page at the
 * top. Files that cannot be in a copy — a `.DS_Store`, a README — are skipped
 * and named, rather than failing the rest. Null when no page is left to open.
 */
export function artifactCopyPlan(inputs: readonly ArtifactFileInput[]): ArtifactCopyPlan | null {
  const stripped = withoutSharedFolder(inputs);
  const skipped: { name: string; reason: string }[] = [];
  const kept: ArtifactFileInput[] = [];
  for (const file of stripped) {
    const reason = artifactFileRefusal(file.name) ?? sizeRefusal(file);
    if (reason === null && kept.length < MAX_ARTIFACT_FILES) kept.push(file);
    else
      skipped.push({
        name: file.name,
        reason: reason ?? `a copy holds at most ${MAX_ARTIFACT_FILES} files`,
      });
  }
  const files = withEntryPage(kept);
  return files === null ? null : { files, skipped };
}

function sizeRefusal(file: ArtifactFileInput): string | null {
  return file.bytes.byteLength > MAX_ARTIFACT_FILE_BYTES
    ? `a file is at most ${MAX_ARTIFACT_FILE_BYTES / 1024 / 1024} MB`
    : null;
}

function withoutSharedFolder(inputs: readonly ArtifactFileInput[]): ArtifactFileInput[] {
  const firsts = new Set(
    inputs.map((file) => (file.name.includes('/') ? file.name.split('/')[0] : null)),
  );
  const [shared] = [...firsts];
  if (firsts.size !== 1 || shared === null || shared === undefined) return [...inputs];
  return inputs.map((file) => ({ ...file, name: file.name.slice(shared.length + 1) }));
}

function withEntryPage(files: ArtifactFileInput[]): ArtifactFileInput[] | null {
  if (files.some((file) => file.name === ARTIFACT_ENTRY)) return files;
  const topPages = files.filter((file) => !file.name.includes('/') && isArtifactPage(file.name));
  const [page] = topPages;
  if (topPages.length !== 1 || page === undefined) return null;
  return files.map((file) => (file === page ? { ...file, name: ARTIFACT_ENTRY } : file));
}
