import { optionColorsByKey, type ObjectType } from '@dfai/domain';
import type { TableSchema } from '@dfai/ui';

/**
 * How a type heads and fills a table: each property's kind and label, and the
 * type's name. The same for a saved view's table and a type's own, so a
 * choice is a pill in the colour its type chose, in both.
 */
export function schemaOf(type: ObjectType | null, fallbackNoun: string): TableSchema {
  const properties = type?.properties ?? [];
  return {
    kinds: Object.fromEntries(properties.map((def) => [def.key, def.kind])),
    labels: Object.fromEntries(properties.map((def) => [def.key, def.label])),
    colors: optionColorsByKey(properties),
    noun: type?.label ?? fallbackNoun,
  };
}

/**
 * `schemaOf`, with each property declared, so a saved view's cells open the
 * editor their kind calls for — a status's picker, a relation's notes, a
 * day, a number, a box (#300). A type's own table edits as text until it
 * keeps a picker's overlay slot too.
 */
export function editableSchemaOf(type: ObjectType | null, fallbackNoun: string): TableSchema {
  const properties = type?.properties ?? [];
  return {
    ...schemaOf(type, fallbackNoun),
    properties: Object.fromEntries(properties.map((def) => [def.key, def])),
  };
}
