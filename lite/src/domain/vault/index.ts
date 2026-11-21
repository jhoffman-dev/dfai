export {
  VAULT_ROOT,
  fileNameOf,
  folderOf,
  foldedPath,
  isNotePath,
  isWithin,
  joinPath,
  noteTitle,
  pathAfterMove,
  pathDepth,
  withoutExtension,
  type PathMove,
  type VaultPath,
} from './note-path.ts';
export {
  MAX_NAME_LENGTH,
  cleanNoteName,
  forbiddenCharacter,
  noteNameProblem,
} from './file-name.ts';
export { APP_FOLDER, INDEX_FOLDER, isHiddenPath, isVisibleNote } from './visibility.ts';
export { DEFAULT_NOTE_NAME, INBOX_FOLDER, uniqueNotePath } from './new-note.ts';
export {
  buildFolderTree,
  compareNames,
  flattenFolderTree,
  type FolderNode,
  type TreeRow,
} from './folder-tree.ts';
