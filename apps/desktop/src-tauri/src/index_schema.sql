-- The index's tables, the one copy (#134). The host makes them from this file
-- (`include_str!` in index.rs), and the TypeScript test indexes and the SQLite
-- tests read it too, so no copy can drift: `index-schema.test.ts` fails if one does.
-- A change of shape here also bumps SCHEMA_VERSION in index.rs, so an index of
-- the old shape is thrown away and rebuilt rather than read wrong.

            CREATE TABLE IF NOT EXISTS files (
                path     TEXT PRIMARY KEY,
                title    TEXT NOT NULL,
                summary  TEXT NOT NULL DEFAULT '',
                modified INTEGER NOT NULL,
                size     INTEGER NOT NULL,
                digest   TEXT NOT NULL DEFAULT '',
                note_type TEXT,
                progress INTEGER
            );

            CREATE TABLE IF NOT EXISTS props (
                path       TEXT NOT NULL,
                key        TEXT NOT NULL,
                idx        INTEGER NOT NULL DEFAULT 0,
                value_text TEXT,
                value_num  REAL,
                value_date TEXT,
                value_json TEXT
            );
            CREATE INDEX IF NOT EXISTS props_path ON props(path, key, value_text);
            CREATE INDEX IF NOT EXISTS props_key ON props(key, value_text);
            CREATE INDEX IF NOT EXISTS props_type_fold ON props(key, lower(trim(value_text)), path);

            CREATE TABLE IF NOT EXISTS links (
                src    TEXT NOT NULL,
                dst    TEXT,
                target TEXT NOT NULL,
                kind   TEXT NOT NULL,
                leaf   TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS links_src ON links(src);
            CREATE INDEX IF NOT EXISTS links_dst ON links(dst, src);
            CREATE INDEX IF NOT EXISTS links_leaf ON links(leaf, dst, src);

            CREATE TABLE IF NOT EXISTS tags (
                path TEXT NOT NULL,
                idx  INTEGER NOT NULL,
                tag  TEXT NOT NULL,
                name TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS tags_path ON tags(path);
            CREATE INDEX IF NOT EXISTS tags_tag ON tags(tag);

            CREATE TABLE IF NOT EXISTS relations (
                src    TEXT NOT NULL,
                key    TEXT NOT NULL,
                idx    INTEGER NOT NULL,
                target TEXT NOT NULL,
                name   TEXT NOT NULL DEFAULT '',
                dst    TEXT
            );
            CREATE INDEX IF NOT EXISTS relations_src ON relations(src, key);
            CREATE INDEX IF NOT EXISTS relations_dst ON relations(dst, src);

            CREATE TABLE IF NOT EXISTS blocks (
                path TEXT NOT NULL,
                idx  INTEGER NOT NULL,
                id   TEXT NOT NULL,
                text TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS blocks_path ON blocks(path);
            CREATE INDEX IF NOT EXISTS blocks_id ON blocks(id);

            CREATE TABLE IF NOT EXISTS checks (
                path TEXT NOT NULL,
                idx  INTEGER NOT NULL,
                done INTEGER NOT NULL,
                text TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS checks_path ON checks(path);

            CREATE TABLE IF NOT EXISTS highlights (
                path    TEXT NOT NULL,
                idx     INTEGER NOT NULL,
                id      TEXT NOT NULL,
                kind    TEXT NOT NULL,
                quote   TEXT NOT NULL,
                comment TEXT NOT NULL,
                mark    TEXT NOT NULL,
                color   TEXT NOT NULL,
                anchor  TEXT NOT NULL
            );
            -- By note then place: a note's highlights in order, and All highlights read
            -- page after page by key (`(path, idx) > (?, ?)`) rather than by offset.
            CREATE INDEX IF NOT EXISTS highlights_path_idx ON highlights(path, idx);
            CREATE INDEX IF NOT EXISTS highlights_id ON highlights(id);

            -- A highlight's search row has the rowid of its row in `highlights`.
            CREATE VIRTUAL TABLE IF NOT EXISTS highlights_fts USING fts5(
                quote,
                comment,
                tokenize = 'unicode61 remove_diacritics 2'
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
                path,
                title,
                body,
                tokenize = 'unicode61 remove_diacritics 2'
            );
            