import { MIGRATION_RECORD_PATH, parseMigrationRecord, type MigrationRecord } from '@dfai/domain';
import { findVaultEntry } from '../vault/find-entry.ts';
import type { VaultFsPort } from '../vault/ports.ts';

/**
 * The record as it is on disk, with when it was read and its whole text, for
 * a later write or trash to be held to; null when there is none.
 * A folder on the way to it that cannot be listed is a failure, never "none".
 */
export async function readMigrationRecord(
  fs: VaultFsPort,
): Promise<{ record: MigrationRecord; modified: number; text: string } | null> {
  if ((await findVaultEntry(fs, MIGRATION_RECORD_PATH)) === null) return null;
  const { text, modified } = await fs.readTextFile(MIGRATION_RECORD_PATH);
  return { record: parseMigrationRecord(text), modified, text };
}
