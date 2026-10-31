import { humanizeKey } from '../page/property-label.ts';
import { isOptionColor, type OptionColor } from '../page/pill-colour.ts';
import type { SidebarIcon } from '../sidebar/sidebar-icon.ts';
import { TYPE_ICONS } from './type-icon.ts';
/**
 * What a property can be.
 *
 * Deliberately small: every kind here can be written into YAML frontmatter and
 * read back without ambiguity. Rollups and formulas are computed rather than
 * stored, so they arrive with the query layer rather than here.
 */
export type PropertyKind =
  | 'text'
  | 'number'
  | 'date'
  | 'checkbox'
  | 'select'
  | 'multiSelect'
  | 'url'
  | 'relation'
  | 'thumbnail';

export const PROPERTY_KINDS: readonly PropertyKind[] = [
  'text',
  'number',
  'date',
  'checkbox',
  'select',
  'multiSelect',
  'url',
  'relation',
  'thumbnail',
];

export interface PropertyDef {
  /** The frontmatter key this property is stored under. */
  readonly key: string;
  readonly kind: PropertyKind;
  readonly label: string;
  readonly required: boolean;
  /** For select and multiSelect. */
  readonly options: readonly string[];
  /**
   * For relation: the name of the type this property points at — the first,
   * when it may point at several. Read {@link relationTypes} for all of them.
   */
  readonly target: string | null;
  /**
   * For relation: every type it may point at, when that is more than one —
   * `target: [project, area]` in the type file. Absent for one, so the many
   * relations that point at a single type read exactly as they always have.
   */
  readonly targets?: readonly string[];
  /** For relation: whether it holds one note or several. */
  readonly many: boolean;
  /**
   * For select and multiSelect: the colour an option's pill is drawn in, where
   * the type chose one — a status tone or a palette hue (`OPTION_COLORS`). An
   * option without one is coloured by its value (`optionColor`).
   */
  readonly colors?: Readonly<Record<string, OptionColor>>;
  /**
   * For select: the option that means finished — what ticking a note's
   * checkbox sets. Written as `done: <option>` in the type file; see
   * `statusOf` for what a type without one falls back to.
   */
  readonly done?: string;
}

export interface ObjectType {
  /** Matches the `type:` value in a note's frontmatter. */
  readonly name: string;
  readonly label: string;
  readonly properties: readonly PropertyDef[];
  /** The glyph the type chose for itself; without one it is guessed from the name. */
  readonly icon?: SidebarIcon;
  /**
   * Where its notes live, as the type file writes it — `Tasks/{YYYY}/{MM}` —
   * when it says; blank when it says they have no home (#214).
   */
  readonly folder?: string;
  /**
   * The keys of the properties the file holds and the type leaves out, as
   * `objectTypeProblems` names them: still the file's, so an edit must not
   * give one to a property of its own (#683). Absent when there are none.
   */
  readonly unreadKeys?: readonly string[];
}

export class InvalidTypeError extends Error {
  constructor(reason: string) {
    super(`Invalid type definition: ${reason}`);
    this.name = 'InvalidTypeError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// A repeat is dropped: every consumer keys by option (board columns, a
// select's entries), and a hand-edited type file can list one twice.
const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.map((item) => String(item)))] : [];

/**
 * Reads a type definition out of the frontmatter of a file in `.atlas/types`.
 *
 * A malformed property is dropped rather than failing the whole type: one bad
 * line should cost you that property, not the ability to open your notes.
 */
export function parseObjectType(frontmatter: Record<string, unknown>): ObjectType {
  // A list or a map is no name: as text it would be "a,b" or "[object Object]".
  if (isNotText(frontmatter['name'])) throw new InvalidTypeError('a type’s name must be text');
  const name = String(frontmatter['name'] ?? '').trim();
  if (name === '') throw new InvalidTypeError('a type needs a name');

  const declared = frontmatter['properties'];
  const properties: PropertyDef[] = [];
  const unreadKeys: string[] = [];

  if (isRecord(declared)) {
    for (const [key, raw] of Object.entries(declared)) {
      const property = parseProperty(key, raw);
      if (property !== null) properties.push(property);
      else if (key.trim() !== '') unreadKeys.push(key.trim());
    }
  }

  const icon = TYPE_ICONS.find((candidate) => candidate === frontmatter['icon']);
  const folder = parseFolder(frontmatter);
  return {
    name,
    label: String(frontmatter['label'] ?? name),
    properties,
    ...(icon !== undefined && { icon }),
    ...(folder !== null && { folder }),
    ...(unreadKeys.length > 0 && { unreadKeys }),
  };
}

const isNotText = (value: unknown): boolean => typeof value === 'object' && value !== null;

/**
 * The type's `folder:` as text: a key written with nothing in it is blank —
 * the type has no home — and one holding anything but text is left unread,
 * so the type keeps the folder it would have had without it.
 */
function parseFolder(frontmatter: Record<string, unknown>): string | null {
  if (!Object.hasOwn(frontmatter, 'folder')) return null;
  const folder = frontmatter['folder'];
  if (folder === null) return '';
  return typeof folder === 'string' ? folder.trim() : null;
}

/** The keys only a type file writes: frontmatter with none of them is no type. */
const TYPE_KEYS: readonly string[] = ['name', 'label', 'properties', 'icon', 'folder'];

/** The type keys written with capitals, `Name`, where the lowercase key is not written too. */
function miscasedTypeKeys(frontmatter: Record<string, unknown>): string[] {
  return Object.keys(frontmatter).filter((key) => {
    const lower = key.toLowerCase();
    return key !== lower && TYPE_KEYS.includes(lower) && !Object.hasOwn(frontmatter, lower);
  });
}

/**
 * What keeps a type file's frontmatter from reading whole, in words, each
 * for the person to mend (#683): no name, so no type at all, or a property
 * `parseObjectType` leaves out. Empty when it reads as written, and for
 * frontmatter that holds none of a type's keys — that is no type.
 */
export function objectTypeProblems(frontmatter: Record<string, unknown>): readonly string[] {
  const miscased = miscasedTypeKeys(frontmatter);
  const isType = TYPE_KEYS.some((key) => Object.hasOwn(frontmatter, key)) || miscased.length > 0;
  if (!isType) return [];
  const problems: string[] = [];
  if (miscased.length > 0) {
    const fixes = miscased.map((key) => `${key} → ${key.toLowerCase()}`).join(', ');
    problems.push(`Its keys must be lowercase: ${fixes}.`);
  }
  if (isNotText(frontmatter['name'])) {
    problems.push('Its name must be text, not a list or a map.');
  } else if (
    String(frontmatter['name'] ?? '').trim() === '' &&
    !miscased.some((key) => key.toLowerCase() === 'name')
  ) {
    problems.push('It has no name, and a type needs one.');
  }
  const declared = frontmatter['properties'];
  if (isRecord(declared)) {
    for (const [key, raw] of Object.entries(declared)) {
      const refused = propertyRefusal(key.trim(), raw);
      if (refused !== null) problems.push(refused);
    }
  } else if (declared !== undefined && declared !== null) {
    problems.push('Its properties are not written as key: kind.');
  }
  return problems;
}

/** A property's spec, its kind and what it points at, as written. */
function specOf(raw: unknown) {
  // `status: select` is shorthand for `status: { kind: select }`.
  const spec = isRecord(raw) ? raw : { kind: raw };
  const kind = String(spec['kind'] ?? 'text') as PropertyKind;
  return { spec, kind, targets: parseTargets(spec['target']) };
}

/** Why a property is left out of its type, or null when it is kept. A blank key is left out without one. */
function propertyRefusal(key: string, raw: unknown): string | null {
  if (key === '') return null;
  const { kind, targets } = specOf(raw);
  if (!PROPERTY_KINDS.includes(kind)) {
    return `Its property “${key}” has a kind DFAI does not know: “${kind}”.`;
  }
  // A relation with nothing to point at cannot offer anything, so it is not one.
  if (kind === 'relation' && targets.length === 0) {
    // `targets` is what the type holds, so it is the likeliest slip for the key.
    const slip = isRecord(raw) && Object.hasOwn(raw, 'targets');
    return `Its property “${key}” is a relation that names no type to point at${slip ? ': write target:, not targets:' : ''}.`;
  }
  return null;
}

function parseProperty(key: string, raw: unknown): PropertyDef | null {
  const trimmed = key.trim();
  if (trimmed === '' || propertyRefusal(trimmed, raw) !== null) return null;

  const { spec, kind, targets } = specOf(raw);
  const target = targets[0] ?? null;

  const options = asStrings(spec['options']);
  const colors = parseColors(spec['colors'], options);
  const done = parseDone({ raw: spec['done'], kind, options });
  return {
    key: trimmed,
    kind,
    label: typeof spec['label'] === 'string' ? spec['label'] : humanizeKey(trimmed),
    required: spec['required'] === true,
    options,
    target,
    many: kind === 'multiSelect' || spec['many'] === true,
    ...(targets.length > 1 && { targets }),
    ...(colors !== null && { colors }),
    ...(done !== null && { done }),
  };
}

/**
 * The types a `target:` names: one written bare, or a list of them. A blank
 * entry, or one listed twice, is dropped, as a repeated option is.
 */
function parseTargets(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  const listed = Array.isArray(raw) ? raw : [raw];
  const names = listed.map((name) => String(name).trim()).filter((name) => name !== '');
  return [...new Set(names)];
}

/**
 * Every type a relation may point at, in the order the type file lists them;
 * empty when it names none.
 */
export function relationTypes(def: Pick<PropertyDef, 'target' | 'targets'>): readonly string[] {
  if (def.targets !== undefined && def.targets.length > 0) return def.targets;
  return def.target === null ? [] : [def.target];
}

/**
 * What a relation points at, in words: `project`, `project or area`,
 * `person, company or project` — or `note` for one that names no type.
 */
export function relationTypesText(def: Pick<PropertyDef, 'target' | 'targets'>): string {
  const names = relationTypes(def);
  if (names.length === 0) return 'note';
  if (names.length === 1) return names[0] ?? 'note';
  return `${names.slice(0, -1).join(', ')} or ${names.at(-1) ?? ''}`;
}

/**
 * The option a select names as finished. One it does not list is dropped, as
 * a colour for a missing option is: it could only ever mark nothing done.
 */
function parseDone({
  raw,
  kind,
  options,
}: {
  raw: unknown;
  kind: PropertyKind;
  options: readonly string[];
}): string | null {
  if (kind !== 'select' || raw === undefined || raw === null) return null;
  const done = String(raw);
  return options.includes(done) ? done : null;
}

/**
 * The colours chosen for a select's options: a status tone or a palette hue.
 * A colour that is neither, or one for an option the property does not list,
 * is dropped: it could only ever colour something that is not there.
 */
function parseColors(
  raw: unknown,
  options: readonly string[],
): Readonly<Record<string, OptionColor>> | null {
  if (!isRecord(raw)) return null;
  const colors = Object.entries(raw).filter(
    (entry): entry is [string, OptionColor] =>
      options.includes(entry[0]) && isOptionColor(entry[1]),
  );
  return colors.length === 0 ? null : Object.fromEntries(colors);
}
