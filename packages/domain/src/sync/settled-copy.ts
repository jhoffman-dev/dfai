import type { ShippedCatalogue, ShippedPropertiesRecord } from '../types/shipped-properties.ts';
import { sameFrontmatterValue } from './settings-merge.ts';

/**
 * Whether an old `.atlas` conflict copy can go (#235, ADR-0048). Merging it
 * into its live file changing nothing says the copy holds nothing more; it
 * does not say why the live file holds more. A key the live file has and the
 * copy lacks may be one a person took off on the copy's Mac, and the copy is
 * then the only sign of it. So the copy goes only when every such key is one
 * DFAI wrote into the live file itself.
 */

/**
 * What the live file has and the copy lacks, as paths of keys from the top:
 * `['when', 'status']` for a `status` the copy's `when` lacks. A key whose
 * value is a map on both sides is walked into; any other value the two do
 * not say the same counts whole.
 */
export type LiveExtras = readonly (readonly string[])[];

const PROPERTIES = 'properties';

const isMap = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);

/** Every path in `live`'s frontmatter that `copy`'s lacks, at any depth. */
export function liveExtras({
  live,
  copy,
}: {
  live: Readonly<Record<string, unknown>>;
  copy: Readonly<Record<string, unknown>>;
}): LiveExtras {
  return pathsMissing(live, copy, []);
}

function pathsMissing(
  live: Readonly<Record<string, unknown>>,
  copy: Readonly<Record<string, unknown>>,
  at: readonly string[],
): LiveExtras {
  return Object.entries(live).flatMap(([key, value]): LiveExtras => {
    const path = [...at, key];
    if (!Object.hasOwn(copy, key)) return [path];
    const theirs = copy[key];
    if (isMap(value) && isMap(theirs)) return pathsMissing(value, theirs, path);
    return sameFrontmatterValue(value, theirs) ? [] : [path];
  });
}

/** Whether every extra is a whole property the vault's record says DFAI added to this type's file. */
export function extrasDfaiWrote({
  extras,
  added,
}: {
  extras: LiveExtras;
  added: readonly string[];
}): boolean {
  return extras.every(
    (path) => path.length === 2 && path[0] === PROPERTIES && added.includes(path[1]!),
  );
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
 * such a record was not written by DFAI — nor was text that is not JSON at
 * all, for which this is true too.
 */
export function jsonHasDuplicateKeys(json: string): boolean {
  try {
    JSON.parse(json);
  } catch {
    // Safe to ignore: text that does not parse is not a record DFAI wrote, which is the answer.
    return true;
  }
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
