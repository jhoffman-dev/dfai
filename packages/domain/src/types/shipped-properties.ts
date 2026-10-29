import { DAILY_TYPE_FILE } from '../daily/daily-note.ts';
import { MEETING_TYPE } from '../meetings/meeting-header.ts';
import { MEETING_EXTRACTION_PROPERTIES } from '../meetings/meeting-extraction-properties.ts';
import { MEETING_SUMMARY_PROPERTIES } from '../meetings/meeting-summary-block.ts';
import { MEETING_IMPORT_PROPERTIES } from '../meetings/meeting-import-properties.ts';
import { PROPOSAL_TYPE_FILES } from '../proposals/proposal-types.ts';
import { BLOCK_TYPE_FILE } from '../timeblocks/block-type.ts';
import { humanizeKey } from '../page/property-label.ts';
import { createVaultPath, type VaultPath } from '../vault/vault-path.ts';
import { ATLAS_DIRECTORY } from '../vault/vault-visibility.ts';
import { listed } from './para.ts';
import type { ObjectType, PropertyDef } from './property-def.ts';

/**
 * The properties a build of DFAI ships on built-in types, by the type's name.
 * Two Macs on different builds hold different catalogues; a test stands in an
 * older build with a smaller one.
 */
export type ShippedCatalogue = ReadonlyMap<string, readonly PropertyDef[]>;

/**
 * The properties DFAI ships on its own built-in types, by the type's name
 * (#162, ADR-0016's amendment of 2026-10-14). A file written before DFAI
 * shipped one of them lacks it, and a feature built on it fails — Accept on a
 * meeting's action item, for one, links through the Meeting type's `tasks`.
 *
 * Only DFAI's own types are here: Meeting, Proposal, Decision, Daily and
 * Block. Project, Area and Resource are PARA's, and Task's keys come with the
 * move to GTD (ADR-0029): a vault may have shaped them its own way, so what
 * they would gain stays an offer, never done without a yes.
 *
 * Meeting is here though DFAI writes no Meeting file: the import writes its
 * keys (ADR-0027) and meeting extraction links through its relations (P29-05).
 */
export const SHIPPED_PROPERTIES: ShippedCatalogue = new Map([
  ...[...PROPOSAL_TYPE_FILES, DAILY_TYPE_FILE, BLOCK_TYPE_FILE].map(
    (file) => [file.type.name, file.type.properties] as const,
  ),
  [
    MEETING_TYPE,
    [...MEETING_IMPORT_PROPERTIES, ...MEETING_EXTRACTION_PROPERTIES, ...MEETING_SUMMARY_PROPERTIES],
  ],
]);

/**
 * What adding the shipped properties has done in a vault, kept in the vault so
 * it is done once — on whichever Mac opens it first — and a key the person
 * takes off afterwards stays off. Keyed by type name.
 */
export interface ShippedPropertiesRecord {
  /** The shipped keys each type has been given or was found to have. */
  readonly settled: Readonly<Record<string, readonly string[]>>;
  /** The keys DFAI wrote into each type's file. */
  readonly added: Readonly<Record<string, readonly string[]>>;
}

export const NO_SHIPPED_PROPERTIES_RECORD: ShippedPropertiesRecord = { settled: {}, added: {} };

/** Where the record is kept, beside the other migrations' (ADR-0029). */
export const SHIPPED_PROPERTIES_RECORD_PATH: VaultPath = createVaultPath(
  `${ATLAS_DIRECTORY}/migrations/type-properties.md`,
);

/**
 * A built-in type of the vault's whose shipped keys are not all settled yet.
 * `added` is what its file lacks and gains; empty when the file has them all,
 * and the type is only to be recorded as settled.
 */
export interface ShippedPropertiesChange<Type extends ObjectType = ObjectType> {
  readonly before: Type;
  readonly after: ObjectType;
  readonly added: readonly PropertyDef[];
}

/** A vault's type name as the disk compares its file's: in any case. */
const folded = (name: string) => name.trim().toLowerCase();

/** The keys a record holds for a type: its own entry, never one the object inherits. */
export function keysRecorded(
  byType: Readonly<Record<string, readonly string[]>>,
  name: string,
): readonly string[] {
  return Object.hasOwn(byType, name) ? (byType[name] ?? []) : [];
}

/** The keys a record holds for the type named `name` as a type file writes it: by its folded name, as the record keys it. */
export function keysRecordedForType(
  byType: Readonly<Record<string, readonly string[]>>,
  name: string,
): readonly string[] {
  return keysRecorded(byType, folded(name));
}

/** The keys a type file's `properties` declares, as the file writes them — whether or not DFAI can read each. */
export function declaredPropertyKeys(frontmatter: Readonly<Record<string, unknown>>): Set<string> {
  const declared = frontmatter['properties'];
  if (!isObject(declared)) return new Set();
  return new Set(
    Object.keys(declared)
      .map((key) => key.trim())
      .filter((key) => key !== ''),
  );
}

/**
 * The keys a type file declares, when more can be added beside them: its
 * `properties` is a map, or there is none yet. Null when it is something else —
 * a list, a sentence — which is the person's own, and adding DFAI's keys would
 * mean writing over it.
 */
export function addablePropertyKeys(
  frontmatter: Readonly<Record<string, unknown>>,
): Set<string> | null {
  const declared = frontmatter['properties'];
  if (declared !== undefined && declared !== null && !isObject(declared)) return null;
  return declaredPropertyKeys(frontmatter);
}

/** A built-in type whose shipped properties were not added, and why; it is not settled. */
export interface ShippedPropertiesSkip<Type extends ObjectType = ObjectType> {
  /** The type's files: more than one when several say they are it. */
  readonly types: readonly Type[];
  readonly label: string;
  readonly reason: string;
}

/** What adding the shipped properties would do to a vault's types. */
export interface ShippedPropertiesPlan<Type extends ObjectType = ObjectType> {
  readonly changes: readonly ShippedPropertiesChange<Type>[];
  /** Types left alone: their files cannot be added to without the person's hand. */
  readonly skipped: readonly ShippedPropertiesSkip<Type>[];
}

/** Why a type whose `properties` is not a map is left alone. */
export const PROPERTIES_NOT_A_MAP =
  'its `properties` is not a map of keys, so DFAI cannot add to it without writing over what is there.';

/** Why a type whose `properties` cannot gain a line without another changing is left alone. */
export const PROPERTIES_NOT_ADDABLE_AS_LINES =
  'its `properties` is written so that adding to it would change lines it has — as one inline `{…}` map, say — so DFAI left the file as it is.';

/**
 * The vault's own built-in types whose shipped keys are not all settled, each
 * with the keys its file lacks, after its own. Additive only: a key the file
 * declares is left as it is, whatever its shape — or even if DFAI cannot read
 * it — and a settled key is never added again, the person took it off. A type
 * with every shipped key settled is not listed, so a vault already migrated is
 * left alone.
 *
 * A type is skipped, neither changed nor settled, when its file's `properties`
 * is not a map (`declaredKeys` answers null), or when two files say they are
 * that type — a sync's conflict copy, say: which one a feature reads is not
 * the plan's to choose, so the person is asked to merge them.
 *
 * `declaredKeys` says which keys a type's file declares, taken from the file
 * rather than from the properties DFAI could parse out of it; `shipped` is
 * this build's catalogue.
 */
export function shippedPropertiesPlan<Type extends ObjectType>(
  types: readonly Type[],
  record: ShippedPropertiesRecord,
  {
    declaredKeys,
    shipped: catalogue = SHIPPED_PROPERTIES,
  }: {
    declaredKeys: (type: Type) => ReadonlySet<string> | null;
    shipped?: ShippedCatalogue;
  },
): ShippedPropertiesPlan<Type> {
  const changes: ShippedPropertiesChange<Type>[] = [];
  const skipped: ShippedPropertiesSkip<Type>[] = [];
  for (const [name, files] of byFoldedName(types)) {
    const shipped = catalogue.get(name) ?? [];
    const settled = new Set(keysRecorded(record.settled, name));
    if (shipped.every((property) => settled.has(property.key))) continue;
    const [type, ...others] = files as [Type, ...Type[]];
    const label = humanizeKey(name);
    if (others.length > 0) {
      skipped.push({ types: files, label, reason: duplicatedReason(files.length, label) });
      continue;
    }
    const has = declaredKeys(type);
    if (has === null) {
      skipped.push({ types: files, label, reason: PROPERTIES_NOT_A_MAP });
      continue;
    }
    const added = shipped.filter(
      (property) => !has.has(property.key) && !settled.has(property.key),
    );
    changes.push({
      before: type,
      after: { ...type, properties: [...type.properties, ...added] },
      added,
    });
  }
  return { changes, skipped };
}

/** The types by their folded name, each name's files in the order given. */
function byFoldedName<Type extends ObjectType>(types: readonly Type[]): Map<string, Type[]> {
  const grouped = new Map<string, Type[]>();
  for (const type of types) {
    const name = folded(type.name);
    grouped.set(name, [...(grouped.get(name) ?? []), type]);
  }
  return grouped;
}

const duplicatedReason = (count: number, label: string) =>
  `${count === 2 ? 'two' : count} files say they are the ${label} type: merge them into one, and DFAI will add its properties to it.`;

/**
 * The record once `changes` are done: each type's shipped keys settled — the
 * ones it had as well as the ones it gained — and what was added kept.
 */
export function recordSettling(
  record: ShippedPropertiesRecord,
  changes: readonly ShippedPropertiesChange[],
  catalogue: ShippedCatalogue = SHIPPED_PROPERTIES,
): ShippedPropertiesRecord {
  const settled = { ...record.settled };
  const added = { ...record.added };
  for (const change of changes) {
    const name = folded(change.before.name);
    const shipped = (catalogue.get(name) ?? []).map((property) => property.key);
    settled[name] = union(keysRecorded(settled, name), shipped);
    if (change.added.length > 0) {
      added[name] = union(
        keysRecorded(added, name),
        change.added.map((property) => property.key),
      );
    }
  }
  return { settled, added };
}

const union = (first: readonly string[], second: readonly string[]): string[] => [
  ...new Set([...first, ...second]),
];

/**
 * What Activity says of a type that gained shipped properties on opening:
 * "Added Tasks and Decisions to the Meeting type, which was written before DFAI shipped them."
 */
export function shippedPropertiesLine({
  label,
  added,
}: {
  label: string;
  added: readonly string[];
}): string {
  const them = added.length === 1 ? 'it' : 'them';
  return `Added ${listed(added)} to the ${label} type, which was written before DFAI shipped ${them}.`;
}

/**
 * What Activity says of a built-in type left alone on opening:
 * "DFAI did not add its built-in properties to the Meeting type: two files say they are the Meeting type: …"
 */
export function shippedPropertiesSkippedLine({
  label,
  reason,
}: {
  label: string;
  reason: string;
}): string {
  return `DFAI did not add its built-in properties to the ${label} type: ${reason}`;
}

/** A record that cannot be trusted: its file is not one DFAI wrote. */
export class ShippedPropertiesRecordError extends Error {
  constructor(reason: string) {
    super(
      `The record of the properties DFAI added to built-in types (${SHIPPED_PROPERTIES_RECORD_PATH}) cannot be read, so none were added: ${reason}`,
    );
    this.name = 'ShippedPropertiesRecordError';
  }
}

const FENCE = '```';
const OPENING = `\n${FENCE}json\n`;

/**
 * Two Macs' records as one (#233): every key either settled or added, kept.
 * A record only ever grows — a settled key is never unsettled — so the union
 * is what both would have written had they run one after the other.
 */
export function mergeShippedPropertiesRecords(
  first: ShippedPropertiesRecord,
  second: ShippedPropertiesRecord,
): ShippedPropertiesRecord {
  const merged = (one: KeysByType, other: KeysByType) =>
    Object.fromEntries(
      [...new Set([...Object.keys(one), ...Object.keys(other)])].map((name) => [
        name,
        union(keysRecorded(one, name), keysRecorded(other, name)),
      ]),
    );
  return {
    settled: merged(first.settled, second.settled),
    added: merged(first.added, second.added),
  };
}

type KeysByType = Readonly<Record<string, readonly string[]>>;

/** The keys by type in one order, whatever order they were settled in: the same record is the same bytes on every Mac. */
const canonical = (byType: KeysByType): Record<string, string[]> =>
  Object.fromEntries(
    Object.keys(byType)
      .sort()
      .map((name) => [name, [...new Set(keysRecorded(byType, name))].sort()]),
  );

/**
 * The record as its file is written: a heading a person can read, then the
 * record as JSON, its types and keys sorted so two Macs that settled the same
 * keys in a different order write the same bytes (#233).
 */
export function shippedPropertiesRecordText(record: ShippedPropertiesRecord): string {
  return [
    '---',
    'atlas: migration',
    '---',
    '',
    '# Properties added to built-in types',
    '',
    'DFAI adds a property it ships on a built-in type once, to a type file written before it',
    'shipped, and never changes one the file has. A settled key is not added again: one taken',
    'off since stays off.',
    '',
    `${FENCE}json`,
    JSON.stringify({ settled: canonical(record.settled), added: canonical(record.added) }),
    FENCE,
    '',
  ].join('\n');
}

/** Reads a record back; a file any tool could have written is trusted only as keys by type. */
export function parseShippedPropertiesRecord(written: string): ShippedPropertiesRecord {
  // Another tool, or a sync on Windows, may have turned its line endings to CRLF.
  const text = written.replace(/\r\n/g, '\n');
  const opening = text.indexOf(OPENING);
  const start = opening + OPENING.length;
  const end = opening === -1 ? -1 : text.indexOf(`\n${FENCE}`, start);
  if (end === -1) throw new ShippedPropertiesRecordError('it has no list of keys.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end));
  } catch {
    throw new ShippedPropertiesRecordError('its list of keys is not JSON.');
  }
  if (!isObject(parsed) || !isKeysByType(parsed['settled'])) {
    throw new ShippedPropertiesRecordError('it does not say which keys are settled.');
  }
  const added = parsed['added'] ?? {};
  if (!isKeysByType(added)) {
    throw new ShippedPropertiesRecordError('it does not say which keys were added.');
  }
  return { settled: parsed['settled'], added };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isKeysByType = (value: unknown): value is Record<string, string[]> =>
  isObject(value) &&
  Object.values(value).every(
    (keys) => Array.isArray(keys) && keys.every((key) => typeof key === 'string'),
  );
