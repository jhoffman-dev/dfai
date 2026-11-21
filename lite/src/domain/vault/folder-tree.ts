import { fileNameOf, joinPath, noteTitle, VAULT_ROOT, type VaultPath } from './note-path.ts';
import { isVisibleNote } from './visibility.ts';

/** A folder in the tree, with what is directly in it, each list in display order. */
export interface FolderNode {
  readonly path: VaultPath;
  /** The folder's own name; empty for the root. */
  readonly name: string;
  readonly folders: readonly FolderNode[];
  readonly notes: readonly VaultPath[];
  /** Notes in it and in every folder under it. */
  readonly noteCount: number;
}

/** One visible row of the tree, flattened for a virtualised list. */
export type TreeRow =
  | {
      readonly kind: 'folder';
      readonly path: VaultPath;
      readonly name: string;
      readonly depth: number;
      readonly expanded: boolean;
      readonly noteCount: number;
    }
  | {
      readonly kind: 'note';
      readonly path: VaultPath;
      readonly name: string;
      readonly depth: number;
    };

/** Names as Finder orders them: case aside, and `Note 2` before `Note 10`. */
const NAMES = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Orders two names for display, falling back to code order so the order is total. */
export function compareNames(left: string, right: string): number {
  return NAMES.compare(left, right) || (left < right ? -1 : left > right ? 1 : 0);
}

interface Building {
  path: VaultPath;
  folders: Map<string, Building>;
  notes: VaultPath[];
}

/**
 * The folder tree of a flat list of paths, as git holds a vault: folders are
 * the ones notes are in, since git has no empty folder. Hidden paths and
 * files that are not notes are left out.
 */
export function buildFolderTree(paths: Iterable<VaultPath>): FolderNode {
  const root: Building = { path: VAULT_ROOT, folders: new Map(), notes: [] };
  for (const path of paths) {
    if (!isVisibleNote(path)) continue;
    let folder = root;
    const parts = path.split('/');
    for (const part of parts.slice(0, -1)) {
      let next = folder.folders.get(part);
      if (next === undefined) {
        next = { path: joinPath(folder.path, part), folders: new Map(), notes: [] };
        folder.folders.set(part, next);
      }
      folder = next;
    }
    folder.notes.push(path);
  }
  return finish(root);
}

function finish(folder: Building): FolderNode {
  const folders = [...folder.folders.values()]
    .map(finish)
    .sort((left, right) => compareNames(left.name, right.name));
  const notes = [...folder.notes].sort((left, right) =>
    compareNames(noteTitle(left), noteTitle(right)),
  );
  const noteCount = notes.length + folders.reduce((sum, child) => sum + child.noteCount, 0);
  return { path: folder.path, name: fileNameOf(folder.path), folders, notes, noteCount };
}

/**
 * The rows a tree shows: folders before notes at each level, and only the
 * contents of expanded folders, so the cost follows what is on screen.
 */
export function flattenFolderTree(root: FolderNode, expanded: ReadonlySet<VaultPath>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (folder: FolderNode, depth: number): void => {
    for (const child of folder.folders) {
      const open = expanded.has(child.path);
      rows.push({
        kind: 'folder',
        path: child.path,
        name: child.name,
        depth,
        expanded: open,
        noteCount: child.noteCount,
      });
      if (open) walk(child, depth + 1);
    }
    for (const path of folder.notes)
      rows.push({ kind: 'note', path, name: noteTitle(path), depth });
  };
  walk(root, 0);
  return rows;
}
