/**
 * Reading an image the client names by its path on this computer.
 *
 * This server runs as the user, with the user's whole disk, and the client
 * asking may have no file access of its own (Claude Desktop) — or may be
 * steered by text a web page planted. Whatever the server reads, the client
 * gains. So it reads only what is plainly a picture the user put somewhere
 * pictures go: a file under one of the image folders (resolved through any
 * link), whose own extension is an image kind, whose bytes are that kind, and
 * no larger than DFAI takes. Anything else is one answer that says nothing
 * about whether the file is there.
 *
 * DFAI checks the image again as it arrives; this is the check on what the
 * server itself is willing to read. It cannot use DFAI's own rules — the
 * server may import only the API's types — so it keeps the few it needs here.
 */

import { open, realpath, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, extname, isAbsolute, join, sep } from 'node:path';
import type { ApiMaxImageBytes } from '@dfai/application';
import { AtlasCallError } from './client.ts';

/** Settings → Images' limit, 20 MiB, as DFAI sets it; the type fails the build if they drift. */
export const MAX_IMAGE_BYTES: ApiMaxImageBytes = 20_971_520;

/** The environment variable naming the folders images may be read from. */
export const IMAGE_DIRS_VARIABLE = 'ATLAS_MCP_IMAGE_DIRS';

/** Where images are read from unless the variable says otherwise. */
export function defaultImageFolders(): string[] {
  const home = homedir();
  return [join(home, 'Desktop'), join(home, 'Downloads'), join(home, 'Pictures'), tmpdir()];
}

/** The folders images may be read from: the variable's, split like PATH, or the defaults. */
export function imageFolders(env: NodeJS.ProcessEnv = process.env): string[] {
  const named = (env[IMAGE_DIRS_VARIABLE] ?? '')
    .split(delimiter)
    .map((folder) => folder.trim())
    .filter((folder) => folder !== '');
  return named.length > 0 ? named : defaultImageFolders();
}

/** The image kinds a note takes, each with how its bytes start. */
const KINDS: Readonly<Record<string, (head: Buffer) => boolean>> = {
  png: (head) => head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])),
  jpg: (head) => head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  jpeg: (head) => head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  gif: (head) => ['GIF87a', 'GIF89a'].includes(head.toString('latin1', 0, 6)),
  webp: (head) =>
    head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP',
  heic: isHeif,
  heif: isHeif,
  // Markup whose root, past a prolog, is <svg>; DFAI checks the rest of it.
  svg: (head) => /^\uFEFF?\s*(?:<[?!][^>]*>\s*)*<svg[\s/>]/.test(head.toString('utf8', 0, 1024)),
};

function isHeif(head: Buffer): boolean {
  return head.toString('latin1', 4, 8) === 'ftyp';
}

/** A file's image kind by its extension, lower case, or null when it is not one. */
export function imageKindOf(name: string): string | null {
  const kind = extname(name).slice(1).toLowerCase();
  return kind in KINDS ? kind : null;
}

/** Whether two kinds are one: `.jpg` and `.jpeg` are the same picture. */
export function sameKind(left: string, right: string): boolean {
  const canonical = (kind: string) => (kind === 'jpeg' ? 'jpg' : kind);
  return canonical(left) === canonical(right);
}

/** The bytes of the image at `file`, or one refusal that does not say why. */
export async function readLocalImage(
  file: string,
  folders: readonly string[] = imageFolders(),
  maxBytes: number = MAX_IMAGE_BYTES,
): Promise<Buffer> {
  const refused = new AtlasCallError(
    `${file} is not an image this server may read. It reads PNG, JPEG, GIF, WebP, SVG and ` +
      `HEIC files in ${folders.join(', ')} (${IMAGE_DIRS_VARIABLE} changes the folders).`,
  );
  const kind = imageKindOf(file);
  if (!isAbsolute(file) || kind === null) throw refused;

  const real = await realpath(file).catch(() => null);
  if (real === null || imageKindOf(real) !== kind || !(await isInside(real, folders))) {
    throw refused;
  }
  // Stat before opening: opening a named pipe would wait for a writer forever.
  const found = await stat(real).catch(() => null);
  if (found === null || !found.isFile()) throw refused;
  if (found.size > maxBytes) {
    throw new AtlasCallError(`${file} is larger than the 20 MB an image in a note can be.`);
  }
  const handle = await open(real, 'r').catch(() => null);
  if (handle === null) throw refused;
  try {
    // Swapped for something else between the stat and the open.
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== found.ino) throw refused;
    const bytes = await handle.readFile();
    // Read from the handle stat measured, so a file grown since is still caught.
    if (bytes.byteLength > maxBytes || !(KINDS[kind]?.(bytes) ?? false)) throw refused;
    return bytes;
  } finally {
    await handle.close();
  }
}

/** Whether `real` is inside one of `folders`, each resolved through its own links. */
async function isInside(real: string, folders: readonly string[]): Promise<boolean> {
  for (const folder of folders) {
    const root = await realpath(folder).catch(() => null);
    if (root !== null && real.startsWith(root.endsWith(sep) ? root : root + sep)) return true;
  }
  return false;
}
