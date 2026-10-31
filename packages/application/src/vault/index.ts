export { inVault, noVaultOpen } from './in-vault.ts';
export {
  createOwnWrites,
  isEchoOf,
  noteSavedThrough,
  OWN_WRITE_KEPT_MS,
  OWN_WRITES_KEPT,
} from './own-writes.ts';
export type { FoundVersion, LeftVersion, OwnWrites, PathInVault } from './own-writes.ts';
export { awaitsOwnRefresh, outsideChanges } from './outside-changes.ts';
export { recordingOwnWrites } from './recording-own-writes.ts';
export { openVault, restoreVault } from './open-vault.ts';
export { listVaultDirectory, listVaultNotes, readVaultFile } from './read-vault.ts';
export {
  EntryChangedError,
  HOST_CHANGED_ON_DISK,
  isChangedOnDiskRefusal,
  VaultAccessError,
} from './ports.ts';
export { createFolder, ensureFolder, listVaultFolders } from './create-folder.ts';
export { guardTemplateEdit, TemplateEditRefusedError } from './template-guard.ts';
export { moveEntryInto, moveEntryTo, renameEntry, MoveRefusedError } from './relocate-entry.ts';
export type { Relocation, RelocationPorts } from './relocate-entry.ts';
export { countOtherFiles, deleteEntry, previewDeletion } from './delete-entry.ts';
export { linksToUpdate, updateLinks, UnsavedTypingError } from './update-links.ts';
export type {
  LinkUpdate,
  LinkUpdateFailure,
  LinkUpdatePanes,
  LinkUpdateReport,
} from './update-links.ts';
export type { DeletionPreview, OtherFilesCount } from './delete-entry.ts';
export type {
  AsRead,
  HostVaultFsPort,
  OpenEditorsPort,
  NoteContents,
  NoteFile,
  NoteListing,
  VaultFsPort,
  VaultLocation,
  VaultLocationStore,
  VaultPickerPort,
  VaultWatchPort,
} from './ports.ts';
