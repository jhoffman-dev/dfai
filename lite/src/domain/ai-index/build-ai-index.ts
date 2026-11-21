import { VaultIndex } from '../index/index.ts';
import { isConflictCopyPath } from '../sync/index.ts';
import { isVisibleNote, type VaultPath } from '../vault/index.ts';
import { folderFiles } from './folder-files.ts';
import { meetingFiles } from './meeting-files.ts';
import { noteLine } from './note-line.ts';
import { readmeFile } from './readme-file.ts';
import { sortedTagTree, tagFile } from './tag-file.ts';
import { byCode, type IndexFile } from './text.ts';

/** The vault's own guides at its root: about the vault, not notes in it. */
const VAULT_GUIDES = new Set<VaultPath>(['CLAUDE.md', 'README.md']);

/**
 * The `_index/` files for a vault: a map Claude reads instead of the notes, so
 * it opens only the few that matter. Pure and deterministic — the same notes,
 * in any order, give the same files byte for byte, sorted by path. Hidden
 * paths (`_index/`, `.dfai-lite/`, dotfiles), non-markdown files and the
 * root `CLAUDE.md` and `README.md` are left out.
 */
export function buildAiIndex(notes: readonly IndexFile[]): readonly IndexFile[] {
  const visible = notes.filter(({ path }) => isVisibleNote(path) && !VAULT_GUIDES.has(path));
  const index = VaultIndex.build(visible);
  const texts = new Map<VaultPath, string>(visible.map(({ path, text }) => [path, text]));
  const paths = index.paths();
  const entries = paths.map((path) => ({ path, line: noteLine(index, path) }));
  const folders = folderFiles(entries);
  const meetings = meetingFiles(index, texts);
  const tags = sortedTagTree(index);
  const readme = readmeFile({
    total: paths.length,
    folders: folders.folders,
    months: meetings.months,
    tags,
    conflictCopies: paths.filter(isConflictCopyPath),
  });
  const files = [readme, ...folders.files, tagFile(index, tags), ...meetings.files];
  return files.sort((left, right) => byCode(left.path, right.path));
}
