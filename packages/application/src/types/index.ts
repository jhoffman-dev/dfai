export { loadObjectTypes, loadTypeListing, noteTypeName, TYPES_FOLDER } from './load-types.ts';
export type { BrokenType, DefinedType, TypeListing } from './load-types.ts';
export { addTypeProperty, createObjectType, saveObjectType } from './edit-types.ts';
export type { NewTypeProperty } from './edit-types.ts';
export { countValuesThatWontFit, migrateNotes, notesToMigrate } from './migrate-notes.ts';
export type { MigrationReport } from './migrate-notes.ts';
export {
  findDailyTemplate,
  findTaskTemplate,
  findTemplateNamed,
  findTypeTemplate,
  loadTemplates,
  readTemplate,
  templateNoteName,
  TEMPLATES_FOLDER,
} from './templates.ts';
export type { NoteTemplate } from './templates.ts';
export {
  createTemplate,
  deleteTemplate,
  ensureTypeTemplate,
  loadTemplateCatalog,
  templateCatalogOf,
  moveTemplateToNotes,
  renameTemplate,
  TemplateRefusedError,
} from './manage-templates.ts';
export type { TemplateCatalog, TemplateRow } from './manage-templates.ts';
export { createNoteOfType } from './new-note-of-type.ts';
export { acceptTypeSetup, ensureBuiltInTypes } from './ensure-built-in-types.ts';
export type {
  BuiltInTypesEnsured,
  PendingTypeExtension,
  TypeSetupFailure,
  TypeSetupOffer,
} from './ensure-built-in-types.ts';
export type {
  ShippedPropertiesAdded,
  ShippedPropertiesFailure,
  ShippedPropertiesGained,
  ShippedPropertiesSkipped,
} from './add-shipped-properties.ts';
export { linkedTypeProblems } from './linked-types.ts';
