export {
  createVaultPath,
  joinVaultPath,
  parentVaultPath,
  vaultPathDepth,
  vaultPathName,
  vaultPathSegments,
  InvalidVaultPathError,
  VAULT_ROOT,
} from './vault-path.ts';
export type { VaultPath } from './vault-path.ts';
export { isMarkdownFile, noteTitle } from './vault-entry.ts';
export type { VaultDirectory, VaultEntry, VaultFile } from './vault-entry.ts';
export {
  ATLAS_DIRECTORY,
  isAtlasNote,
  templateEditRefusal,
  isSkillPath,
  isSystemFolder,
  isTemplateNote,
  isUserSpaceNote,
  isVisibleEntry,
  SKILLS_DIRECTORY,
  TEMPLATES_DIRECTORY,
  userSpaceNoteSql,
  TYPES_DIRECTORY,
  VIEWS_DIRECTORY,
  DASHBOARDS_DIRECTORY,
  SOURCES_DIRECTORY,
  AUTOMATIONS_DIRECTORY,
  HIDDEN_DIRECTORY_NAMES,
  isWithinWalk,
  VAULT_WALK_DEPTH,
} from './vault-visibility.ts';
export { fitFileNameStem, MAX_NAME_BYTES, utf8Bytes } from './file-name-bytes.ts';
export { compareNames } from './name-order.ts';
export { foldedVaultPath, vaultSpellingOf } from './vault-spelling.ts';
export { flattenVaultTree, sortVaultEntries } from './vault-tree.ts';
export type { VaultTreeRow, VaultTreeState } from './vault-tree.ts';
export {
  cleanEntryName,
  DEFAULT_FOLDER_NAME,
  DEFAULT_NOTE_NAME,
  nextAvailableFolderPath,
  isUnnamed,
  NEW_NOTE_CONTENTS,
  nextAvailableNotePath,
  NUMBERED_NOTE_ENDING,
  noteFileName,
  TakenNotePaths,
} from './new-note.ts';
export {
  deleteRefusal,
  deleteThroughLinkRefusal,
  linksGoAsLinks,
  landingRefusal,
  isMovable,
  isWithin,
  moveDestination,
  movedPath,
  moveIntoLinkRefusal,
  moveRefusal,
  moveRepointsLinkRefusal,
  moveTargets,
  moveThroughLinkRefusal,
  nameClashes,
  newFolderRefusal,
  notesUnder,
  renameRefusal,
  unsavedThroughLinkRefusal,
} from './vault-moves.ts';
export type { EntryMove, MovableEntry, NameClash } from './vault-moves.ts';
export { newNoteFolder } from './new-note-folder.ts';
export { compileNotesOnDayQuery, isNamedForDay, NOTE_DAY_KEY } from './notes-on-day.ts';
export { nearestNotePaths, NEAREST_NOTE_PATHS } from './nearest-note-paths.ts';
export { writeUndo } from './write-undo.ts';
export type { WriteRecord, WriteUndo } from './write-undo.ts';
export { newVaultId, vaultIdOf, VAULT_ID_KEY } from './vault-id.ts';
export type { VaultIdReading } from './vault-id.ts';
export {
  HELD_REFUSAL,
  heldBinaryWrite,
  heldChildren,
  heldEntryPathRefusal,
  heldFileRefusal,
  heldFilesWithExtension,
  heldMove,
  heldNameLike,
  heldPathRefusal,
  heldPlaceRefusal,
  heldTrash,
  heldUnder,
  heldWalk,
  isHeld,
  isHeldFolder,
  isHeldNote,
  MAX_HELD_BINARY_BYTES,
} from './held-vault.ts';
export type {
  BinaryWriteAsked,
  HeldBinaryWrite,
  HeldChild,
  HeldEntries,
  HeldMove,
  HeldVault,
  Refused,
} from './held-vault.ts';
