import {
  isSettingsFile,
  jsonHasDuplicateKeys,
  mergeSettingsText,
  mergeShippedPropertiesRecords,
  parseShippedPropertiesRecord,
  sameFrontmatterValue,
  SHIPPED_PROPERTIES_RECORD_PATH,
  shippedPropertiesRecordText,
  ShippedPropertiesRecordError,
  splitFrontmatter,
  writtenMap,
  type SettingsMerged,
  type SettingsText,
  type ShippedPropertiesRecord,
} from '@dfai/domain';
import type { MarkdownPort } from '../notes/ports.ts';

/** The three versions of a file both Macs changed, as text; `base` is null when both made it. */
export interface SettingsVersions {
  readonly path: string;
  readonly base: string | null;
  readonly ours: string;
  readonly theirs: string;
}

/**
 * One file holding both Macs' changes to a settings file of DFAI's own
 * (#233), or null when only a person can merge them and both versions are to
 * be kept. The record of the properties DFAI added to built-in types is the
 * union of both, while each side is exactly as DFAI writes it. Any other
 * `.atlas/` markdown file keeps one side byte for byte and gains, as written,
 * the keys or map entries the other side added — when adding them is all the
 * other side did (ADR-0003).
 */
export function mergeSettings(markdown: MarkdownPort, versions: SettingsVersions): string | null {
  if (versions.path === (SHIPPED_PROPERTIES_RECORD_PATH as string)) return mergeRecords(versions);
  if (!isSettingsFile(versions.path)) return null;
  try {
    return mergeByKeys(markdown, versions);
  } catch {
    // Broad on purpose: whatever throws here — the reader on frontmatter it
    // refuses, or anything else — means the file is a person's to merge, and
    // returning null keeps both versions with a copy. Nothing is written.
    return null;
  }
}

function mergeRecords({ base, ours, theirs }: SettingsVersions): string | null {
  const mine = asAtlasWrote(ours);
  const other = asAtlasWrote(theirs);
  if (mine === null || other === null) return null;
  const was = base === null ? null : readRecord(base);
  // A key the base had and a side no longer has was taken off by hand: a person's to settle.
  if (was !== null && !(holds(mine, was) && holds(other, was))) return null;
  return shippedPropertiesRecordText(mergeShippedPropertiesRecords(mine, other));
}

const RECORD_JSON = /\n```json\n([^\n]*)\n```\n/;

/**
 * A record read back, when its file is the text DFAI writes for it — but for
 * the order of its keys, which older builds did not sort, and an `added` older
 * builds left out. Null for one a person wrote in, around the JSON or inside
 * it (a field of their own, which reading drops): it is kept with a copy,
 * never merged away.
 */
function asAtlasWrote(text: string): ShippedPropertiesRecord | null {
  const record = readRecord(text);
  if (record === null) return null;
  // A key named twice is read as its last: what the first held would be merged away.
  if (jsonHasDuplicateKeys(RECORD_JSON.exec(text)?.[1] ?? '')) return null;
  const withoutKeys = (written: string) => written.replace(RECORD_JSON, '\n```json\n```\n');
  if (withoutKeys(text) !== withoutKeys(shippedPropertiesRecordText(record))) return null;
  const json: unknown = JSON.parse(RECORD_JSON.exec(text)?.[1] ?? 'null');
  const written =
    typeof json === 'object' && json !== null && !Object.hasOwn(json, 'added')
      ? { settled: record.settled }
      : { settled: record.settled, added: record.added };
  return sameFrontmatterValue(json, written) ? record : null;
}

function readRecord(text: string): ShippedPropertiesRecord | null {
  try {
    return parseShippedPropertiesRecord(text);
  } catch (cause) {
    // A record that is not one DFAI wrote is a person's: both are kept as they are.
    if (cause instanceof ShippedPropertiesRecordError) return null;
    throw cause;
  }
}

/** Whether `record` still holds every key `earlier` did. */
const holds = (record: ShippedPropertiesRecord, earlier: ShippedPropertiesRecord) =>
  (['settled', 'added'] as const).every((part) =>
    Object.entries(earlier[part]).every(([name, keys]) =>
      keys.every((key) =>
        (Object.hasOwn(record[part], name) ? record[part][name]! : []).includes(key),
      ),
    ),
  );

/** A version as the merge reads it: its keys as written, its fences, and its values. */
interface ReadSide {
  readonly text: SettingsText;
  readonly opening: string;
  readonly closing: string;
  readonly values: Readonly<Record<string, unknown>>;
}

function mergeByKeys(markdown: MarkdownPort, versions: SettingsVersions): string | null {
  const ours = read(markdown, versions.ours);
  const theirs = read(markdown, versions.theirs);
  if (ours === null || theirs === null) return null;
  const base = versions.base === null ? null : read(markdown, versions.base);
  if (versions.base !== null && base === null) return null;
  for (const [onto, from] of [
    [ours, theirs],
    [theirs, ours],
  ] as const) {
    // The kept side's fences are written: one the other side changed (a BOM, a trailing space) would be lost.
    if (onto.opening !== from.opening || onto.closing !== from.closing) continue;
    const merged = mergeSettingsText({
      base: base?.text ?? null,
      onto: onto.text,
      from: from.text,
    });
    const written = merged === null ? null : checked(markdown, { merged, onto, from });
    if (written !== null) return written;
  }
  return null;
}

/**
 * A YAML anchor (`&name`) or alias (`*name`): one key's value written in terms
 * of another's, so the keys cannot be told apart and merged one by one.
 */
const ANCHOR_OR_ALIAS = /(?:^|[\s[{,])[&*][^\s,\]}]/m;

/**
 * A version whose frontmatter is a map DFAI can cut into its keys exactly as
 * written; null for any other — no frontmatter, one that cannot be read, a
 * list or a bare value, CRLF line endings, anchors or aliases, or keys the reader and the text
 * disagree about (`__proto__`, say, which a reader drops).
 */
function read(markdown: MarkdownPort, file: string): ReadSide | null {
  const { frontmatter, body } = splitFrontmatter(file);
  if (frontmatter === null || frontmatter.includes('\r') || ANCHOR_OR_ALIAS.test(frontmatter)) {
    return null;
  }
  if (markdown.frontmatterProblem(frontmatter) !== null) return null;
  const opening = frontmatter.slice(0, frontmatter.indexOf('\n') + 1);
  const lastLine = frontmatter.lastIndexOf('\n', frontmatter.length - 2) + 1;
  const closing = frontmatter.slice(lastLine);
  const inside = frontmatter.slice(opening.length, lastLine);
  const written = Object.entries(markdown.frontmatterKeyTexts(frontmatter));
  if (written.map(([, text]) => text).join('') !== inside) return null;
  const values = markdown.frontmatterProperties(frontmatter);
  if (
    !sameNames(
      Object.keys(values),
      written.map(([key]) => key),
    )
  )
    return null;
  const keys = written.map(([key, text]) => {
    const map = writtenMap(text);
    const value = values[key];
    const agrees =
      map !== null &&
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      sameNames(
        Object.keys(value),
        map.entries.map(({ name }) => name),
      );
    return { key, text, map: agrees ? map : null };
  });
  return { text: { keys, body }, opening, closing, values };
}

const sameNames = (first: readonly string[], second: readonly string[]) =>
  first.length === second.length && first.every((name, at) => name === second[at]);

/**
 * The merged file, once read back to hold exactly `onto`'s values with
 * `from`'s added ones beside them; null if it reads any other way — an alias
 * resolving to another anchor, say — or cannot be read at all.
 */
function checked(
  markdown: MarkdownPort,
  { merged, onto, from }: { merged: SettingsMerged; onto: ReadSide; from: ReadSide },
): string | null {
  const frontmatter = `${onto.opening}${merged.frontmatter}${onto.closing}`;
  if (markdown.frontmatterProblem(frontmatter) !== null) return null;
  const values = markdown.frontmatterProperties(frontmatter);
  const expected = new Map<string, unknown>(Object.entries(onto.values));
  for (const key of merged.folded.keys) expected.set(key, from.values[key]);
  for (const [key, names] of merged.folded.entries) {
    const own = onto.values[key] as Record<string, unknown>;
    const theirs = from.values[key] as Record<string, unknown>;
    const map = new Map(Object.entries(own));
    for (const name of names) map.set(name, theirs[name]);
    expected.set(key, Object.fromEntries(map));
  }
  if (!sameNames(Object.keys(values), [...expected.keys()])) return null;
  for (const [key, value] of expected) {
    if (!sameFrontmatterValue(values[key], value)) return null;
  }
  return frontmatter + merged.body;
}
