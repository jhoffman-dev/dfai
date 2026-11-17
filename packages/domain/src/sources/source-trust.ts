import { SOURCES_DIRECTORY } from '../vault/vault-visibility.ts';
import type { Datasource } from './datasource.ts';
import { secretsUsedBy } from './source-request.ts';
import { isOutsideVault } from './sqlite-file.ts';

/** System lives in Pages, which a first run hides (#902): the way to it. */
const SHOW_PAGES_HINT = "If Pages isn't in the sidebar, show it from the sidebar's … menu.";

/**
 * Why a source may not run from where its note is, or null when it may.
 *
 * A source that sends a Keychain secret, or reads a SQLite file from outside
 * the vault, reaches things only the user should point it at. Anything that
 * can write a note in user space — the local API, a synced folder, a pasted
 * note — could otherwise aim the secret at a URL of its choosing, or copy any
 * database on the disk into notes it can read back. So such a source runs
 * only from `.atlas/sources`, which the API cannot write (ADR-0017). A plain
 * public feed, or a file inside the vault, runs from anywhere.
 */
export function sourceTrustRefusal({
  source,
  sourcePath,
}: {
  source: Datasource;
  /** The source note's vault path, as the vault spells it. */
  sourcePath: string;
}): string | null {
  if (sourcePath.startsWith(`${SOURCES_DIRECTORY}/`)) return null;
  const secrets = secretsUsedBy(source);
  if (secrets.length > 0) {
    const named = secrets.map((name) => `“${name}”`).join(', ');
    return (
      `This source sends the secret ${named}, so it runs only from ${SOURCES_DIRECTORY}. ` +
      `Move the note there (System → sources) to refresh it. ${SHOW_PAGES_HINT}`
    );
  }
  if (source.format === 'sqlite' && source.file !== null && isOutsideVault(source.file)) {
    return (
      `This source reads a database outside the vault, so it runs only from ` +
      `${SOURCES_DIRECTORY}. Move the note there (System → sources) to refresh it. ` +
      SHOW_PAGES_HINT
    );
  }
  return null;
}
