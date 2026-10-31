import { humanizeKey } from '../page/property-label.ts';
import { optionColor, type OptionColor } from '../page/pill-colour.ts';
import type { SidebarIcon } from '../sidebar/sidebar-icon.ts';
import type { NoteMigration } from './note-migration.ts';
import type { ObjectType, PropertyDef, PropertyKind } from './property-def.ts';
import { freePropertyKey, propertyKeyProblem, slugifyName, typeNameProblem } from './type-name.ts';

/**
 * Editing a type: every change the type editor can make, as a function from
 * the type before to the type after.
 *
 * A change that cannot be made throws a `TypeEditError` whose message is meant
 * to be shown as it is. A change that the notes of the type could follow —
 * a renamed key or option, a removed key — also says how, as a `NoteMigration`,
 * and leaves it to the caller whether to carry it out.
 */
export class TypeEditError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'TypeEditError';
  }
}

/** A type after a change the notes may need to follow. */
export interface TypeChange {
  readonly type: ObjectType;
  /** What following it would mean for each note, or null when nothing would change. */
  readonly migration: NoteMigration | null;
}

/**
 * A new, empty type. Its name is what notes will declare, made from the label
 * unless one is given, and checked against the vault's other types.
 */
export function newObjectType({
  label,
  name,
  icon = null,
  existing,
}: {
  label: string;
  name?: string;
  icon?: SidebarIcon | null;
  /** The names the vault's types already have. */
  existing: readonly string[];
}): ObjectType {
  const trimmed = label.trim();
  if (trimmed === '') throw new TypeEditError('A type needs a name');
  const chosen = name === undefined || name.trim() === '' ? slugifyName(trimmed) : name.trim();
  const problem = typeNameProblem({ name: chosen, existing });
  if (problem !== null) throw new TypeEditError(problem);
  return { name: chosen, label: trimmed, properties: [], ...(icon !== null && { icon }) };
}

const HAS_OPTIONS: ReadonlySet<PropertyKind> = new Set(['select', 'multiSelect']);

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** The property with exactly these option colours: none at all when there are none. */
function withColors(
  property: PropertyDef,
  colors: Readonly<Record<string, OptionColor>> | undefined,
): PropertyDef {
  const next: Mutable<PropertyDef> = { ...property };
  if (colors === undefined || Object.keys(colors).length === 0) delete next.colors;
  else next.colors = colors;
  return next;
}

/** The property pointing at exactly these types beside its target: none when undefined. */
function withTargets(property: PropertyDef, targets: readonly string[] | undefined): PropertyDef {
  const next: Mutable<PropertyDef> = { ...property };
  if (targets === undefined) delete next.targets;
  else next.targets = targets;
  return next;
}

/** The property with exactly this done option: none at all when there is none. */
function withDone(property: PropertyDef, done: string | undefined): PropertyDef {
  const next: Mutable<PropertyDef> = { ...property };
  if (done === undefined) delete next.done;
  else next.done = done;
  return next;
}

/**
 * Refuses a second thumbnail property on a type: only the first fronts its
 * cards, so another would look as if it does something and never would.
 * `key` is the property becoming one, which may already be it.
 */
function refuseSecondThumbnail(type: ObjectType, key: string | null): void {
  const other = type.properties.find(
    (property) => property.kind === 'thumbnail' && property.key !== key,
  );
  if (other !== undefined) {
    throw new TypeEditError(`${type.label} already has a thumbnail: ${other.label}`);
  }
}

function propertyOf(type: ObjectType, key: string): PropertyDef {
  const found = type.properties.find((property) => property.key === key);
  if (found === undefined) throw new TypeEditError(`${type.label} has no property called "${key}"`);
  return found;
}

function withProperty(
  type: ObjectType,
  key: string,
  change: (property: PropertyDef) => PropertyDef,
): ObjectType {
  const current = propertyOf(type, key);
  return {
    ...type,
    properties: type.properties.map((property) =>
      property === current ? change(current) : property,
    ),
  };
}

/**
 * The keys a property other than `key` holds, and the keys the file holds for
 * properties the type left out: a key given to a property of the editor's
 * over one of those would write over what the file says of it (#683).
 */
const otherKeys = (type: ObjectType, key: string | null): string[] => [
  ...type.properties.map((property) => property.key).filter((candidate) => candidate !== key),
  ...(type.unreadKeys ?? []),
];

/** Refuses a key the file holds for a property the type cannot read: mending that is the file's. */
function refuseUnreadKey(type: ObjectType, key: string): void {
  const unread = (type.unreadKeys ?? []).find((taken) => taken.toLowerCase() === key.toLowerCase());
  if (unread === undefined) return;
  throw new TypeEditError(
    `"${unread}" is already in the type file, as a property DFAI cannot read: mend or remove it there first`,
  );
}

export function setTypeLabel(type: ObjectType, label: string): ObjectType {
  const trimmed = label.trim();
  if (trimmed === '') throw new TypeEditError('A type needs a name');
  return { ...type, label: trimmed };
}

/** Chooses the type's icon; null goes back to the one guessed from its name. */
export function setTypeIcon(type: ObjectType, icon: SidebarIcon | null): ObjectType {
  const next: Mutable<ObjectType> = { ...type };
  if (icon === null) delete next.icon;
  else next.icon = icon;
  return next;
}

/**
 * What the type editor calls a property it has just added, before it is named.
 * Its key is only a placeholder too, until the first name it is given.
 */
export const NEW_PROPERTY_LABEL = 'Property';

/** Whether a property still carries the placeholder it was added under, key and all. */
const isPlaceholder = (property: PropertyDef): boolean =>
  property.label === NEW_PROPERTY_LABEL && /^property(_\d+)?$/.test(property.key);

/** Adds a property at the end, stored under a key made from its label. */
export function addProperty(
  type: ObjectType,
  { label, kind = 'text' }: { label: string; kind?: PropertyKind },
): ObjectType {
  const trimmed = label.trim();
  if (trimmed === '') throw new TypeEditError('A property needs a name');
  if (kind === 'thumbnail') refuseSecondThumbnail(type, null);
  const key = freePropertyKey({ words: trimmed, existing: otherKeys(type, null) });
  const added: PropertyDef = {
    key,
    kind,
    label: trimmed,
    required: false,
    options: [],
    // A relation has to point somewhere; the type itself is always there.
    target: kind === 'relation' ? type.name : null,
    many: kind === 'multiSelect',
  };
  return { ...type, properties: [...type.properties, added] };
}

/**
 * Renames a property: its label, its key, or both. A new key is where the
 * value is stored, so the notes holding the old one can be moved onto it.
 */
export function renameProperty(
  type: ObjectType,
  { key, newKey, label }: { key: string; newKey: string; label: string },
): TypeChange {
  const current = propertyOf(type, key);
  // A placeholder named for the first time is stored under that name: a
  // relation called Tasks is `tasks`, not `property`.
  const named = newKey.trim() === key && isPlaceholder(current) && label.trim() !== '';
  const nextKey = named
    ? freePropertyKey({ words: label, existing: otherKeys(type, key) })
    : newKey.trim();
  const nextLabel = label.trim() === '' ? humanizeKey(nextKey) : label.trim();
  if (nextKey !== key) {
    refuseUnreadKey(type, nextKey);
    const problem = propertyKeyProblem({ key: nextKey, existing: otherKeys(type, key) });
    if (problem !== null) throw new TypeEditError(problem);
  }
  return {
    type: withProperty(type, key, () => ({ ...current, key: nextKey, label: nextLabel })),
    migration: nextKey === key ? null : { kind: 'renameKey', from: key, to: nextKey },
  };
}

/** Removes a property from the type. Its values stay in the notes unless the migration is run. */
export function removeProperty(type: ObjectType, key: string): TypeChange {
  propertyOf(type, key);
  return {
    type: { ...type, properties: type.properties.filter((property) => property.key !== key) },
    migration: { kind: 'removeKey', key },
  };
}

function moved<T>(items: readonly T[], from: number, to: number): T[] {
  const clamped = Math.max(0, Math.min(items.length - 1, to));
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item === undefined) return next;
  next.splice(clamped, 0, item);
  return next;
}

/** Moves a property to a position in the list, which is the order a note shows them in. */
export function moveProperty(
  type: ObjectType,
  { key, to }: { key: string; to: number },
): ObjectType {
  const from = type.properties.indexOf(propertyOf(type, key));
  return { ...type, properties: moved(type.properties, from, to) };
}

/**
 * Changes what kind of value a property holds. Options survive a change between
 * the two select kinds; a relation starts out pointing at the type itself.
 */
export function changePropertyKind(
  type: ObjectType,
  { key, kind }: { key: string; kind: PropertyKind },
): ObjectType {
  if (kind === 'thumbnail') refuseSecondThumbnail(type, key);
  return withProperty(type, key, (current) => {
    if (current.kind === kind) return current;
    const keepsOptions = HAS_OPTIONS.has(kind) && HAS_OPTIONS.has(current.kind);
    const changed: PropertyDef = {
      ...withTargets(current, kind === 'relation' ? current.targets : undefined),
      kind,
      options: keepsOptions ? current.options : [],
      target: kind === 'relation' ? (current.target ?? type.name) : null,
      many:
        kind === 'multiSelect' ||
        ((kind === 'relation' || kind === 'text') &&
          current.many &&
          current.kind !== 'multiSelect'),
    };
    return withDone(
      withColors(changed, keepsOptions ? current.colors : undefined),
      kind === 'select' ? current.done : undefined,
    );
  });
}

export function setPropertyRequired(
  type: ObjectType,
  { key, required }: { key: string; required: boolean },
): ObjectType {
  return withProperty(type, key, (current) => ({ ...current, required }));
}

/** Points a relation at a type, and says whether it holds one note or several. */
export function setRelation(
  type: ObjectType,
  {
    key,
    target,
    many,
    types,
  }: { key: string; target: string; many: boolean; types: readonly string[] },
): ObjectType {
  // The type being edited is always a valid target, even before it is saved.
  if (target !== type.name && !types.includes(target)) {
    throw new TypeEditError(`There is no type called "${target}" to point at`);
  }
  return withProperty(type, key, (current) => {
    if (current.kind !== 'relation') throw new TypeEditError(`${current.label} is not a relation`);
    // Pointed at the same type, it keeps the others the type file lists with it;
    // pointed elsewhere, it points there alone.
    const targets = target === current.target ? current.targets : undefined;
    return { ...withTargets(current, targets), target, many };
  });
}

/**
 * Whether a property holds several values ("Allow many", slice 12): a
 * multi-select does, a select does not, a relation as it says. Null for a
 * kind that holds one value only.
 */
export function manyOf(property: PropertyDef): boolean | null {
  if (property.kind === 'select' || property.kind === 'multiSelect') {
    return property.kind === 'multiSelect';
  }
  return property.kind === 'relation' ? property.many : null;
}

/**
 * Lets a property hold several values, or one. No new setting: a select that
 * allows many is a multi-select, and a relation says `many`. What a relation
 * points at is left as it is, so one pointing at a type not (yet) in the
 * vault can still be switched.
 */
export function setPropertyMany(
  type: ObjectType,
  { key, many }: { key: string; many: boolean },
): ObjectType {
  const current = propertyOf(type, key);
  if (current.kind === 'select' || current.kind === 'multiSelect') {
    return changePropertyKind(type, { key, kind: many ? 'multiSelect' : 'select' });
  }
  if (current.kind !== 'relation') {
    throw new TypeEditError(`${current.label} holds one value only`);
  }
  return withProperty(type, key, (property) => ({ ...property, many }));
}

function withOptions(
  type: ObjectType,
  key: string,
  change: (property: PropertyDef) => PropertyDef,
): ObjectType {
  return withProperty(type, key, (current) => {
    if (!HAS_OPTIONS.has(current.kind)) {
      throw new TypeEditError(`${current.label} has no options to edit`);
    }
    return change(current);
  });
}

function optionProblem(
  property: PropertyDef,
  option: string,
  except: string | null,
): string | null {
  if (option === '') return 'An option needs a name';
  if (property.options.some((taken) => taken === option && taken !== except)) {
    return `${property.label} already has "${option}"`;
  }
  return null;
}

export function addOption(
  type: ObjectType,
  { key, option }: { key: string; option: string },
): ObjectType {
  return withOptions(type, key, (current) => {
    const trimmed = option.trim();
    const problem = optionProblem(current, trimmed, null);
    if (problem !== null) throw new TypeEditError(problem);
    return { ...current, options: [...current.options, trimmed] };
  });
}

/**
 * Renames an option where it stands, so board columns keep their order. The
 * option keeps the colour it had — including one it only had because of its
 * old name, which the new name would not give it.
 */
export function renameOption(
  type: ObjectType,
  { key, from, to }: { key: string; from: string; to: string },
): TypeChange {
  const trimmed = to.trim();
  const next = withOptions(type, key, (current) => {
    if (!current.options.includes(from))
      throw new TypeEditError(`${current.label} has no "${from}"`);
    const problem = optionProblem(current, trimmed, from);
    if (problem !== null) throw new TypeEditError(problem);
    const tone = optionColor(current, from);
    const colors = Object.fromEntries(
      Object.entries(current.colors ?? {}).filter(([option]) => option !== from),
    );
    const keptTone = tone === optionColor({ key }, trimmed) ? {} : { [trimmed]: tone };
    const renamed = withColors(
      {
        ...current,
        options: current.options.map((option) => (option === from ? trimmed : option)),
      },
      { ...colors, ...keptTone },
    );
    return withDone(renamed, current.done === from ? trimmed : current.done);
  });
  return {
    type: next,
    migration: trimmed === from ? null : { kind: 'renameOption', key, from, to: trimmed },
  };
}

export function moveOption(
  type: ObjectType,
  { key, option, to }: { key: string; option: string; to: number },
): ObjectType {
  return withOptions(type, key, (current) => {
    const from = current.options.indexOf(option);
    if (from === -1) throw new TypeEditError(`${current.label} has no "${option}"`);
    return { ...current, options: moved(current.options, from, to) };
  });
}

/**
 * Removes an option. Notes that hold it keep it — the file is the truth — and
 * are shown as holding a value the property no longer offers.
 */
export function removeOption(
  type: ObjectType,
  { key, option }: { key: string; option: string },
): ObjectType {
  return withOptions(type, key, (current) => {
    if (!current.options.includes(option))
      throw new TypeEditError(`${current.label} has no "${option}"`);
    const colors = Object.entries(current.colors ?? {}).filter(([name]) => name !== option);
    const removed = withColors(
      { ...current, options: current.options.filter((candidate) => candidate !== option) },
      Object.fromEntries(colors),
    );
    return withDone(removed, current.done === option ? undefined : current.done);
  });
}

/** Chooses an option's colour, a tone or a hue; null goes back to the one its value gives it. */
export function setOptionColor(
  type: ObjectType,
  { key, option, tone }: { key: string; option: string; tone: OptionColor | null },
): ObjectType {
  return withOptions(type, key, (current) => {
    if (!current.options.includes(option))
      throw new TypeEditError(`${current.label} has no "${option}"`);
    const others = Object.entries(current.colors ?? {}).filter(([name]) => name !== option);
    const chosen =
      tone === null || tone === optionColor({ key }, option) ? [] : [[option, tone] as const];
    return withColors(current, Object.fromEntries([...others, ...chosen]));
  });
}

/**
 * Names the option that means finished — what ticking a note's checkbox sets.
 * Null clears it, and the type falls back to the option whose name says done.
 */
export function setDoneOption(
  type: ObjectType,
  { key, option }: { key: string; option: string | null },
): ObjectType {
  return withProperty(type, key, (current) => {
    if (current.kind !== 'select') {
      throw new TypeEditError(`${current.label} is not a single choice, so nothing is done by it`);
    }
    if (option !== null && !current.options.includes(option)) {
      throw new TypeEditError(`${current.label} has no "${option}"`);
    }
    return withDone(current, option ?? undefined);
  });
}

/** One change asked for in the type editor, as data: what the person did, not what it means. */
export type TypeEdit =
  | { readonly kind: 'setLabel'; readonly label: string }
  | { readonly kind: 'setIcon'; readonly icon: SidebarIcon | null }
  | { readonly kind: 'addProperty'; readonly label: string; readonly propertyKind?: PropertyKind }
  | {
      readonly kind: 'renameProperty';
      readonly key: string;
      readonly newKey: string;
      readonly label: string;
    }
  | { readonly kind: 'removeProperty'; readonly key: string }
  | { readonly kind: 'moveProperty'; readonly key: string; readonly to: number }
  | { readonly kind: 'changeKind'; readonly key: string; readonly propertyKind: PropertyKind }
  | { readonly kind: 'setRequired'; readonly key: string; readonly required: boolean }
  | { readonly kind: 'setMany'; readonly key: string; readonly many: boolean }
  | {
      readonly kind: 'setRelation';
      readonly key: string;
      readonly target: string;
      readonly many: boolean;
    }
  | { readonly kind: 'addOption'; readonly key: string; readonly option: string }
  | {
      readonly kind: 'renameOption';
      readonly key: string;
      readonly from: string;
      readonly to: string;
    }
  | {
      readonly kind: 'moveOption';
      readonly key: string;
      readonly option: string;
      readonly to: number;
    }
  | { readonly kind: 'removeOption'; readonly key: string; readonly option: string }
  | {
      readonly kind: 'setOptionColor';
      readonly key: string;
      readonly option: string;
      readonly tone: OptionColor | null;
    }
  | { readonly kind: 'setDoneOption'; readonly key: string; readonly option: string | null };

const unchanged = (type: ObjectType): TypeChange => ({ type, migration: null });

/**
 * What an edit makes of a type. `types` is every type name in the vault, which
 * a relation's target must be one of.
 */
export function applyTypeEdit(
  type: ObjectType,
  edit: TypeEdit,
  { types }: { types: readonly string[] },
): TypeChange {
  switch (edit.kind) {
    case 'setLabel':
      return unchanged(setTypeLabel(type, edit.label));
    case 'setIcon':
      return unchanged(setTypeIcon(type, edit.icon));
    case 'addProperty':
      return unchanged(addProperty(type, { label: edit.label, kind: edit.propertyKind ?? 'text' }));
    case 'renameProperty':
      return renameProperty(type, edit);
    case 'removeProperty':
      return removeProperty(type, edit.key);
    case 'moveProperty':
      return unchanged(moveProperty(type, edit));
    case 'changeKind':
      return unchanged(changePropertyKind(type, { key: edit.key, kind: edit.propertyKind }));
    case 'setRequired':
      return unchanged(setPropertyRequired(type, edit));
    case 'setMany':
      return unchanged(setPropertyMany(type, edit));
    case 'setRelation':
      return unchanged(setRelation(type, { ...edit, types }));
    case 'addOption':
      return unchanged(addOption(type, edit));
    case 'renameOption':
      return renameOption(type, edit);
    case 'moveOption':
      return unchanged(moveOption(type, edit));
    case 'removeOption':
      return unchanged(removeOption(type, edit));
    case 'setOptionColor':
      return unchanged(setOptionColor(type, edit));
    case 'setDoneOption':
      return unchanged(setDoneOption(type, edit));
  }
}
