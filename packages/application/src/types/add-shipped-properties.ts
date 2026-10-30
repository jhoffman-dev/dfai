import {
  addablePropertyKeys,
  NO_SHIPPED_PROPERTIES_RECORD,
  parentVaultPath,
  parseShippedPropertiesRecord,
  PROPERTIES_NOT_ADDABLE_AS_LINES,
  propertySpec,
  recordSettling,
  SHIPPED_PROPERTIES_RECORD_PATH,
  shippedPropertiesPlan,
  shippedPropertiesRecordText,
  splitFrontmatter,
  type ShippedCatalogue,
  type ShippedPropertiesChange,
  type ShippedPropertiesRecord,
  type VaultPath,
} from '@dfai/domain';
import type { MarkdownPort } from '../notes/ports.ts';
import { ensureFolder } from '../vault/create-folder.ts';
import { findVaultEntry } from '../vault/find-entry.ts';
import type { VaultFsPort } from '../vault/ports.ts';
import { loadObjectTypes, type DefinedType } from './load-types.ts';

/** A built-in type file that gained properties DFAI ships, for Activity to say so. */
export interface ShippedPropertiesGained {
  readonly path: VaultPath;
  readonly label: string;
  /** The labels of the properties it gained, in the order they were added. */
  readonly added: readonly string[];
}

/** Something the properties could not be added to, and why. */
export interface ShippedPropertiesFailure {
  /** The type's label; `any type` when the record could not be read, `its record` when not written. */
  readonly name: string;
  readonly reason: string;
}

/** A built-in type left alone, and why: it is not settled, so it is looked at again next time. */
export interface ShippedPropertiesSkipped {
  /** Its file — the first of them, when several say they are the type. */
  readonly path: VaultPath;
  readonly label: string;
  readonly reason: string;
}

export interface ShippedPropertiesAdded {
  readonly gained: readonly ShippedPropertiesGained[];
  readonly skipped: readonly ShippedPropertiesSkipped[];
  readonly failed: readonly ShippedPropertiesFailure[];
}

interface TypePorts {
  readonly fs: VaultFsPort;
  readonly markdown: MarkdownPort;
  /** This build's catalogue; a test stands in an older build's. */
  readonly shipped?: ShippedCatalogue;
}

/**
 * Gives each of DFAI's own built-in type files the vault has (Meeting,
 * Proposal, Decision, Daily, Block, and Task for `focus` alone — never
 * PARA's, nor Task's GTD keys) the properties DFAI ships on it and the file
 * predates (#162), and records its shipped keys
 * as settled in `.atlas/migrations/type-properties.md` so it is done once —
 * including those a complete file already had, so a key the person removes
 * later stays removed.
 *
 * Each file gains only lines: the properties added are put in after the last
 * of its own, at their indentation, and every line it had — its body, its
 * comments, how its values are written — stays byte for byte. A file that
 * cannot be added to that way (an inline `{…}` map, `properties` that is a
 * list), and a type two files claim, is left alone and said so. A type left
 * alone, or whose file could not be written, is not settled, so it is looked
 * at again the next time the vault opens. A record that cannot be read — its
 * folder failing to list included — stops it before anything is written.
 */
export async function addShippedProperties(ports: TypePorts): Promise<ShippedPropertiesAdded> {
  let found: Awaited<ReturnType<typeof readRecord>>;
  try {
    found = await readRecord(ports.fs);
  } catch (cause) {
    return {
      gained: [],
      skipped: [],
      failed: [{ name: 'any type', reason: reasonOf(cause) }],
    };
  }
  const record = found?.record ?? NO_SHIPPED_PROPERTIES_RECORD;
  const types = await loadObjectTypes(ports);
  const declared = await declaredKeysByPath(ports, types);
  const plan = shippedPropertiesPlan(types, record, {
    declaredKeys: (type) => declared.get(type.path) ?? null,
    ...(ports.shipped === undefined ? {} : { shipped: ports.shipped }),
  });
  const complete = plan.changes.filter((change) => change.added.length === 0);

  const writes = await writeChanges(
    ports,
    plan.changes.filter((change) => change.added.length > 0),
  );
  const { written, failed } = writes;
  const skipped = [
    ...plan.skipped.map(({ types: files, label, reason }) => ({
      path: files[0]!.path,
      label,
      reason,
    })),
    ...writes.skipped,
  ];
  const settled = [...written, ...complete];
  if (settled.length > 0) {
    try {
      await writeRecord(
        ports.fs,
        recordSettling(record, settled, ports.shipped),
        found?.modified ?? null,
      );
    } catch (cause) {
      failed.push({ name: 'its record', reason: reasonOf(cause) });
    }
  }
  const gained = written.map(({ before, added }) => ({
    path: before.path,
    label: before.label,
    added: added.map((property) => property.label),
  }));
  return { gained, skipped, failed };
}

/** The keys each type file declares, read from the file itself; null where they are not a map. */
async function declaredKeysByPath(
  { fs, markdown }: TypePorts,
  types: readonly DefinedType[],
): Promise<Map<VaultPath, Set<string> | null>> {
  const files = types.length === 0 ? [] : await fs.readNotes(types.map((type) => type.path));
  return new Map(
    files.map((file) => [
      file.path as VaultPath,
      addablePropertyKeys(markdown.frontmatterProperties(splitFrontmatter(file.text).frontmatter)),
    ]),
  );
}

/** Writes each type's change, carrying on past one that fails or is left alone. */
async function writeChanges(
  ports: TypePorts,
  changes: readonly ShippedPropertiesChange<DefinedType>[],
) {
  const written: ShippedPropertiesChange<DefinedType>[] = [];
  const skipped: ShippedPropertiesSkipped[] = [];
  const failed: ShippedPropertiesFailure[] = [];
  for (const change of changes) {
    const { before } = change;
    try {
      if (await addLines(ports, change)) written.push(change);
      else {
        skipped.push({
          path: before.path,
          label: before.label,
          reason: PROPERTIES_NOT_ADDABLE_AS_LINES,
        });
      }
    } catch (cause) {
      failed.push({ name: before.label, reason: reasonOf(cause) });
    }
  }
  return { written, skipped, failed };
}

/**
 * Puts the properties a change adds into its file as lines after the file's
 * own, refused if the file moved on since it was read; false, with nothing
 * written, when they cannot be added without changing a line it has.
 */
async function addLines(
  { fs, markdown }: TypePorts,
  { before, added }: ShippedPropertiesChange<DefinedType>,
): Promise<boolean> {
  const { text, modified } = await fs.readTextFile(before.path);
  const { frontmatter, body } = splitFrontmatter(text);
  const entries = Object.fromEntries(
    added.map((property) => [property.key, propertySpec(property)]),
  );
  const written =
    frontmatter === null ? null : markdown.addToFrontmatterMap(frontmatter, 'properties', entries);
  if (written === null) return false;
  await fs.writeTextFile({
    path: before.path,
    contents: written + body,
    expectedModified: modified,
  });
  return true;
}

/**
 * The record as it is on disk, with when it was read; null when there is none.
 * A folder on the way to it that cannot be listed is a failure, never "none".
 */
async function readRecord(
  fs: VaultFsPort,
): Promise<{ record: ShippedPropertiesRecord; modified: number } | null> {
  if ((await findVaultEntry(fs, SHIPPED_PROPERTIES_RECORD_PATH)) === null) return null;
  const { text, modified } = await fs.readTextFile(SHIPPED_PROPERTIES_RECORD_PATH);
  return { record: parseShippedPropertiesRecord(text), modified };
}

/** Writes the record over the one read — refused if it changed since — or makes it. */
async function writeRecord(
  fs: VaultFsPort,
  record: ShippedPropertiesRecord,
  modified: number | null,
): Promise<void> {
  const contents = shippedPropertiesRecordText(record);
  if (modified !== null) {
    await fs.writeTextFile({
      path: SHIPPED_PROPERTIES_RECORD_PATH,
      contents,
      expectedModified: modified,
    });
    return;
  }
  await ensureFolder({ fs, folder: parentVaultPath(SHIPPED_PROPERTIES_RECORD_PATH) });
  await fs.createNote({ path: SHIPPED_PROPERTIES_RECORD_PATH, contents });
}

const reasonOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
