// File-system helpers the tools share. Plain Node, no dependencies, erasable
// TypeScript only, so `node tools/<tool>.ts` runs them as they are.
import { mkdir, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

/** Folders never read as part of a vault. */
const SKIPPED_FOLDERS = new Set(['.git', 'node_modules', '_index']);

/** A file found under a folder: its path from that folder, `/`-separated, and where it is on disk. */
export interface FoundFile {
  readonly path: string;
  readonly absolute: string;
}

/** Every file under `root`, sorted by path, skipping `.git`, `node_modules`, `_index` and `skip`. */
export async function listFiles(
  root: string,
  skip: ReadonlySet<string> = SKIPPED_FOLDERS,
): Promise<FoundFile[]> {
  const found: FoundFile[] = [];
  const walk = async (folder: string): Promise<void> => {
    const entries = await readdir(folder, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(folder, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) await walk(absolute);
      } else if (entry.isFile()) {
        found.push({ path: relative(root, absolute).split(sep).join('/'), absolute });
      }
    }
  };
  await walk(root);
  return found.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

/**
 * Every markdown file under `root` with its text, leaving out dot folders
 * unread: the index ignores them, and the Action checks the writer out into one.
 */
export async function readMarkdown(root: string): Promise<{ path: string; text: string }[]> {
  const files = (await listFiles(root)).filter(
    ({ path }) =>
      path.toLowerCase().endsWith('.md') && !path.split('/').some((part) => part.startsWith('.')),
  );
  return Promise.all(
    files.map(async ({ path, absolute }) => ({ path, text: await readFile(absolute, 'utf8') })),
  );
}

/** Writes `text` to `root/path`, making its folders; false when the file already held exactly that. */
export async function writeIfChanged(root: string, path: string, text: string): Promise<boolean> {
  const absolute = join(root, ...path.split('/'));
  const current = await readFile(absolute, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (current === text) return false;
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, text, 'utf8');
  return true;
}

/** Deletes `root/path`, then each folder it leaves empty, up to (not including) `stopAt`. */
export async function removeFile(root: string, path: string, stopAt: string): Promise<void> {
  await rm(join(root, ...path.split('/')));
  let folder = dirname(path);
  while (folder !== '.' && folder !== stopAt) {
    const left = await readdir(join(root, ...folder.split('/')));
    if (left.length > 0) return;
    await rmdir(join(root, ...folder.split('/')));
    folder = dirname(folder);
  }
}
