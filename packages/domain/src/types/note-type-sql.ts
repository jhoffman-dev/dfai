/**
 * A note's `type` as the index matches it: in any case and spacing, so a note
 * that says `type: Task` is a task wherever notes are found by type — a
 * query's FROM, the sidebar's counts, a relation's picker, the Today page
 * (follow-up to #110). The stored side is folded in SQL; a name compared with
 * it is folded with {@link foldedTypeName}. Type names are ASCII identifiers,
 * which JavaScript and SQLite fold alike.
 */
export function foldedTypeSql(column: string): string {
  return `lower(trim(${column}))`;
}

/** A type's name as {@link foldedTypeSql} compares it. */
export function foldedTypeName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * The index every read of a note's type is sought through: the type folded as
 * {@link foldedTypeSql} folds it, after the key and before the note. The one
 * text of it: index.rs's schema holds it word for word and the e2e host makes
 * it from here, which `type-index.plan.sqlite.test.ts` holds them to.
 */
export const PROPS_TYPE_FOLD_INDEX =
  'CREATE INDEX IF NOT EXISTS props_type_fold ON props(key, lower(trim(value_text)), path)';
