export {
  objectTypeProblems,
  parseObjectType,
  InvalidTypeError,
  PROPERTY_KINDS,
  relationTypes,
  relationTypesText,
} from './property-def.ts';
export type { ObjectType, PropertyDef, PropertyKind } from './property-def.ts';
export {
  isEmptyProperty,
  isWikiLink,
  relationTargets,
  relationTypeRefusal,
  requiredApplies,
  validatePropertyValue,
} from './property-value.ts';
export { combinedExtensions, inboxTypePlan, typeGainingKeys } from './inbox-setup.ts';
export type { InboxTypePlan } from './inbox-setup.ts';
export { hasOpenQuote, listAsInput, listFromInput } from './list-input.ts';
export { listEditText, listFromEditText } from './list-edit.ts';
export { linkedNotes, withLink, withoutLink } from './relation-links.ts';
export { objectTypeIcon, TYPE_ICONS } from './type-icon.ts';
export {
  freePropertyKey,
  isViewColumn,
  propertyKeyProblem,
  slugifyName,
  typeNameProblem,
} from './type-name.ts';
export {
  addOption,
  applyTypeEdit,
  addProperty,
  changePropertyKind,
  manyOf,
  moveOption,
  moveProperty,
  NEW_PROPERTY_LABEL,
  newObjectType,
  removeOption,
  removeProperty,
  renameOption,
  renameProperty,
  setDoneOption,
  setOptionColor,
  setPropertyMany,
  setPropertyRequired,
  setRelation,
  setTypeIcon,
  setTypeLabel,
  TypeEditError,
} from './type-edit.ts';
export type { TypeChange, TypeEdit } from './type-edit.ts';
export {
  newTypeFrontmatter,
  propertySpec,
  typeFrontmatter,
  typeFrontmatterChanges,
} from './type-frontmatter.ts';
export { holdsTypeValues, migrationChanges, valuesThatWontFit } from './note-migration.ts';
export type { NoteMigration } from './note-migration.ts';
export { isDoneValue, statusOf, statusToRemember, untickedValue } from './status-property.ts';
export type { StatusProperty } from './status-property.ts';
export { holdsLinks, linkedNames, noteNames, withNoteNames } from './relation-names.ts';
export type { LinkedName, NamedNote, NoteNames } from './relation-names.ts';
export {
  declaredTypeName,
  isBuiltInType,
  isBuiltInTypeFile,
  typeDeleteRefusal,
} from './built-in-types.ts';
export {
  ARCHIVED_PARA,
  AREA_PROPERTY,
  AREA_TYPE,
  builtInTypePlan,
  DEFAULT_PARA,
  extensionKeys,
  extensionWithin,
  FILED_UNDER,
  FILED_UNDER_KEY,
  FILED_UNDER_TYPES,
  PARA_BEFORE_ARCHIVE_KEY,
  PARA_KEY,
  PARA_PROPERTY,
  PARA_TYPE_FILES,
  PARA_VALUES,
  PROJECT_TYPE,
  PROJECT_TYPE_FILE,
  RESOURCE_TYPE,
  typeSetupLines,
} from './para.ts';
export type { BuiltInTypeFile, BuiltInTypePlan, ParaValue, TypeExtension } from './para.ts';
export {
  archivesWhereItStands,
  compileParaValuesQuery,
  holdsOwnPara,
  isParaArchived,
  isParaNote,
  isParaTarget,
  outsideParaArchiveSql,
  PARA_VALUES_QUERY_COLUMNS,
  PARA_VALUES_QUERY_MARK,
  paraArchiveChanges,
  paraArchivedSql,
  paraChoices,
  paraDefaultFor,
  paraFiledUnderSql,
  paraOf,
  paraProjectSql,
  paraValueNamed,
  paraValuesTargeted,
  relatedNoteKind,
  paraUnarchiveChanges,
  relationGroupLabel,
  vaultProjectTypeName,
} from './para-value.ts';
export type { ParaChoice } from './para-value.ts';
export {
  compileParaCandidatesQuery,
  PARA_CANDIDATES_QUERY_MARK,
  paraMigrationLine,
  paraMoveLine,
  paraMoveRefusal,
  paraNoteMove,
  paraSkipLine,
} from './para-migration.ts';
export type { ParaNoteMove } from './para-migration.ts';
export {
  addablePropertyKeys,
  declaredPropertyKeys,
  keysRecorded,
  keysRecordedForType,
  NO_SHIPPED_PROPERTIES_RECORD,
  parseShippedPropertiesRecord,
  PROPERTIES_NOT_A_MAP,
  PROPERTIES_NOT_ADDABLE_AS_LINES,
  recordSettling,
  SHIPPED_PROPERTIES_RECORD_PATH,
  ShippedPropertiesRecordError,
  mergeShippedPropertiesRecords,
  SHIPPED_PROPERTIES,
  shippedPropertiesLine,
  shippedPropertiesPlan,
  shippedPropertiesRecordText,
  shippedPropertiesSkippedLine,
} from './shipped-properties.ts';
export type {
  ShippedCatalogue,
  ShippedPropertiesChange,
  ShippedPropertiesPlan,
  ShippedPropertiesRecord,
  ShippedPropertiesSkip,
} from './shipped-properties.ts';
export { foldedTypeName, foldedTypeSql, PROPS_TYPE_FOLD_INDEX } from './note-type-sql.ts';
