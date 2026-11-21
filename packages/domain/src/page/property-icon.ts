import type { PropertyKind } from '../types/property-def.ts';
import { propertyRole } from './property-role.ts';

/** The glyphs a property row can carry, named for what they mean. */
export type PropertyIcon =
  | 'status'
  | 'number'
  | 'date'
  | 'relation'
  | 'check'
  | 'link'
  | 'text'
  | 'title'
  | 'person'
  | 'duration'
  | 'picture';

const KIND_ICONS: Readonly<Record<PropertyKind, PropertyIcon>> = {
  text: 'text',
  number: 'number',
  date: 'date',
  checkbox: 'check',
  select: 'status',
  multiSelect: 'status',
  url: 'link',
  relation: 'relation',
  thumbnail: 'picture',
};

/** The glyph beside a property's label, from the kind of value it holds. */
export function propertyIcon(kind: PropertyKind): PropertyIcon {
  return KIND_ICONS[kind];
}

/** The column every view has, which names the note. */
const TITLE_COLUMN = 'title';

/**
 * The glyph in a view's column heading.
 *
 * The kind says most of it; a text property that names a person or a length
 * of time says more by its key than by its kind, so that wins. A column the
 * view's type does not declare is text, which is what the index hands back.
 */
export function columnIcon({ key, kind }: { key: string; kind?: PropertyKind }): PropertyIcon {
  if (key === TITLE_COLUMN) return 'title';
  const role = propertyRole(key);
  if (role !== null && (kind === undefined || kind === 'text')) return role;
  return kind === undefined ? 'text' : propertyIcon(kind);
}
