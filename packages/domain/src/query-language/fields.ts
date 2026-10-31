/**
 * What a name in a query refers to, read from the vault's types.
 *
 * A field is a property one of the listed types declares, one of the few
 * every note has (`title`, `type`, `path`, `modified`, `tag`, and `progress`
 * through its checklist), or either of those on the note a relation points
 * at: `project.owner`. Knowing its kind
 * is what lets a query be checked — `due < @today` makes sense, `status < 3`
 * does not — and what lets the builder offer the right operators and values.
 */

import {
  relationTypes,
  relationTypesText,
  type ObjectType,
  type PropertyDef,
  type PropertyKind,
} from '../types/property-def.ts';
import { carriesChecklistProgress, PROGRESS_FIELD } from '../checklists/progress-field.ts';
import { fieldText, type FieldRef, type Name } from './ast.ts';
import { QueryTextError } from './query-text-error.ts';

/** A property's kind, or one of the fields every note has. */
export type FieldKind = PropertyKind | 'tag' | 'modified' | 'title' | 'path' | 'type' | 'progress';

export interface QueryField {
  /** As written in a query: `status`, `project.owner`. */
  readonly text: string;
  /** What a column heading or a dropdown calls it: "Status", "Project · Owner". */
  readonly label: string;
  /** The relation it is reached through, or null for the note's own. */
  readonly via: string | null;
  /** The frontmatter key it is read from; for a built-in, its own name. */
  readonly key: string;
  readonly kind: FieldKind;
  /** A select's options, in the type's order; a relation's target type's notes are not here. */
  readonly options: readonly string[];
  /** For a relation: the type it points at — the first, when it may point at several. */
  readonly target: string | null;
  /** For a relation to several types: all of them, as `PropertyDef.targets`. Read with `relationTypes`. */
  readonly targets?: readonly string[];
  /** Whether a note can hold several values of it. */
  readonly many: boolean;
  /**
   * For a field reached through a relation: whether the linked note holds
   * several values of it, whatever the relation does — `many` is true for
   * either. Absent for a field of the note's own, where `many` says it.
   */
  readonly valueMany?: boolean;
}

/** The fields every note has, whatever its type. */
export const BUILT_IN_FIELDS: readonly { key: string; label: string; kind: FieldKind }[] = [
  { key: 'title', label: 'Title', kind: 'title' },
  { key: 'type', label: 'Type', kind: 'type' },
  { key: 'tag', label: 'Tag', kind: 'tag' },
  { key: 'modified', label: 'Modified', kind: 'modified' },
  { key: 'path', label: 'Path', kind: 'path' },
];

/**
 * How far through its checklist a note is (P30-03): a whole percentage, worked
 * out from its boxes, which every note has unless its type declares a
 * `progress` of its own — then the type's is the one meant.
 */
const PROGRESS = { key: PROGRESS_FIELD, label: 'Progress', kind: 'progress' } as const;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The types a query lists, in the order it lists them; a name the vault lacks is left out. */
export function listedTypes(types: readonly ObjectType[], from: readonly string[]): ObjectType[] {
  return from.flatMap((name) => types.filter((type) => type.name === name));
}

/**
 * Every field a query over these types can name directly: the built-ins,
 * then each property in the order the types declare them, then the progress
 * through a note's checklist where none of them declares its own. A key
 * declared by two types is one field, as the first type declares it.
 */
export function directFields(types: readonly ObjectType[], from: readonly string[]): QueryField[] {
  const listed = listedTypes(types, from);
  const builtIns = BUILT_IN_FIELDS.map((field) => builtInField(field, null, types));
  const seen = new Set(builtIns.map((field) => field.key));
  const declared: QueryField[] = [];
  for (const type of listed) {
    for (const property of type.properties) {
      if (seen.has(property.key) || !IDENTIFIER.test(property.key)) continue;
      seen.add(property.key);
      declared.push(propertyField(property));
    }
  }
  const progress = listed.every(carriesChecklistProgress)
    ? [builtInField(PROGRESS, null, types)]
    : [];
  return [...builtIns, ...declared, ...progress];
}

/** A property a type declares, as the field a query — or a view's grouping — names. */
export function propertyField(property: PropertyDef): QueryField {
  return {
    text: property.key,
    label: property.label,
    via: null,
    key: property.key,
    kind: property.kind,
    options: property.options,
    target: property.target,
    ...(property.targets !== undefined && { targets: property.targets }),
    many: property.many || property.kind === 'multiSelect',
  };
}

/**
 * The fields of the notes a relation points at: `project.owner`, `project.title`.
 *
 * A relation to several types reaches every field any of them declares, as a
 * query over all of them would — the first type to declare a key decides its
 * kind. The hop reads that key on whichever note is linked, whatever its
 * type, so a linked note of a type that does not declare it simply has no
 * value there (an area has no `due`: `project.due IS EMPTY` holds for it).
 */
export function fieldsThrough(relation: QueryField, types: readonly ObjectType[]): QueryField[] {
  const pointedAt = relationTypes(relation).filter((name) =>
    types.some((type) => type.name === name),
  );
  if (pointedAt.length === 0) return [];
  return directFields(types, pointedAt)
    .filter((field) => field.key !== 'path')
    .map((field) => ({
      ...field,
      text: `${relation.key}.${field.key}`,
      label: `${relation.label} · ${field.label}`,
      via: relation.key,
      many: field.many || relation.many,
      valueMany: field.many,
    }));
}

/** Every field a query over these types can name: its own, then one hop through each relation. */
export function queryableFields(
  types: readonly ObjectType[],
  from: readonly string[],
): QueryField[] {
  const direct = directFields(types, from);
  const through = direct
    .filter((field) => field.kind === 'relation')
    .flatMap((relation) => fieldsThrough(relation, types));
  return [...direct, ...through];
}

/**
 * What a field in a query refers to, or a {@link QueryTextError} at the name
 * that cannot be found.
 */
export function resolveField(
  ref: FieldRef,
  types: readonly ObjectType[],
  from: readonly string[],
): QueryField {
  const direct = directFields(types, from);
  if (ref.via === null) return findField(direct, ref.name, from.join(' or '));

  const relation = findField(direct, ref.via, from.join(' or '));
  if (relation.kind !== 'relation') {
    throw new QueryTextError(
      `${relation.text} is not a relation, so it has no fields to reach through.`,
      ref.via.span,
    );
  }
  if (!relationTypes(relation).some((name) => types.some((type) => type.name === name))) {
    throw new QueryTextError(
      `${relation.text} points at ${relationTypesText(relation)}, which is not a type here.`,
      ref.via.span,
    );
  }
  const found = fieldsThrough(relation, types).find((field) => field.text === fieldText(ref));
  if (found === undefined) {
    throw new QueryTextError(
      `A ${relationTypesText(relation)} has no field called ${ref.name.text}.`,
      ref.name.span,
    );
  }
  return found;
}

function findField(fields: readonly QueryField[], name: Name, owner: string): QueryField {
  const found = fields.find((field) => field.key === name.text);
  if (found !== undefined) return found;
  throw new QueryTextError(`A ${owner} has no field called ${name.text}.`, name.span);
}

function builtInField(
  field: (typeof BUILT_IN_FIELDS)[number] | typeof PROGRESS,
  via: string | null,
  types: readonly ObjectType[],
): QueryField {
  return {
    text: field.key,
    label: field.label,
    via,
    key: field.key,
    kind: field.kind,
    options: field.kind === 'type' ? types.map((type) => type.name) : [],
    target: null,
    many: field.kind === 'tag',
  };
}
