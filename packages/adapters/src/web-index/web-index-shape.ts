/**
 * What the browser's index keeps beyond the host's tables: each note's
 * version, as the vault reports it (`modified`, ADR-0053). The host's
 * `files.modified` holds when a note was written, which the GitHub vault
 * cannot tell (NULL), so the version a refresh compares to tell what changed
 * is kept here, by path (#666).
 */
const MANIFEST_TABLE = `
CREATE TABLE IF NOT EXISTS manifest (
    path    TEXT PRIMARY KEY,
    version INTEGER NOT NULL
);`;

/** The browser index's tables, and the version of their shape. */
export interface WebIndexShape {
  readonly schema: string;
  /** Kept in `PRAGMA user_version`: an index of another is thrown away and rebuilt. */
  readonly version: number;
}

/**
 * The browser's index made from the host's own tables — the text of
 * `index_schema.sql`, never a copy of it (#134) — then the manifest. Its
 * version is a hash of the whole text, so any change to either makes an
 * index of the old shape be rebuilt, as the host's SCHEMA_VERSION does, with
 * no number to remember to bump. Kept to 31 bits, so it reads back positive.
 */
export function webIndexShape(hostSchema: string): WebIndexShape {
  const schema = `${hostSchema}\n${MANIFEST_TABLE}`;
  return { schema, version: fnv1a(schema) & 0x7fffffff };
}

/** FNV-1a over a text's UTF-16 code units: a stable fingerprint, not a secret. */
export function fnv1a(text: string, seed = 0x811c9dc5): number {
  let hash = seed;
  for (let at = 0; at < text.length; at++) {
    hash ^= text.charCodeAt(at);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}
