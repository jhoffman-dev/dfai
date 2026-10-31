import SCHEMA from '../../../../apps/desktop/src-tauri/src/index_schema.sql?raw';

/**
 * The index's tables and indexes: the text of the one file the host makes them
 * from (`apps/desktop/src-tauri/src/index_schema.sql`, which index.rs
 * `include_str!`s), so a test index is the shape the app's is and cannot drift
 * from it (#134). Taken as text by the bundler (`?raw`) rather than read from
 * disk, so it loads in jsdom, where a module's URL is not a file's, as well as
 * in Node. Test support only.
 */
export const INDEX_SCHEMA: string = SCHEMA;
