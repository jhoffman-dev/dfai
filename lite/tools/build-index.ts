// Writes `_index/` for a vault folder: `node tools/build-index.ts <vault dir>`.
// It is what the vault's GitHub Action runs, so it has no dependencies and
// uses only TypeScript that Node can strip (no enums, no parameter properties).
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INDEX_ROOT, buildAiIndex } from '../src/domain/ai-index/index.ts';
import { isVisibleNote } from '../src/domain/vault/index.ts';
import { listFiles, readMarkdown, removeFile, writeIfChanged } from './vault-files.ts';

export interface IndexRun {
  readonly notes: number;
  readonly files: number;
  readonly written: number;
  readonly removed: number;
}

/** Regenerates `<vault>/_index/`: writes what changed, deletes what the index no longer has. */
export async function buildIndex(vault: string): Promise<IndexRun> {
  const notes = await readMarkdown(vault);
  const files = buildAiIndex(notes);
  let written = 0;
  for (const { path, text } of files) {
    if (await writeIfChanged(vault, path, text)) written += 1;
  }
  const wanted = new Set(files.map(({ path }) => path));
  const indexFolder = resolve(vault, INDEX_ROOT);
  const existing = await listFiles(indexFolder, new Set()).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  let removed = 0;
  for (const { path } of existing) {
    const vaultPath = `${INDEX_ROOT}/${path}`;
    if (wanted.has(vaultPath)) continue;
    await removeFile(vault, vaultPath, INDEX_ROOT);
    removed += 1;
  }
  const indexed = notes.filter(({ path }) => isVisibleNote(path)).length;
  return { notes: indexed, files: files.length, written, removed };
}

/** The one line a run prints. */
export const runSummary = ({ notes, files, written, removed }: IndexRun): string =>
  `Indexed ${notes} notes into ${files} files in ${INDEX_ROOT}/: ${written} written, ${removed} removed.`;

async function main(args: readonly string[]): Promise<number> {
  const [vault] = args;
  if (vault === undefined || args.length !== 1) {
    console.error('Usage: node tools/build-index.ts <vault dir>');
    return 2;
  }
  const folder = await stat(vault).catch(() => null);
  if (folder === null || !folder.isDirectory()) {
    console.error(`Not a folder: ${vault}`);
    return 2;
  }
  console.log(runSummary(await buildIndex(vault)));
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
