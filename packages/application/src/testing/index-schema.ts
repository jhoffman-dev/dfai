import { readFileSync } from 'node:fs';

/**
 * The index's tables and indexes, read from the one file the host makes them
 * from (`apps/desktop/src-tauri/src/index_schema.sql`, which index.rs
 * `include_str!`s), so a test index is the shape the app's is and cannot drift
 * from it (#134). Read from disk, so Node only. Test support only.
 */
export const INDEX_SCHEMA = readFileSync(
  new URL('../../../../apps/desktop/src-tauri/src/index_schema.sql', import.meta.url),
  'utf8',
);
