import { humanizeKey } from '../page/property-label.ts';
import { readsAsProperty, type ObjectType, type PropertyDef } from './property-def.ts';

/**
 * A property as it is written in a type file: the shorthand `due: date` when
 * the kind is all there is to say, otherwise a map holding only what differs
 * from the defaults `parseObjectType` fills in — so a written type reads the
 * way one written by hand does, and parses back to the same thing.
 */
export function propertySpec(property: PropertyDef): string | Record<string, unknown> {
  const spec: Record<string, unknown> = { kind: property.kind };
  if (property.label !== humanizeKey(property.key)) spec['label'] = property.label;
  if (property.options.length > 0) spec['options'] = [...property.options];
  if (property.colors !== undefined && Object.keys(property.colors).length > 0) {
    spec['colors'] = { ...property.colors };
  }
  if (property.done !== undefined) spec['done'] = property.done;
  if (property.targets !== undefined && property.targets.length > 1) {
    spec['target'] = [...property.targets];
  } else if (property.target !== null) spec['target'] = property.target;
  // multiSelect is many by definition, and saying so again is noise.
  if (property.many && property.kind !== 'multiSelect') spec['many'] = true;
  if (property.required) spec['required'] = true;
  return Object.keys(spec).length === 1 ? property.kind : spec;
}

/**
 * The frontmatter keys a type file is rewritten with. `name` is left out: it is
 * what notes declare, and an edit never changes it. A missing icon is null, so
 * the key is removed rather than left behind.
 */
export function typeFrontmatter(type: ObjectType): Record<string, unknown> {
  return {
    label: type.label,
    icon: type.icon ?? null,
    properties: Object.fromEntries(
      type.properties.map((property) => [property.key, propertySpec(property)]),
    ),
  };
}

/** The keys of a property's spec that `parseObjectType` reads; any other is the file's own. */
const SPEC_KEYS = new Set([
  'kind',
  'label',
  'options',
  'colors',
  'done',
  'target',
  'many',
  'required',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const sameProperty = (a: PropertyDef | undefined, b: PropertyDef): boolean =>
  a !== undefined &&
  a.key === b.key &&
  JSON.stringify(propertySpec(a)) === JSON.stringify(propertySpec(b));

/**
 * What an edit changes in a type file's frontmatter, and only that: a file
 * written by hand can hold what `parseObjectType` does not read — an icon the
 * app does not offer, a kind it does not know, a key inside a spec, a colour off
 * its palette — and writing the whole type back would delete all of it.
 *
 * `before` is the type as read from `written`, the file's frontmatter as it
 * stands, and `after` the type the edit left. The label and icon are changed
 * only when they differ. When the properties differ, the map is rebuilt from
 * `written`: a property the edit left alone keeps what was written for it, an
 * edited one has its spec merged into what was written, and one the parser
 * skipped stays where it was.
 */
export function typeFrontmatterChanges({
  before,
  after,
  written,
}: {
  before: ObjectType;
  after: ObjectType;
  written: Readonly<Record<string, unknown>>;
}): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  if (after.label !== before.label) changes['label'] = after.label;
  if ((after.icon ?? null) !== (before.icon ?? null)) changes['icon'] = after.icon ?? null;
  const unchanged =
    after.properties.length === before.properties.length &&
    after.properties.every((property, at) => sameProperty(before.properties[at], property));
  if (!unchanged) {
    changes['properties'] = writtenProperties({
      before,
      after,
      written: isRecord(written['properties']) ? written['properties'] : {},
    });
  }
  return changes;
}

/**
 * The key each property of `after` had in `before`. A rename is one edit: the
 * lists are as long as each other and differ at one place, by a key that is
 * new standing where one that is gone stood.
 */
function formerKeys(before: ObjectType, after: ObjectType): Map<string, string> {
  const beforeKeys = new Set(before.properties.map((property) => property.key));
  const afterKeys = new Set(after.properties.map((property) => property.key));
  const former = new Map(after.properties.map((property) => [property.key, property.key]));
  if (before.properties.length !== after.properties.length) return former;
  before.properties.forEach((old, at) => {
    const now = after.properties[at];
    if (now !== undefined && !afterKeys.has(old.key) && !beforeKeys.has(now.key)) {
      former.set(now.key, old.key);
    }
  });
  return former;
}

function writtenProperties({
  before,
  after,
  written,
}: {
  before: ObjectType;
  after: ObjectType;
  written: Readonly<Record<string, unknown>>;
}): Record<string, unknown> {
  const beforeByKey = new Map(before.properties.map((property) => [property.key, property]));
  const former = formerKeys(before, after);
  const asWritten = writtenKeys(written);
  const oldKey = (property: PropertyDef) => former.get(property.key) ?? property.key;
  const spec = (property: PropertyDef) => {
    const was = beforeByKey.get(oldKey(property));
    const raw = written[asWritten.get(oldKey(property)) ?? oldKey(property)];
    if (was !== undefined && sameProperty(was, property)) return raw;
    return mergedSpec({ raw, spec: propertySpec(property), was });
  };
  // A property keeps the key as the file spells it — `" title"` — unless it was renamed.
  const keyOf = (property: PropertyDef) =>
    property.key === oldKey(property)
      ? (asWritten.get(property.key) ?? property.key)
      : property.key;
  // Properties that were read before and still are fill the places those held,
  // in their new order; the ones the parser skipped are never moved. A key the
  // file holds for a skipped one is not a property read before (#683).
  const kept = after.properties.filter(
    (property) => beforeByKey.has(oldKey(property)) && asWritten.has(oldKey(property)),
  );
  const keptOldKeys = new Set(kept.map(oldKey));
  const entries: [string, unknown][] = [];
  let next = 0;
  for (const [key, raw] of Object.entries(written)) {
    const read = key.trim();
    if (!beforeByKey.has(read) || asWritten.get(read) !== key) entries.push([key, raw]);
    else if (keptOldKeys.has(read)) {
      const property = kept[next++]!;
      entries.push([keyOf(property), spec(property)]);
    }
  }
  for (const property of after.properties) {
    if (!keptOldKeys.has(oldKey(property))) entries.push([property.key, spec(property)]);
  }
  refuseWritingOver(entries);
  return Object.fromEntries(entries);
}

/**
 * Refuses a map that holds one key twice, as YAML spells it: the later would
 * write over the earlier, and so over what the file says of a property. Keys
 * that only trim alike — `" author"` and `author` — are two to YAML, and were
 * both in the file. The editor keeps clear of the file's keys (#683); this is
 * what holds if it ever does not.
 */
function refuseWritingOver(entries: readonly (readonly [string, unknown])[]): void {
  const seen = new Set<string>();
  for (const [key] of entries) {
    if (seen.has(key)) {
      throw new Error(`The type file already holds "${key}", so it is not written over`);
    }
    seen.add(key);
  }
}

/**
 * Each key the parser reads out of a written `properties` map, to the key as
 * the file spells it: the parser trims a key, so `" title"` is the property
 * `title`. Where two spellings trim alike, the one read is the first the
 * parser takes as a property — never one it skips (#683).
 */
function writtenKeys(written: Readonly<Record<string, unknown>>): Map<string, string> {
  const keys = new Map<string, string>();
  for (const [key, raw] of Object.entries(written)) {
    const read = key.trim();
    if (readsAsProperty(key, raw) && !keys.has(read)) keys.set(read, key);
  }
  return keys;
}

/**
 * An edited property's spec written into what was there: keys the parser does
 * not read are kept where they stood, as are colours it could not read.
 */
function mergedSpec({
  raw,
  spec,
  was,
}: {
  raw: unknown;
  spec: string | Record<string, unknown>;
  was: PropertyDef | undefined;
}): unknown {
  if (!isRecord(raw)) return spec;
  const wanted = typeof spec === 'string' ? { kind: spec } : spec;
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!SPEC_KEYS.has(key)) merged[key] = value;
    else if (key === 'colors') {
      const colors = mergedColors({
        raw: value,
        wanted: wanted['colors'],
        was,
        options: wanted['options'],
      });
      if (colors !== null) merged[key] = colors;
    } else if (Object.hasOwn(wanted, key)) merged[key] = wanted[key];
  }
  for (const [key, value] of Object.entries(wanted)) {
    if (!Object.hasOwn(merged, key) && !(key === 'colors' && Object.hasOwn(raw, key))) {
      merged[key] = value;
    }
  }
  // Back to saying only its kind: written as the shorthand again, so a flag
  // set and cleared leaves `due: date` as it was rather than its long form.
  const onlyKind = Object.keys(merged).length === 1 && Object.hasOwn(merged, 'kind');
  return typeof spec === 'string' && onlyKind ? spec : merged;
}

/**
 * The colours written for an edited property: the ones the edit wants, and
 * any the parser could not read (a colour off the palette) kept as they were —
 * unless their option was renamed or removed, which would leave a colour for
 * nothing (#413).
 */
function mergedColors({
  raw,
  wanted,
  was,
  options,
}: {
  raw: unknown;
  wanted: unknown;
  was: PropertyDef | undefined;
  /** The options the edited property lists now, as written. */
  options: unknown;
}): Record<string, unknown> | null {
  const colors = isRecord(wanted) ? wanted : {};
  const read = was?.colors ?? {};
  const listed = Array.isArray(options) ? options.map(String) : [];
  const gone = (option: string) =>
    was?.options.includes(option) === true && !listed.includes(option);
  const merged: Record<string, unknown> = {};
  for (const [option, tone] of Object.entries(isRecord(raw) ? raw : {})) {
    if (Object.hasOwn(colors, option)) merged[option] = colors[option];
    else if (!Object.hasOwn(read, option) && !gone(option)) merged[option] = tone;
  }
  for (const [option, tone] of Object.entries(colors)) {
    if (!Object.hasOwn(merged, option)) merged[option] = tone;
  }
  return Object.keys(merged).length === 0 ? null : merged;
}

/**
 * The whole frontmatter of a new type file. An empty `properties` is left out
 * rather than written as `{}`: an inline map stays inline when edited, and the
 * first property added should start the block a person would write by hand.
 */
export function newTypeFrontmatter(type: ObjectType): Record<string, unknown> {
  const { properties, ...rest } = typeFrontmatter(type);
  return {
    name: type.name,
    ...rest,
    ...(type.properties.length > 0 && { properties }),
  };
}
