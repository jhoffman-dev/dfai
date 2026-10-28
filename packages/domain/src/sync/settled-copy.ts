import type { ShippedCatalogue, ShippedPropertiesRecord } from '../types/shipped-properties.ts';

/**
 * Whether an old `.atlas` conflict copy can go (#235, ADR-0048). Merging it
 * into its live file changing nothing says the copy holds nothing more; it
 * does not say why the live file holds more. A key the live file has and the
 * copy lacks may be one a person took off on the copy's Mac, and the copy is
 * then the only sign of it. So the copy goes only when every such key is one
 * DFAI wrote into the live file itself.
 */

/** What the live file has and the copy lacks: top-level keys, and entries of its `properties` map. */
export interface LiveExtras {
  readonly keys: readonly string[];
  readonly properties: readonly string[];
}

const PROPERTIES = 'properties';

const isMap = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);

const missingFrom = (from: object, other: object) =>
  Object.keys(from).filter((key) => !Object.hasOwn(other, key));

/** The keys and `properties` entries in `live`'s frontmatter and not in `copy`'s. */
export function liveExtras({
  live,
  copy,
}: {
  live: Readonly<Record<string, unknown>>;
  copy: Readonly<Record<string, unknown>>;
}): LiveExtras {
  const keys = missingFrom(live, copy);
  const own = live[PROPERTIES];
  const theirs = copy[PROPERTIES];
  if (!Object.hasOwn(live, PROPERTIES) || keys.includes(PROPERTIES))
    return { keys, properties: [] };
  if (!isMap(own) || !isMap(theirs)) return { keys: [...keys, PROPERTIES], properties: [] };
  return { keys, properties: missingFrom(own, theirs) };
}

/** Whether all `extras` are properties the vault's record says DFAI added to this type's file. */
export function extrasDfaiWrote({
  extras,
  added,
}: {
  extras: LiveExtras;
  added: readonly string[];
}): boolean {
  return extras.keys.length === 0 && extras.properties.every((key) => added.includes(key));
}

/** Whether every key the live record holds beyond the copy's is one DFAI ships on that type. */
export function recordExtrasShipped({
  live,
  copy,
  shipped,
}: {
  live: ShippedPropertiesRecord;
  copy: ShippedPropertiesRecord;
  shipped: ShippedCatalogue;
}): boolean {
  return (['settled', 'added'] as const).every((part) =>
    Object.entries(live[part]).every(([type, keys]) => {
      const had = Object.hasOwn(copy[part], type) ? copy[part][type]! : [];
      const ships = (shipped.get(type) ?? []).map(({ key }) => key);
      return keys.every((key) => had.includes(key) || ships.includes(key));
    }),
  );
}

/**
 * Whether JSON text names one key twice in an object, at any depth. A
 * reader keeps only the last, so what the first held is lost on reading:
 * such a record was not written by DFAI. Expects text that parses as JSON.
 */
export function jsonHasDuplicateKeys(json: string): boolean {
  const open: { keys: Set<string> | null; wantsKey: boolean }[] = [];
  for (let at = 0; at < json.length; at += 1) {
    const character = json[at];
    if (character === '"') {
      let end = at + 1;
      while (end < json.length && json[end] !== '"') end += json[end] === '\\' ? 2 : 1;
      const top = open.at(-1);
      if (top !== undefined && top.keys !== null && top.wantsKey) {
        const key = JSON.parse(json.slice(at, end + 1)) as string;
        if (top.keys.has(key)) return true;
        top.keys.add(key);
        top.wantsKey = false;
      }
      at = end;
    } else if (character === '{') open.push({ keys: new Set(), wantsKey: true });
    else if (character === '[') open.push({ keys: null, wantsKey: false });
    else if (character === '}' || character === ']') open.pop();
    else if (character === ',') {
      const top = open.at(-1);
      if (top !== undefined && top.keys !== null) top.wantsKey = true;
    }
  }
  return false;
}
