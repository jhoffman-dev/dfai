//! The derived index.
//!
//! Everything here is a cache of what the markdown files already say. It can be
//! deleted at any time and rebuilt from the vault, which is the invariant that
//! keeps the files the source of truth rather than this database.
//!
//! This module stores and queries. It decides nothing: what a note's title is,
//! which properties it has and where a link points are all settled in TypeScript
//! and handed here as rows.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
use rusqlite::{params, Connection, OpenFlags, Statement};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::vault::VaultState;

/// Bumped whenever the shape below changes, or what TypeScript stores in it
/// does (3: `title` became the page's title rather than the filename; 4: it
/// stopped preferring a leading `# heading`, so lists match the page head; 5:
/// every use of a tag, which TypeScript finds, gained a table; 6: a tag's
/// name may not start or end with `_`, and `F#` no longer closes one; 7:
/// every property written as a wiki link gained a row in `relations`, with the
/// note TypeScript resolved it to; 8: each relation row carries the name
/// TypeScript folded its target to, so stale relations are found without
/// SQLite's ASCII-only lower(); 9: every block with an id, which TypeScript
/// reads, gained a row in `blocks`; 10: templates left the vault's notes
/// (ADR-0026), and a note unchanged since then still held link rows resolved
/// to one, so every note is read again; 11: each file keeps the digest of its
/// text and the type it declares, both worked out in TypeScript, so a refresh
/// can say what changed and what a removed note was; 12: every checklist box,
/// which TypeScript reads, gained a row in `checks`, and each file the
/// progress TypeScript worked out from them — a branch had shipped that as 11
/// too, so an 11 of either shape is rebuilt; 13: `props_path` covers the key
/// as well as the path (#123) — a statement asking for one key of one note was
/// planned through `props_key`, every row of that key in the vault, once per
/// note, since nothing here gathers the statistics that would say otherwise);
/// 14: a note's row in the search table has the rowid of its row in `files`
/// (#135) — the table has no index on `path`, so finding a note's row by its
/// path read every row, once per note written); 15: `props_path` covers the
/// value as well (#143) — with two columns each, `props_path` and `props_key`
/// tied for asking for one value of one key of one note, and the order they
/// were made in chose `props_key`, so a view over every meeting ran out of
/// its budget at a few hundred of them; and `links_dst` and `relations_dst`
/// cover the source as well — asking whether one note links to, or names,
/// another fixes both ends, and `links_src` or `relations_src` tied with the
/// `dst` index, which won and read every link or relation into the other note
/// once per note, so `LINKS TO this` and `CONNECTED TO this` over a person in
/// a thousand meetings ran out too).
/// A mismatch throws the cache away rather than trying to migrate something
/// that can simply be rebuilt. 16: a note's path is searched as well (#211) —
/// a meeting's day is in its file name, not its title or body, so searching
/// for the day found none of that day's meetings. 17: only the file name stem
/// is searched, not the folders or `.md` — a folder named for a project put
/// every note in it ahead of the notes that mention the project, and "md"
/// matched every note. 18: a body link keeps the last part of its target as
/// links fold it (`links.leaf`), indexed, so a refresh finds the links a note
/// just made could mean (#431) by a lookup rather than a scan. 19: every
/// highlight in a literature note, which TypeScript reads, gained a row in
/// `highlights` (#503, ADR-0043). 20: each highlight's quote and comment are
/// searched too (`highlights_fts`, #507), so a search can open a highlight, and
/// they are read in order by `highlights_path_idx` (path, idx).
const SCHEMA_VERSION: i64 = 20;

const CACHE_DIR: &str = ".atlas-cache";
const DATABASE: &str = "index.sqlite";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedProperty {
    pub key: String,
    #[serde(default)]
    pub index: i64,
    pub text: Option<String>,
    pub number: Option<f64>,
    pub date: Option<String>,
    pub json: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedLink {
    /// The link exactly as written.
    pub target: String,
    /// The last part of the target as TypeScript folds link names; stored,
    /// never computed here. Required: a link sent without it could never be
    /// found again when the note it names is made.
    pub leaf: String,
    /// The note it resolves to, or None when it points nowhere yet.
    pub path: Option<String>,
    pub kind: String,
}

/// One link held by a property, and the note TypeScript resolved it to. What
/// counts as one, and where it points, is decided there (ADR-0019).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedRelation {
    /// The property holding the link.
    pub key: String,
    /// Its place in the property's list; 0 for a single value.
    #[serde(default)]
    pub index: i64,
    /// The link's target exactly as written.
    pub target: String,
    /// The target as TypeScript folds link names; stored, never computed here.
    #[serde(default)]
    pub name: String,
    /// The note it resolves to, or None when it points nowhere yet.
    pub path: Option<String>,
}

/// One use of a tag, as TypeScript read it. What counts as a tag is decided there.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedTag {
    /// What makes it the same tag as another.
    pub key: String,
    /// As written in this note.
    pub name: String,
}

/// A block with an id (`^abc123`), as TypeScript read it. What counts as one is decided there.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedBlock {
    pub id: String,
    /// A line of what the block says.
    pub text: String,
}

/// A highlight in a literature note, as TypeScript read it. What counts as one is decided there.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedHighlight {
    /// Its block id, `^id` in the note.
    pub id: String,
    /// `pdf`, `epub` or `kindle`.
    pub kind: String,
    /// The quoted words, without their markdown escapes.
    pub quote: String,
    /// The person's comment, as markdown.
    pub comment: String,
    pub mark: String,
    pub color: String,
    /// The marker's JSON: where the highlight is in its file, and its style.
    pub anchor: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedNote {
    pub path: String,
    pub title: String,
    pub modified: u64,
    pub size: u64,
    /// A digest of the note's whole text, as TypeScript computed it; stored, never computed here.
    #[serde(default)]
    pub digest: String,
    /// The type the note declares, as TypeScript read it; stored, never decided here.
    #[serde(default, rename = "type")]
    pub note_type: Option<String>,
    /// Plain text used for searching; not the markdown source.
    pub body: String,
    /// The opening line, for showing what a note is about without opening it.
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub properties: Vec<IndexedProperty>,
    #[serde(default)]
    pub links: Vec<IndexedLink>,
    #[serde(default)]
    pub tags: Vec<IndexedTag>,
    #[serde(default)]
    pub relations: Vec<IndexedRelation>,
    #[serde(default)]
    pub blocks: Vec<IndexedBlock>,
    #[serde(default)]
    pub checks: Vec<IndexedCheck>,
    /// How far through its checklist the note is, as TypeScript worked it out.
    #[serde(default)]
    pub progress: Option<i64>,
    #[serde(default)]
    pub highlights: Vec<IndexedHighlight>,
}

/// A checklist box (`- [ ]`), as TypeScript read it. What counts as one is decided there.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedCheck {
    pub done: bool,
    /// The words on its line.
    pub text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexEntry {
    pub path: String,
    pub modified: u64,
    pub size: u64,
    pub digest: String,
    #[serde(rename = "type")]
    pub note_type: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub title: String,
    pub snippet: String,
    /// The highlight's block id, for a hit that is a highlight in the note (#507); none for the note.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStats {
    pub notes: i64,
    pub properties: i64,
    pub links: i64,
}

/// A vault's index: the connection that writes it and the one queries read
/// it through, each with the vault it was opened for.
///
/// No command on the index runs on the main thread, which is the window's:
/// building an index is thousands of rows written a batch at a time, and the
/// window froze for each batch (#135). Off it, commands overlap, so the locks
/// here are what order them — the main thread no longer does:
///
/// - whatever throws the index's file away (`open`, `clear`) holds both, the
///   writer's first and then the reader's, from before the file goes until
///   the new one is whole. So nothing writes to, opens or reads a file that
///   is half way to being an index;
/// - everything else holds one of them.
///
/// The reader is a second connection to the same file, opened read-only.
/// Queries someone writes run on it. Read-only is enforced by SQLite when the
/// connection is opened — but a read-only connection still runs ATTACH,
/// VACUUM INTO and pragma setters, so `run_query` also has SQLite refuse
/// anything that is not a read of this database (see `prepare_read`). It is
/// let go whenever the file is replaced: kept, it went on answering from the
/// file that had been deleted, until the app was restarted (#137).
#[derive(Default)]
pub struct IndexState {
    writer: Mutex<Option<Held>>,
    reader: Mutex<Option<Held>>,
}

/// A connection, and the vault whose index it is a connection to.
struct Held {
    root: PathBuf,
    connection: Connection,
}

impl IndexState {
    /// Opens the index of the vault at `root`, in place of whichever was open.
    pub fn open(&self, root: &Path) -> Result<IndexOpened, String> {
        self.replace(root, false)
    }

    /// Throws the index of the vault at `root` away and makes it again, empty.
    pub fn clear(&self, root: &Path) -> Result<(), String> {
        self.replace(root, true).map(|_| ())
    }

    fn replace(&self, root: &Path, discarding: bool) -> Result<IndexOpened, String> {
        let mut writer = self.writer.lock().map_err(|_| "index state poisoned")?;
        let mut reader = self.reader.lock().map_err(|_| "query state poisoned")?;
        // Both let go before the file is touched: a connection outliving its
        // file answers from the deleted one.
        *reader = None;
        *writer = None;
        if discarding {
            discard(&database_path(root)?);
        }
        let (connection, opened) = open_database(root)?;
        *writer = Some(Held {
            root: root.to_path_buf(),
            connection,
        });
        Ok(opened)
    }

    /// Runs `action` on the writing connection.
    fn with_connection<T>(
        &self,
        action: impl FnOnce(&mut Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut writer = self.writer.lock().map_err(|_| "index state poisoned")?;
        let held = writer.as_mut().ok_or("the index is not open")?;
        action(&mut held.connection)
    }

    /// Runs a write that was meant for one vault's index, and refuses it when
    /// the index open now is another's: a batch read from a vault that has
    /// since been switched away from must not land in the next one (#135).
    /// A write that names no vault is whichever index is open's.
    fn write<T>(
        &self,
        meant_for: Option<&str>,
        action: impl FnOnce(&mut Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut writer = self.writer.lock().map_err(|_| "index state poisoned")?;
        let held = writer.as_mut().ok_or("the index is not open")?;
        if meant_for.is_some_and(|meant| Path::new(meant) != held.root) {
            return Err("another vault was opened before this could be indexed".into());
        }
        action(&mut held.connection)
    }

    /// Adds or replaces a batch of notes in the index of the vault it names.
    pub fn put(&self, meant_for: Option<&str>, notes: &[IndexedNote]) -> Result<(), String> {
        self.write(meant_for, |connection| put_notes(connection, notes))
    }

    /// Runs a read someone wrote against the index of the vault at `root`.
    pub fn query(
        &self,
        root: &Path,
        sql: &str,
        parameters: &[serde_json::Value],
    ) -> Result<QueryResult, String> {
        let mut reader = self.reader.lock().map_err(|_| "query state poisoned")?;
        // Another vault's reader is no answer for this one, whatever let it stay.
        if reader.as_ref().is_some_and(|held| held.root != root) {
            *reader = None;
        }
        let held = match reader.as_mut() {
            Some(held) => held,
            None => reader.insert(Held {
                root: root.to_path_buf(),
                connection: open_for_queries(root)?,
            }),
        };
        run_query(&held.connection, sql, parameters)
    }
}

/// The read-only connection queries run on.
fn open_for_queries(root: &Path) -> Result<Connection, String> {
    let connection = Connection::open_with_flags(
        database_path(root)?,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("cannot open the index for reading: {error}"))?;
    // Returning true aborts, so this stops any query that exceeds the budget.
    // A failure to install it is not worth refusing to query over: the row cap
    // and the read-only connection are the guarantees that matter.
    if let Err(error) = connection.progress_handler(QUERY_STEP_BUDGET, Some(|| true)) {
        log::warn!("could not limit query time: {error}");
    }
    Ok(connection)
}

/// Runs index work off the main thread and off the async runtime's workers: a
/// sync command runs on the main thread, where it freezes the window, and a
/// blocking one on a runtime worker parks a thread the local API server and
/// every other async command share.
async fn off_main<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| format!("the index stopped: {error}"))?
}

/// The index, as the commands hold it: shared with the thread each runs its work on.
pub type SharedIndex = Arc<IndexState>;

/// A view never returns more than this, however the query is written.
const MAX_QUERY_ROWS: usize = 5_000;

/// Nor more text than this, all values together. A row cap alone lets 5,000
/// rows of wide values reach the webview, and a foreign database's query is
/// written in a note anyone could have written.
const MAX_QUERY_BYTES: usize = 16 * 1024 * 1024;

const QUERY_TOO_LARGE: &str = "the result is larger than DFAI will read";

/// How much work a query may do before it is stopped. SQLite counts virtual
/// machine steps, so this is a budget rather than a clock — but it is enough to
/// stop a runaway query from holding the interface.
pub(crate) const QUERY_STEP_BUDGET: i32 = 5_000_000;

/// A type's view, as TypeScript describes it: its name and the `SELECT` it
/// holds (`typeViewSelectSql`). The value rules are TypeScript's; the index
/// only makes the view (ADR-0005).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeSpec {
    pub name: String,
    pub select: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    /// True when the row cap stopped the result short.
    pub truncated: bool,
}

/// Names that may be written into a statement.
///
/// A column or table name cannot be bound as a parameter, so it has to go into
/// the text. Anything that is not a plain identifier is refused rather than
/// escaped. The TypeScript side checks the same thing; this is the backstop.
fn is_identifier(name: &str) -> bool {
    let mut characters = name.chars();
    match characters.next() {
        Some(first) if first.is_ascii_alphabetic() || first == '_' => {}
        _ => return false,
    }
    characters.all(|character| character.is_ascii_alphanumeric() || character == '_')
}

fn database_path(root: &Path) -> Result<PathBuf, String> {
    let directory = root.join(CACHE_DIR);
    fs::create_dir_all(&directory).map_err(|error| format!("cannot create cache: {error}"))?;
    Ok(directory.join(DATABASE))
}

fn create_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "
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
            ",
        )
        .map_err(|error| format!("cannot create index: {error}"))
}

/// What opening the index found, for TypeScript to act on.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexOpened {
    /// True when the index was made just now — there was none, or one of
    /// another shape was thrown away — so it holds nothing of the vault yet.
    pub fresh: bool,
}

/// Opens the vault's index, making it when there is none of this shape, and
/// says which: a fact about the cache, which TypeScript decides what to do with.
fn open_database(root: &Path) -> Result<(Connection, IndexOpened), String> {
    let path = database_path(root)?;
    // Read before the journal is set up: on a file that is not a database at
    // all, setting WAL is the first thing that fails, and the cache would never heal.
    let fresh = stored_version(&path)? != Some(SCHEMA_VERSION);
    if fresh {
        // The cache is derived, so an old shape — or a broken file — is discarded rather than migrated.
        discard(&path);
    }
    let connection =
        Connection::open(&path).map_err(|error| format!("cannot open index: {error}"))?;
    connection
        .execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")
        .map_err(|error| format!("cannot configure index: {error}"))?;
    create_schema(&connection)?;
    if fresh {
        connection
            .execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION};"))
            .map_err(|error| format!("cannot set index version: {error}"))?;
    }
    Ok((connection, IndexOpened { fresh }))
}

/// The schema version the index on disk says it has: none when there is no
/// file yet, or the file is not a database (cut short, overwritten), which is
/// a cache to rebuild rather than an error to stop on.
fn stored_version(path: &Path) -> Result<Option<i64>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let connection =
        Connection::open(path).map_err(|error| format!("cannot open index: {error}"))?;
    match connection.query_row("PRAGMA user_version", [], |row| row.get(0)) {
        Ok(version) => Ok(Some(version)),
        Err(rusqlite::Error::SqliteFailure(failure, _))
            if failure.code == rusqlite::ErrorCode::NotADatabase =>
        {
            Ok(None)
        }
        Err(error) => Err(format!("cannot read index version: {error}")),
    }
}

/// Removes the index and its journal files. A file already gone is what was wanted.
fn discard(path: &Path) {
    let _ = fs::remove_file(path);
    for suffix in ["-wal", "-shm"] {
        let mut sidecar = path.as_os_str().to_owned();
        sidecar.push(suffix);
        let _ = fs::remove_file(sidecar);
    }
}

fn open_root(vault: &State<'_, VaultState>) -> Result<PathBuf, String> {
    vault.root().ok_or_else(|| "no vault is open".to_string())
}

#[tauri::command]
pub async fn index_open(
    vault: State<'_, VaultState>,
    index: State<'_, SharedIndex>,
) -> Result<IndexOpened, String> {
    let root = open_root(&vault)?;
    let index = Arc::clone(&index);
    let opened = off_main(move || index.open(&root)).await?;
    log::info!("index opened (fresh: {})", opened.fresh);
    Ok(opened)
}

/// Throws the cache away and starts again. The point of having it.
#[tauri::command]
pub async fn index_clear(
    vault: State<'_, VaultState>,
    index: State<'_, SharedIndex>,
) -> Result<(), String> {
    let root = open_root(&vault)?;
    let index = Arc::clone(&index);
    off_main(move || index.clear(&root)).await?;
    log::info!("index cleared");
    Ok(())
}

/// What the index currently holds, so the caller can work out what changed.
fn manifest(connection: &Connection) -> Result<Vec<IndexEntry>, String> {
    {
        let mut statement = connection
            .prepare("SELECT path, modified, size, digest, note_type FROM files")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok(IndexEntry {
                    path: row.get(0)?,
                    modified: row.get::<_, i64>(1)? as u64,
                    size: row.get::<_, i64>(2)? as u64,
                    digest: row.get(3)?,
                    note_type: row.get(4)?,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }
}

#[tauri::command]
pub async fn index_manifest(index: State<'_, SharedIndex>) -> Result<Vec<IndexEntry>, String> {
    let index = Arc::clone(&index);
    off_main(move || index.with_connection(|connection| manifest(connection))).await
}

fn write_note(transaction: &rusqlite::Transaction<'_>, note: &IndexedNote) -> Result<(), String> {
    let stringly = |error: rusqlite::Error| error.to_string();

    transaction
        .execute("DELETE FROM props WHERE path = ?1", params![note.path])
        .map_err(stringly)?;
    transaction
        .execute("DELETE FROM links WHERE src = ?1", params![note.path])
        .map_err(stringly)?;
    transaction
        .execute("DELETE FROM tags WHERE path = ?1", params![note.path])
        .map_err(stringly)?;
    transaction
        .execute("DELETE FROM relations WHERE src = ?1", params![note.path])
        .map_err(stringly)?;
    transaction
        .execute("DELETE FROM blocks WHERE path = ?1", params![note.path])
        .map_err(stringly)?;
    transaction
        .execute("DELETE FROM checks WHERE path = ?1", params![note.path])
        .map_err(stringly)?;
    delete_highlights(transaction, &note.path)?;
    transaction
        .execute(
            "INSERT INTO files (path, title, summary, modified, size, digest, note_type, progress)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(path) DO UPDATE SET
                 title = ?2, summary = ?3, modified = ?4, size = ?5, digest = ?6,
                 note_type = ?7, progress = ?8",
            params![
                note.path,
                note.title,
                note.summary,
                note.modified as i64,
                note.size as i64,
                note.digest,
                note.note_type,
                note.progress
            ],
        )
        .map_err(stringly)?;

    // A note's search row has the rowid of its row in `files` (schema 14).
    // The search table cannot be asked for a path without reading every row
    // of it, which made building an index, and indexing a vault again, n * n
    // work (#135); by rowid it is one lookup. Whatever sits at that rowid is
    // replaced, a row left there by a note long gone included.
    let row = search_row(transaction, &note.path)?;
    transaction
        .execute("DELETE FROM fts WHERE rowid = ?1", params![row])
        .map_err(stringly)?;
    transaction
        .execute(
            "INSERT INTO fts (rowid, path, title, body) VALUES (?1, ?2, ?3, ?4)",
            params![row, searchable_file_stem(&note.path), note.title, note.body],
        )
        .map_err(stringly)?;

    for property in &note.properties {
        transaction
            .execute(
                "INSERT INTO props (path, key, idx, value_text, value_num, value_date, value_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    note.path,
                    property.key,
                    property.index,
                    property.text,
                    property.number,
                    property.date,
                    property.json
                ],
            )
            .map_err(stringly)?;
    }

    for link in &note.links {
        transaction
            .execute(
                "INSERT INTO links (src, dst, target, kind, leaf) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![note.path, link.path, link.target, link.kind, link.leaf],
            )
            .map_err(stringly)?;
    }

    for relation in &note.relations {
        transaction
            .execute(
                "INSERT INTO relations (src, key, idx, target, name, dst) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    note.path,
                    relation.key,
                    relation.index,
                    relation.target,
                    relation.name,
                    relation.path
                ],
            )
            .map_err(stringly)?;
    }

    for (position, tag) in note.tags.iter().enumerate() {
        transaction
            .execute(
                "INSERT INTO tags (path, idx, tag, name) VALUES (?1, ?2, ?3, ?4)",
                params![note.path, position as i64, tag.key, tag.name],
            )
            .map_err(stringly)?;
    }

    for (position, block) in note.blocks.iter().enumerate() {
        transaction
            .execute(
                "INSERT INTO blocks (path, idx, id, text) VALUES (?1, ?2, ?3, ?4)",
                params![note.path, position as i64, block.id, block.text],
            )
            .map_err(stringly)?;
    }

    for (position, check) in note.checks.iter().enumerate() {
        transaction
            .execute(
                "INSERT INTO checks (path, idx, done, text) VALUES (?1, ?2, ?3, ?4)",
                params![note.path, position as i64, check.done, check.text],
            )
            .map_err(stringly)?;
    }

    for (position, highlight) in note.highlights.iter().enumerate() {
        transaction
            .execute(
                "INSERT INTO highlights (path, idx, id, kind, quote, comment, mark, color, anchor)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    note.path,
                    position as i64,
                    highlight.id,
                    highlight.kind,
                    highlight.quote,
                    highlight.comment,
                    highlight.mark,
                    highlight.color,
                    highlight.anchor
                ],
            )
            .map_err(stringly)?;
        transaction
            .execute(
                "INSERT INTO highlights_fts (rowid, quote, comment) VALUES (?1, ?2, ?3)",
                params![
                    transaction.last_insert_rowid(),
                    highlight.quote,
                    highlight.comment
                ],
            )
            .map_err(stringly)?;
    }

    Ok(())
}

/// A note's highlights and their search rows: the search rows first, found
/// by the rowids of the highlights they stand for (one lookup each through
/// `highlights_path_idx`, not a scan of the search table).
fn delete_highlights(connection: &Connection, path: &str) -> Result<(), String> {
    connection
        .execute(
            "DELETE FROM highlights_fts WHERE rowid IN (SELECT rowid FROM highlights WHERE path = ?1)",
            params![path],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute("DELETE FROM highlights WHERE path = ?1", params![path])
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// The rowid of a note's row in `files`, which is its search row's too; none for a note not held.
/// The part of a path worth searching: the file name without its extension.
/// A meeting's day lives there (#211); the folders name a place, not the
/// note, and the extension is on every note.
fn searchable_file_stem(path: &str) -> &str {
    Path::new(path)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(path)
}

fn search_row(connection: &Connection, path: &str) -> Result<Option<i64>, String> {
    use rusqlite::OptionalExtension;
    connection
        .query_row(
            "SELECT rowid FROM files WHERE path = ?1",
            params![path],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())
}

/// Adds or replaces a batch of notes in one transaction.
fn put_notes(connection: &mut Connection, notes: &[IndexedNote]) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    for note in notes {
        write_note(&transaction, note)?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

/// `vault` is the vault the notes were read from, when the caller says:
/// refused once another's index is the one open.
#[tauri::command]
pub async fn index_put(
    index: State<'_, SharedIndex>,
    vault: Option<String>,
    notes: Vec<IndexedNote>,
) -> Result<(), String> {
    let index = Arc::clone(&index);
    off_main(move || {
        index.put(vault.as_deref(), &notes)?;
        log::debug!("indexed {} notes", notes.len());
        Ok(())
    })
    .await
}

fn remove_paths(connection: &mut Connection, paths: &[String]) -> Result<(), String> {
    {
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        for path in paths {
            // Before the note's own row goes: the search row is found through it.
            if let Some(row) = search_row(&transaction, path)? {
                transaction
                    .execute("DELETE FROM fts WHERE rowid = ?1", params![row])
                    .map_err(|error| error.to_string())?;
            }
            delete_highlights(&transaction, path)?;
            for statement in [
                "DELETE FROM files WHERE path = ?1",
                "DELETE FROM props WHERE path = ?1",
                "DELETE FROM links WHERE src = ?1",
                "DELETE FROM tags WHERE path = ?1",
                "DELETE FROM relations WHERE src = ?1",
                "DELETE FROM blocks WHERE path = ?1",
                "DELETE FROM checks WHERE path = ?1",
            ] {
                transaction
                    .execute(statement, params![path])
                    .map_err(|error| error.to_string())?;
            }
        }
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(())
    }
}

#[tauri::command]
pub async fn index_remove(
    index: State<'_, SharedIndex>,
    vault: Option<String>,
    paths: Vec<String>,
) -> Result<(), String> {
    let index = Arc::clone(&index);
    off_main(move || {
        index.write(vault.as_deref(), |connection| {
            remove_paths(connection, &paths)
        })
    })
    .await
}

/// How much a word found in each column of `fts` counts — path, title, body
/// — when hits are ranked (#211). Equal weights let a long meeting's
/// transcript, and every short note naming the same people, bury the note
/// whose title is what was searched for past the first page.
const SEARCH_WEIGHTS: &str = "bm25(fts, 5.0, 10.0, 1.0)";

/// Full-text search. `skip_prefix` is handed in by the frontend — the notes
/// under it are left out — and compared against the lower-cased path; which
/// prefix, and when, is decided there (ADR-0014). Rust only obeys it.
fn search(
    connection: &Connection,
    query: &str,
    limit: u32,
    skip_prefix: Option<&str>,
) -> Result<Vec<SearchHit>, String> {
    let mut statement = connection
        .prepare(&format!(
            // Through `files`, by the rowid the two share: a search row whose
            // note is not held is not an answer.
            "SELECT files.path, fts.title, snippet(fts, 2, '<<', '>>', '…', 12)
             FROM fts JOIN files ON files.rowid = fts.rowid
             WHERE fts MATCH ?1
               AND (?3 IS NULL OR lower(substr(files.path, 1, length(?3))) <> ?3)
             ORDER BY {SEARCH_WEIGHTS} LIMIT ?2"
        ))
        .map_err(|error| error.to_string())?;

    let rows = statement
        .query_map(params![query, limit, skip_prefix], |row| {
            Ok(SearchHit {
                path: row.get(0)?,
                title: row.get(1)?,
                snippet: row.get(2)?,
                block: None,
            })
        })
        // A malformed FTS expression is a user typing, not a failure.
        .map_err(|error| format!("bad search: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

/// The highlights whose quote or comment matches, each named by its note
/// and its block id (#507): the same expression, prefix and limit as the
/// notes' search, which TypeScript asks for when it wants them.
fn search_highlights(
    connection: &Connection,
    query: &str,
    limit: u32,
    skip_prefix: Option<&str>,
) -> Result<Vec<SearchHit>, String> {
    let mut statement = connection
        .prepare(
            "SELECT highlights.path, files.title, highlights.id,
                    snippet(highlights_fts, -1, '<<', '>>', '…', 12)
             FROM highlights_fts
             JOIN highlights ON highlights.rowid = highlights_fts.rowid
             JOIN files ON files.path = highlights.path
             WHERE highlights_fts MATCH ?1
               AND (?3 IS NULL OR lower(substr(files.path, 1, length(?3))) <> ?3)
             ORDER BY bm25(highlights_fts), highlights.path, highlights.idx LIMIT ?2",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![query, limit, skip_prefix], |row| {
            Ok(SearchHit {
                path: row.get(0)?,
                title: row.get(1)?,
                block: Some(row.get(2)?),
                snippet: row.get(3)?,
            })
        })
        .map_err(|error| format!("bad search: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

/// The notes that match, then — when `highlights` asks — the highlights.
#[tauri::command]
pub async fn index_search(
    index: State<'_, SharedIndex>,
    query: String,
    limit: u32,
    skip_prefix: Option<String>,
    highlights: Option<bool>,
) -> Result<Vec<SearchHit>, String> {
    let index = Arc::clone(&index);
    off_main(move || {
        index.with_connection(|connection| {
            let mut hits = search(connection, &query, limit, skip_prefix.as_deref())?;
            if highlights == Some(true) {
                hits.extend(search_highlights(
                    connection,
                    &query,
                    limit,
                    skip_prefix.as_deref(),
                )?);
            }
            Ok(hits)
        })
    })
    .await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypedNote {
    pub path: String,
    pub title: String,
}

/// Notes declaring `type: <name>` in their frontmatter, in any case and
/// spacing as TypeScript's `foldedTypeSql` matches a type — what a relation
/// property is allowed to point at. A note listing the type twice is one note.
fn notes_of_type(connection: &Connection, type_name: &str) -> Result<Vec<TypedNote>, String> {
    let mut statement = connection
        .prepare(
            "SELECT files.path, files.title FROM files
             WHERE files.path IN (SELECT path FROM props
                                  WHERE key = 'type' AND lower(trim(value_text)) = lower(trim(?1)))
             ORDER BY files.title",
        )
        .map_err(|error| error.to_string())?;

    let rows = statement
        .query_map(params![type_name], |row| {
            Ok(TypedNote {
                path: row.get(0)?,
                title: row.get(1)?,
            })
        })
        .map_err(|error| error.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn index_notes_of_type(
    index: State<'_, SharedIndex>,
    r#type: String,
) -> Result<Vec<TypedNote>, String> {
    let index = Arc::clone(&index);
    off_main(move || index.with_connection(|connection| notes_of_type(connection, &r#type))).await
}

fn backlinks(connection: &Connection, path: &str) -> Result<Vec<String>, String> {
    {
        let mut statement = connection
            .prepare("SELECT DISTINCT src FROM links WHERE dst = ?1 AND src <> ?1 ORDER BY src")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![path], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }
}

#[tauri::command]
pub async fn index_backlinks(
    index: State<'_, SharedIndex>,
    path: String,
) -> Result<Vec<String>, String> {
    let index = Arc::clone(&index);
    off_main(move || index.with_connection(|connection| backlinks(connection, &path))).await
}

/// Makes one SQL view per type, from the `SELECT` TypeScript sends for it.
///
/// Properties are stored as rows, which is what lets a note have any shape. A
/// view pivots them back into columns so a query can read like a table:
/// `SELECT name, arr FROM v_company WHERE arr > 1000000`. How each cell is
/// read is TypeScript's to say (`typeViewSelectSql`); the index runs it.
fn rebuild_views(connection: &Connection, types: &[TypeSpec]) -> Result<(), String> {
    // Dropped and made again in one transaction: a query on the reading
    // connection sees the views as they were or as they will be, never the
    // moment between, when a type has no view at all (#135).
    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    replace_views(&transaction, types)?;
    transaction.commit().map_err(|error| error.to_string())
}

fn replace_views(connection: &Connection, types: &[TypeSpec]) -> Result<(), String> {
    let existing: Vec<String> = {
        let mut statement = connection
            .prepare("SELECT name FROM sqlite_master WHERE type = 'view' AND name LIKE 'v\\_%' ESCAPE '\\'")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };

    for name in existing {
        connection
            .execute_batch(&format!("DROP VIEW IF EXISTS \"{name}\";"))
            .map_err(|error| error.to_string())?;
    }

    // SQLite names views in any case, so two types spelt alike (`Task`,
    // `task`) would ask for one view twice, and the second would undo every
    // view of the rebuild. Neither gets one; TypeScript refuses a query that
    // names them, and every other type keeps its view.
    let mut spellings: HashMap<String, usize> = HashMap::new();
    for spec in types {
        *spellings.entry(spec.name.to_ascii_lowercase()).or_default() += 1;
    }
    for spec in types {
        if spellings
            .get(&spec.name.to_ascii_lowercase())
            .is_some_and(|count| *count > 1)
        {
            continue;
        }
        // A name that is no identifier, or text that is no SELECT, is not
        // written into a statement: the backstop to TypeScript's own check.
        // `execute` runs one statement, so the text cannot carry a second.
        if !is_identifier(&spec.name) || !spec.select.starts_with("SELECT ") {
            continue;
        }
        connection
            .execute(
                &format!("CREATE VIEW \"v_{}\" AS\n{}", spec.name, spec.select),
                [],
            )
            .map_err(|error| format!("cannot build the view for {}: {error}", spec.name))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn index_rebuild_views(
    index: State<'_, SharedIndex>,
    types: Vec<TypeSpec>,
) -> Result<(), String> {
    let index = Arc::clone(&index);
    off_main(move || {
        index.with_connection(|connection| {
            rebuild_views(connection, &types)?;
            log::debug!("rebuilt {} views", types.len());
            Ok(())
        })
    })
    .await
}

/// Pragmas that take an argument and only report: what describing a table
/// needs. Any other pragma given a value sets something on the connection.
const DESCRIBING_PRAGMAS: &[&str] = &[
    "table_info",
    "table_xinfo",
    "index_list",
    "index_info",
    "index_xinfo",
    "foreign_key_list",
];

/// The pragma that names the file behind each database: the index's absolute
/// path, which says where things sit on this machine.
const LOCATING_PRAGMA: &str = "database_list";

/// What SQLite may do while preparing someone's query. Attaching and detaching
/// reach other database files; a transaction or savepoint left open would pin
/// every later query on the cached connection to one snapshot; a pragma setter
/// changes how the connection behaves for the next query; `database_list`,
/// as a statement or a table, answers with the index's path on disk.
fn reads_only(context: AuthContext<'_>) -> Authorization {
    match context.action {
        AuthAction::Attach { .. }
        | AuthAction::Detach { .. }
        | AuthAction::Transaction { .. }
        | AuthAction::Savepoint { .. } => Authorization::Deny,
        AuthAction::Pragma { pragma_name, .. }
            if pragma_name.eq_ignore_ascii_case(LOCATING_PRAGMA) =>
        {
            Authorization::Deny
        }
        AuthAction::Read { table_name, .. }
            if table_name.eq_ignore_ascii_case(&format!("pragma_{LOCATING_PRAGMA}")) =>
        {
            Authorization::Deny
        }
        AuthAction::Pragma {
            pragma_name,
            pragma_value: Some(_),
        } if !DESCRIBING_PRAGMAS.contains(&pragma_name.to_ascii_lowercase().as_str()) => {
            Authorization::Deny
        }
        _ => Authorization::Allow,
    }
}

/// Prepares one statement that only reads this database, or refuses it.
///
/// The authorizer is held only while preparing, so the indexer's own statements
/// on the same connection are not bound by it. `prepare` already refuses more
/// than one statement, and `readonly` catches every write — VACUUM INTO
/// included — that the authorizer lets through.
fn prepare_read<'c>(connection: &'c Connection, sql: &str) -> Result<Statement<'c>, String> {
    connection
        .authorizer(Some(reads_only))
        .map_err(|error| error.to_string())?;
    let prepared = connection.prepare(sql);
    connection
        .authorizer(None::<fn(AuthContext<'_>) -> Authorization>)
        .map_err(|error| error.to_string())?;

    let statement = prepared.map_err(|error| error.to_string())?;
    if !statement.readonly() {
        return Err("only a statement that reads the index can run here".to_string());
    }
    Ok(statement)
}

pub(crate) fn run_query(
    connection: &Connection,
    sql: &str,
    parameters: &[serde_json::Value],
) -> Result<QueryResult, String> {
    let mut statement = prepare_read(connection, sql)?;

    let columns: Vec<String> = statement
        .column_names()
        .into_iter()
        .map(str::to_string)
        .collect();

    let bound: Vec<Box<dyn rusqlite::ToSql>> = parameters
        .iter()
        .map(|value| -> Box<dyn rusqlite::ToSql> {
            match value {
                serde_json::Value::Number(number) => match number.as_f64() {
                    Some(float) => Box::new(float),
                    None => Box::new(number.to_string()),
                },
                serde_json::Value::Bool(flag) => Box::new(flag.to_string()),
                serde_json::Value::Null => Box::new(rusqlite::types::Null),
                other => Box::new(other.to_string().trim_matches('"').to_string()),
            }
        })
        .collect();

    let mut rows = statement
        .query(rusqlite::params_from_iter(
            bound.iter().map(|value| value.as_ref()),
        ))
        .map_err(|error| error.to_string())?;

    let mut out = Vec::new();
    let mut truncated = false;
    let mut bytes: usize = 0;
    while let Some(row) = rows.next().map_err(|error| error.to_string())? {
        if out.len() >= MAX_QUERY_ROWS {
            truncated = true;
            break;
        }
        let mut values = Vec::with_capacity(columns.len());
        for index in 0..columns.len() {
            let value = row.get_ref(index).map_err(|error| error.to_string())?;
            if let rusqlite::types::ValueRef::Text(text) = value {
                bytes = bytes.saturating_add(text.len());
                if bytes > MAX_QUERY_BYTES {
                    return Err(QUERY_TOO_LARGE.into());
                }
            }
            values.push(match value {
                rusqlite::types::ValueRef::Null => serde_json::Value::Null,
                rusqlite::types::ValueRef::Integer(number) => serde_json::json!(number),
                rusqlite::types::ValueRef::Real(number) => serde_json::json!(number),
                rusqlite::types::ValueRef::Text(text) => {
                    serde_json::json!(String::from_utf8_lossy(text))
                }
                rusqlite::types::ValueRef::Blob(_) => serde_json::Value::Null,
            });
        }
        out.push(values);
    }

    Ok(QueryResult {
        columns,
        rows: out,
        truncated,
    })
}

#[tauri::command]
pub async fn index_query(
    vault: State<'_, VaultState>,
    index: State<'_, SharedIndex>,
    sql: String,
    parameters: Vec<serde_json::Value>,
) -> Result<QueryResult, String> {
    let root = open_root(&vault)?;
    let index = Arc::clone(&index);
    off_main(move || index.query(&root, &sql, &parameters)).await
}

fn stats(connection: &Connection) -> Result<IndexStats, String> {
    let count = |table: &str| -> Result<i64, String> {
        connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .map_err(|error| error.to_string())
    };
    Ok(IndexStats {
        notes: count("files")?,
        properties: count("props")?,
        links: count("links")?,
    })
}

#[tauri::command]
pub async fn index_stats(index: State<'_, SharedIndex>) -> Result<IndexStats, String> {
    let index = Arc::clone(&index);
    off_main(move || index.with_connection(|connection| stats(connection))).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_index() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        create_schema(&connection).unwrap();
        connection
    }

    fn note(path: &str, title: &str, body: &str) -> IndexedNote {
        IndexedNote {
            path: path.to_string(),
            title: title.to_string(),
            modified: 100,
            size: body.len() as u64,
            digest: String::new(),
            note_type: None,
            body: body.to_string(),
            summary: body.to_string(),
            properties: Vec::new(),
            links: Vec::new(),
            tags: Vec::new(),
            relations: Vec::new(),
            blocks: Vec::new(),
            checks: Vec::new(),
            progress: None,
            highlights: Vec::new(),
        }
    }

    fn relation(key: &str, index: i64, target: &str, path: Option<&str>) -> IndexedRelation {
        IndexedRelation {
            key: key.to_string(),
            index,
            target: target.to_string(),
            name: String::new(),
            path: path.map(str::to_string),
        }
    }

    #[test]
    fn stores_the_name_typescript_folded_a_relation_to_as_given() {
        let mut index = empty_index();
        let mut first = note("a.md", "A", "alpha");
        let mut folded = relation("project", 0, "\u{c9}cole.md", None);
        folded.name = "\u{e9}cole".to_string();
        first.relations = vec![folded];
        put_notes(&mut index, &[first]).unwrap();
        let result = run_query(&index, "SELECT target, name FROM relations", &[]).unwrap();
        assert_eq!(
            serde_json::to_value(&result.rows).unwrap(),
            serde_json::json!([["\u{c9}cole.md", "\u{e9}cole"]])
        );
    }

    #[test]
    fn stores_the_leaf_typescript_folded_a_body_link_to_as_given() {
        let mut index = empty_index();
        let mut first = note("a.md", "A", "alpha");
        let mut folded = link("p/\u{c9}cole.md", None);
        folded.leaf = "\u{e9}cole".to_string();
        first.links = vec![folded];
        put_notes(&mut index, &[first]).unwrap();
        let result = run_query(&index, "SELECT target, leaf FROM links", &[]).unwrap();
        assert_eq!(
            serde_json::to_value(&result.rows).unwrap(),
            serde_json::json!([["p/\u{c9}cole.md", "\u{e9}cole"]])
        );
    }

    #[test]
    fn finds_the_links_to_a_name_by_the_leaf_index() {
        let index = empty_index();
        let plan: Vec<String> = index
            .prepare("EXPLAIN QUERY PLAN SELECT src FROM links WHERE leaf = ?1 AND (dst IS NULL OR dst <> ?2)")
            .unwrap()
            .query_map(params!["later", "Later.md"], |row| row.get::<_, String>(3))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(
            plan.iter().any(|step| step.contains("links_leaf")),
            "{plan:?}"
        );
    }

    #[test]
    fn refuses_a_body_link_sent_without_its_leaf() {
        let sent = serde_json::json!({ "target": "Later", "path": null, "kind": "wikilink" });
        assert!(serde_json::from_value::<IndexedLink>(sent).is_err());
    }

    type RelationRow = (String, String, i64, String, Option<String>);

    fn relation_rows(connection: &Connection) -> Vec<RelationRow> {
        let mut statement = connection
            .prepare("SELECT src, key, idx, target, dst FROM relations ORDER BY src, key, idx")
            .unwrap();
        statement
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            })
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    #[test]
    fn stores_each_relation_with_the_note_it_was_resolved_to() {
        let mut index = empty_index();
        let mut first = note("a.md", "A", "alpha");
        first.relations = vec![
            relation("owner", 0, "Julie", Some("people/Julie.md")),
            relation("owner", 1, "Nobody", None),
        ];
        put_notes(&mut index, &[first]).unwrap();
        assert_eq!(
            relation_rows(&index),
            vec![
                (
                    "a.md".into(),
                    "owner".into(),
                    0,
                    "Julie".into(),
                    Some("people/Julie.md".into())
                ),
                ("a.md".into(), "owner".into(), 1, "Nobody".into(), None),
            ]
        );
    }

    #[test]
    fn replacing_or_removing_a_note_replaces_or_removes_its_relations() {
        let mut index = empty_index();
        let mut first = note("a.md", "A", "alpha");
        first.relations = vec![relation("project", 0, "Old", Some("Old.md"))];
        let mut other = note("b.md", "B", "beta");
        other.relations = vec![relation("project", 0, "Kept", Some("Kept.md"))];
        put_notes(&mut index, &[first, other]).unwrap();

        let mut second = note("a.md", "A", "alpha");
        second.relations = vec![relation("project", 0, "New", Some("New.md"))];
        put_notes(&mut index, &[second]).unwrap();
        let targets: Vec<String> = relation_rows(&index).into_iter().map(|row| row.3).collect();
        assert_eq!(targets, vec!["New".to_string(), "Kept".to_string()]);

        remove_paths(&mut index, &["a.md".to_string()]).unwrap();
        let targets: Vec<String> = relation_rows(&index).into_iter().map(|row| row.3).collect();
        assert_eq!(targets, vec!["Kept".to_string()]);
    }

    #[test]
    fn a_note_sent_without_relations_has_none_and_they_read_through_the_read_only_path() {
        let json = serde_json::json!({
            "path": "a.md", "title": "A", "modified": 1, "size": 1, "body": "b"
        });
        let parsed: IndexedNote = serde_json::from_value(json).unwrap();
        assert!(parsed.relations.is_empty());

        let mut index = empty_index();
        let mut first = note("a.md", "A", "alpha");
        first.relations = vec![relation("owner", 0, "Julie", None)];
        put_notes(&mut index, &[first]).unwrap();
        let result = run_query(&index, "SELECT src, dst FROM relations", &[]).unwrap();
        assert_eq!(result.rows.len(), 1);
    }

    fn tag(key: &str, name: &str) -> IndexedTag {
        IndexedTag {
            key: key.to_string(),
            name: name.to_string(),
        }
    }

    fn tag_rows(connection: &Connection) -> Vec<(String, i64, String, String)> {
        let mut statement = connection
            .prepare("SELECT path, idx, tag, name FROM tags ORDER BY path, idx")
            .unwrap();
        statement
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    fn row(path: &str, idx: i64, key: &str, name: &str) -> (String, i64, String, String) {
        (path.into(), idx, key.into(), name.into())
    }

    #[test]
    fn stores_each_use_of_a_tag_in_order() {
        let mut index = empty_index();
        let mut first = note("a.md", "A", "alpha");
        first.tags = vec![tag("idea", "Idea"), tag("idea", "idea")];
        put_notes(&mut index, &[first]).unwrap();
        assert_eq!(
            tag_rows(&index),
            vec![
                row("a.md", 0, "idea", "Idea"),
                row("a.md", 1, "idea", "idea")
            ]
        );
    }

    #[test]
    fn replacing_or_removing_a_note_replaces_or_removes_its_tags() {
        let mut index = empty_index();
        let mut first = note("a.md", "A", "alpha");
        first.tags = vec![tag("old", "old")];
        let mut other = note("b.md", "B", "beta");
        other.tags = vec![tag("kept", "kept")];
        put_notes(&mut index, &[first, other]).unwrap();

        let mut second = note("a.md", "A", "alpha");
        second.tags = vec![tag("new", "new")];
        put_notes(&mut index, &[second]).unwrap();
        assert_eq!(
            tag_rows(&index),
            vec![row("a.md", 0, "new", "new"), row("b.md", 0, "kept", "kept")]
        );

        remove_paths(&mut index, &["a.md".to_string()]).unwrap();
        assert_eq!(tag_rows(&index), vec![row("b.md", 0, "kept", "kept")]);
    }

    fn block(id: &str, text: &str) -> IndexedBlock {
        IndexedBlock {
            id: id.to_string(),
            text: text.to_string(),
        }
    }

    fn block_rows(connection: &Connection) -> Vec<(String, i64, String, String)> {
        connection
            .prepare("SELECT path, idx, id, text FROM blocks ORDER BY path, idx")
            .unwrap()
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    #[test]
    fn stores_each_block_id_typescript_read_in_order() {
        let mut index = empty_index();
        let mut first = note("a.md", "A", "alpha");
        first.blocks = vec![block("f3k9x2", "The plan"), block("q1", "Said once")];
        put_notes(&mut index, &[first]).unwrap();
        assert_eq!(
            block_rows(&index),
            vec![
                row("a.md", 0, "f3k9x2", "The plan"),
                row("a.md", 1, "q1", "Said once")
            ]
        );
    }

    #[test]
    fn replacing_or_removing_a_note_replaces_or_removes_its_block_ids() {
        let mut index = empty_index();
        let mut first = note("a.md", "A", "alpha");
        first.blocks = vec![block("old", "Old")];
        let mut other = note("b.md", "B", "beta");
        other.blocks = vec![block("kept", "Kept")];
        put_notes(&mut index, &[first, other]).unwrap();
        let mut second = note("a.md", "A", "alpha");
        second.blocks = vec![block("new", "New")];
        put_notes(&mut index, &[second]).unwrap();
        assert_eq!(
            block_rows(&index),
            vec![row("a.md", 0, "new", "New"), row("b.md", 0, "kept", "Kept")]
        );
        remove_paths(&mut index, &["a.md".to_string()]).unwrap();
        assert_eq!(block_rows(&index), vec![row("b.md", 0, "kept", "Kept")]);
    }

    #[test]
    fn a_note_sent_without_block_ids_has_none_and_they_read_through_the_read_only_path() {
        let json = serde_json::json!({
            "path": "a.md", "title": "A", "modified": 1, "size": 1, "body": "b"
        });
        let parsed: IndexedNote = serde_json::from_value(json).unwrap();
        assert!(parsed.blocks.is_empty());
        let mut index = empty_index();
        let mut first = note("a.md", "A", "alpha");
        first.blocks = vec![block("f3k9x2", "The plan")];
        put_notes(&mut index, &[first]).unwrap();
        let result = run_query(&index, "SELECT path, id FROM blocks", &[]).unwrap();
        assert_eq!(result.rows.len(), 1);
    }

    fn highlight(id: &str, quote: &str) -> IndexedHighlight {
        IndexedHighlight {
            id: id.to_string(),
            kind: "pdf".to_string(),
            quote: quote.to_string(),
            comment: String::new(),
            mark: "highlight".to_string(),
            color: "yellow".to_string(),
            anchor: format!("{{\"v\":1,\"kind\":\"pdf\",\"page\":1,\"exact\":\"{quote}\"}}"),
        }
    }

    fn highlight_rows(connection: &Connection) -> Vec<(String, i64, String, String)> {
        connection
            .prepare("SELECT path, idx, id, quote FROM highlights ORDER BY path, idx")
            .unwrap()
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    #[test]
    fn stores_each_highlight_typescript_read_in_order_with_every_column() {
        let mut index = empty_index();
        let mut first = note("Library/War.md", "War", "alpha");
        let mut commented = highlight("k3x9q2", "All warfare");
        commented.comment = "Key **line**.".to_string();
        commented.kind = "epub".to_string();
        commented.mark = "underline".to_string();
        commented.color = "blue".to_string();
        first.highlights = vec![commented, highlight("b2", "Know the enemy")];
        put_notes(&mut index, &[first]).unwrap();
        assert_eq!(
            highlight_rows(&index),
            vec![
                row("Library/War.md", 0, "k3x9q2", "All warfare"),
                row("Library/War.md", 1, "b2", "Know the enemy")
            ]
        );
        let stored: (String, String, String, String, String) = index
            .query_row(
                "SELECT kind, comment, mark, color, anchor FROM highlights WHERE id = 'k3x9q2'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            stored,
            (
                "epub".into(),
                "Key **line**.".into(),
                "underline".into(),
                "blue".into(),
                "{\"v\":1,\"kind\":\"pdf\",\"page\":1,\"exact\":\"All warfare\"}".into()
            )
        );
    }

    #[test]
    fn replacing_or_removing_a_note_replaces_or_removes_its_highlights() {
        let mut index = empty_index();
        let mut first = note("a.md", "A", "alpha");
        first.highlights = vec![highlight("old", "Old")];
        let mut other = note("b.md", "B", "beta");
        other.highlights = vec![highlight("kept", "Kept")];
        put_notes(&mut index, &[first, other]).unwrap();
        let mut second = note("a.md", "A", "alpha");
        second.highlights = vec![highlight("new", "New")];
        put_notes(&mut index, &[second]).unwrap();
        assert_eq!(
            highlight_rows(&index),
            vec![row("a.md", 0, "new", "New"), row("b.md", 0, "kept", "Kept")]
        );
        remove_paths(&mut index, &["a.md".to_string()]).unwrap();
        assert_eq!(highlight_rows(&index), vec![row("b.md", 0, "kept", "Kept")]);
    }

    #[test]
    fn a_highlight_is_found_by_its_quote_or_its_comment_and_names_its_block() {
        let mut index = empty_index();
        let mut source = note("Library/Art.md", "The Art of War", "alpha");
        let mut commented = highlight("k3x9q2", "All warfare is based on deception");
        commented.comment = "Compare the Larkspur pitch".to_string();
        source.highlights = vec![commented, highlight("b2", "Know the enemy")];
        put_notes(&mut index, &[source]).unwrap();

        let by_comment = search_highlights(&index, "\"larkspur\"*", 10, None).unwrap();
        assert_eq!(by_comment.len(), 1);
        assert_eq!(by_comment[0].path, "Library/Art.md");
        assert_eq!(by_comment[0].title, "The Art of War");
        assert_eq!(by_comment[0].block.as_deref(), Some("k3x9q2"));
        assert!(by_comment[0].snippet.contains("<<Larkspur>>"));

        let by_quote = search_highlights(&index, "\"enemy\"", 10, None).unwrap();
        assert_eq!(
            by_quote
                .iter()
                .map(|hit| hit.block.clone())
                .collect::<Vec<_>>(),
            vec![Some("b2".to_string())]
        );
        // The marker's JSON is not searched: only the quote and the comment are.
        assert!(search_highlights(&index, "\"exact\"", 10, None)
            .unwrap()
            .is_empty());
        // A note's own hit names no block, and serialises without one.
        let note_hit = &search(&index, "alpha", 10, None).unwrap()[0];
        assert!(note_hit.block.is_none());
        assert!(serde_json::to_value(note_hit)
            .unwrap()
            .get("block")
            .is_none());
    }

    #[test]
    fn a_highlight_search_leaves_out_the_prefix_and_forgets_a_replaced_or_removed_highlight() {
        let mut index = empty_index();
        let mut kept = note("Library/Kept.md", "Kept", "x");
        kept.highlights = vec![highlight("k1", "shared words")];
        let mut archived = note("Archive/Old.md", "Old", "x");
        archived.highlights = vec![highlight("o1", "shared words")];
        put_notes(&mut index, &[kept, archived]).unwrap();
        let hits = search_highlights(&index, "\"shared\"", 10, Some("archive/")).unwrap();
        assert_eq!(
            hits.iter().map(|hit| hit.path.as_str()).collect::<Vec<_>>(),
            vec!["Library/Kept.md"]
        );
        assert_eq!(
            search_highlights(&index, "\"shared\"", 1, None)
                .unwrap()
                .len(),
            1
        );

        let mut rewritten = note("Library/Kept.md", "Kept", "x");
        rewritten.highlights = vec![highlight("k2", "fresh words")];
        put_notes(&mut index, &[rewritten]).unwrap();
        let left = search_highlights(&index, "\"shared\"", 10, None).unwrap();
        assert_eq!(
            left.iter().map(|hit| hit.path.as_str()).collect::<Vec<_>>(),
            vec!["Archive/Old.md"]
        );
        assert_eq!(
            search_highlights(&index, "\"fresh\"", 10, None)
                .unwrap()
                .len(),
            1
        );

        remove_paths(&mut index, &["Archive/Old.md".to_string()]).unwrap();
        assert!(search_highlights(&index, "\"shared\"", 10, None)
            .unwrap()
            .is_empty());
        let rows: i64 = index
            .query_row("SELECT count(*) FROM highlights_fts", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 1);
    }

    #[test]
    fn a_malformed_highlight_search_is_an_error_not_a_panic() {
        let mut index = empty_index();
        let mut source = note("Library/Art.md", "Art", "x");
        source.highlights = vec![highlight("k1", "unclosed words")];
        put_notes(&mut index, &[source]).unwrap();
        assert!(search_highlights(&index, "\"unclosed", 10, None).is_err());
    }

    #[test]
    fn the_bundled_sqlite_reads_an_anchor_as_json_for_the_research_views() {
        // All highlights (#507) reads a highlight's page and location with
        // json_valid and json_extract, through the read-only path.
        let mut index = empty_index();
        let mut first = note("Library/Art.md", "Art", "x");
        let mut broken = highlight("b1", "Broken");
        broken.anchor = "not json".to_string();
        first.highlights = vec![highlight("p1", "Paged"), broken];
        put_notes(&mut index, &[first]).unwrap();
        let result = run_query(
            &index,
            "SELECT id, CASE WHEN json_valid(anchor) THEN json_extract(anchor, '$.page') END AS page
             FROM highlights ORDER BY idx",
            &[],
        )
        .unwrap();
        assert_eq!(result.rows[0][1], serde_json::json!(1));
        assert_eq!(result.rows[1][1], serde_json::Value::Null);
    }

    #[test]
    fn a_note_sent_without_highlights_has_none_and_they_read_through_the_read_only_path() {
        let json = serde_json::json!({
            "path": "a.md", "title": "A", "modified": 1, "size": 1, "body": "b"
        });
        let parsed: IndexedNote = serde_json::from_value(json).unwrap();
        assert!(parsed.highlights.is_empty());
        let mut index = empty_index();
        let mut first = note("a.md", "A", "alpha");
        first.highlights = vec![highlight("k3x9q2", "All warfare")];
        put_notes(&mut index, &[first]).unwrap();
        let result = run_query(&index, "SELECT path, id, quote FROM highlights", &[]).unwrap();
        assert_eq!(result.rows.len(), 1);
    }

    fn check(done: bool, text: &str) -> IndexedCheck {
        IndexedCheck {
            done,
            text: text.to_string(),
        }
    }

    fn check_rows(connection: &Connection) -> Vec<(String, i64, bool, String)> {
        connection
            .prepare("SELECT path, idx, done, text FROM checks ORDER BY path, idx")
            .unwrap()
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    fn checked(path: &str, idx: i64, done: bool, text: &str) -> (String, i64, bool, String) {
        (path.to_string(), idx, done, text.to_string())
    }

    #[test]
    fn stores_each_checklist_box_typescript_read_in_order() {
        let mut index = empty_index();
        let mut first = note("a.md", "A", "alpha");
        first.checks = vec![check(true, "Book the hall"), check(false, "Order chairs")];
        put_notes(&mut index, &[first]).unwrap();
        assert_eq!(
            check_rows(&index),
            vec![
                checked("a.md", 0, true, "Book the hall"),
                checked("a.md", 1, false, "Order chairs")
            ]
        );
    }

    #[test]
    fn replacing_or_removing_a_note_replaces_or_removes_its_checklist() {
        let mut index = empty_index();
        let mut first = note("a.md", "A", "alpha");
        first.checks = vec![check(false, "Old")];
        let mut other = note("b.md", "B", "beta");
        other.checks = vec![check(true, "Kept")];
        put_notes(&mut index, &[first, other]).unwrap();
        let mut second = note("a.md", "A", "alpha");
        second.checks = vec![check(true, "New")];
        put_notes(&mut index, &[second]).unwrap();
        assert_eq!(
            check_rows(&index),
            vec![
                checked("a.md", 0, true, "New"),
                checked("b.md", 0, true, "Kept")
            ]
        );
        remove_paths(&mut index, &["a.md".to_string()]).unwrap();
        assert_eq!(check_rows(&index), vec![checked("b.md", 0, true, "Kept")]);
    }

    #[test]
    fn a_note_sent_without_a_checklist_has_none_and_it_reads_through_the_read_only_path() {
        let json = serde_json::json!({
            "path": "a.md", "title": "A", "modified": 1, "size": 1, "body": "b"
        });
        let parsed: IndexedNote = serde_json::from_value(json).unwrap();
        assert!(parsed.checks.is_empty());
        assert_eq!(parsed.progress, None);
        let mut index = empty_index();
        let mut first = note("a.md", "A", "alpha");
        first.checks = vec![check(true, "Book the hall")];
        put_notes(&mut index, &[first]).unwrap();
        let result = run_query(&index, "SELECT path, done, text FROM checks", &[]).unwrap();
        assert_eq!(result.rows.len(), 1);
    }

    fn task_with_progress(path: &str, progress: Option<i64>) -> IndexedNote {
        let mut task = note(path, path, "body");
        task.properties = vec![property("type", "task")];
        task.progress = progress;
        task
    }

    /// A column of a test view: what `typeViewSelectSql` is told of a property.
    struct TypeColumn {
        key: String,
        kind: String,
        many: bool,
    }

    /// A view as these tests need one: a plain pivot of each property, as
    /// views were before TypeScript sent their text. Production views come
    /// from `typeViewSelectSql`; here the index's part is under test — making,
    /// replacing and querying views — not how a cell is read.
    fn spec_of(name: &str, progress: bool, columns: Vec<TypeColumn>) -> TypeSpec {
        let cells: String = columns
            .iter()
            .map(|column| {
                let source = match column.kind.as_str() {
                    "number" => "props.value_num",
                    "date" => "props.value_date",
                    _ => "props.value_text",
                };
                let picked = format!("CASE WHEN props.key = '{}' THEN {source} END", column.key);
                let aggregate = if column.many {
                    format!("group_concat({picked}, ', ')")
                } else {
                    format!("MAX({picked})")
                };
                format!(", {aggregate} AS \"{}\"", column.key)
            })
            .collect();
        let progress = if progress {
            ", files.progress AS \"progress\""
        } else {
            ""
        };
        TypeSpec {
            name: name.into(),
            select: format!(
                "SELECT files.path AS \"path\", COALESCE(MAX(CASE WHEN props.key = 'title' THEN props.value_text END), files.title) AS \"title\", files.summary AS \"summary\", files.modified AS \"modified\"{progress}{cells} FROM files JOIN props ON props.path = files.path WHERE files.path IN (SELECT path FROM props WHERE key = 'type' AND value_text = '{name}') GROUP BY files.path"
            ),
        }
    }

    fn task_spec(progress: bool, columns: Vec<TypeColumn>) -> TypeSpec {
        spec_of("task", progress, columns)
    }

    fn note_with_rows(path: &str, rows: &[(&str, i64, &str, Option<&str>)]) -> IndexedNote {
        let mut found = note(path, path, "body");
        found.properties = rows
            .iter()
            .map(|(key, index, text, date)| IndexedProperty {
                key: (*key).into(),
                index: *index,
                text: Some((*text).into()),
                number: None,
                date: date.map(Into::into),
                json: None,
            })
            .collect();
        found
    }

    /// The relation picker offers a note of a type in any case, once.
    #[test]
    fn notes_of_a_type_are_found_in_any_case_and_once() {
        let mut index = empty_index();
        put_notes(
            &mut index,
            &[
                note_with_rows("a.md", &[("type", 0, "Task", None)]),
                note_with_rows(
                    "b.md",
                    &[("type", 0, "task", None), ("type", 1, " TASK ", None)],
                ),
                note_with_rows("c.md", &[("type", 0, "project", None)]),
            ],
        )
        .unwrap();
        let found: Vec<String> = notes_of_type(&index, "task")
            .unwrap()
            .into_iter()
            .map(|note| note.path)
            .collect();
        assert_eq!(found, vec!["a.md".to_string(), "b.md".to_string()]);
    }

    #[test]
    fn a_view_told_to_carries_the_progress_typescript_worked_out() {
        let mut index = empty_index();
        put_notes(
            &mut index,
            &[
                task_with_progress("a.md", Some(40)),
                task_with_progress("b.md", None),
            ],
        )
        .unwrap();
        rebuild_views(&index, &[task_spec(true, Vec::new())]).unwrap();
        let result = run_query(
            &index,
            "SELECT path, progress FROM v_task ORDER BY path",
            &[],
        )
        .unwrap();
        assert_eq!(result.rows[0][1], serde_json::json!(40));
        assert_eq!(result.rows[1][1], serde_json::Value::Null);

        // Replacing the note replaces its progress, as it does every other row.
        put_notes(&mut index, &[task_with_progress("a.md", Some(100))]).unwrap();
        let result = run_query(
            &index,
            "SELECT progress FROM v_task WHERE path = 'a.md'",
            &[],
        )
        .unwrap();
        assert_eq!(result.rows[0][0], serde_json::json!(100));
    }

    #[test]
    fn a_view_not_told_to_has_no_progress_and_a_declared_one_is_the_notes_own() {
        let mut index = empty_index();
        let mut own = task_with_progress("a.md", Some(40));
        own.properties.push(IndexedProperty {
            key: "progress".into(),
            index: 0,
            text: Some("7".into()),
            number: Some(7.0),
            date: None,
            json: None,
        });
        put_notes(&mut index, &[own]).unwrap();
        rebuild_views(&index, &[task_spec(false, Vec::new())]).unwrap();
        assert!(run_query(&index, "SELECT progress FROM v_task", &[]).is_err());

        let declared = TypeColumn {
            key: "progress".into(),
            kind: "number".into(),
            many: false,
        };
        rebuild_views(&index, &[task_spec(false, vec![declared])]).unwrap();
        let result = run_query(&index, "SELECT progress FROM v_task", &[]).unwrap();
        assert_eq!(result.columns, vec!["progress".to_string()]);
        assert_eq!(result.rows[0][0], serde_json::json!(7.0));
    }

    /// The `files` table each older index had: 10 before either column set,
    /// and the two shapes that both called themselves 11 (P28-03's digest and
    /// type; P30-03's checklist progress, with its `checks` table).
    const OLDER_SHAPES: [(&str, i64); 3] = [
        ("", 10),
        (", digest TEXT NOT NULL DEFAULT '', note_type TEXT", 11),
        (", progress INTEGER", 11),
    ];

    #[test]
    fn an_index_of_an_older_shape_is_thrown_away_and_rebuilt_with_both_column_sets() {
        for (columns, version) in OLDER_SHAPES {
            let vault = tempfile::tempdir().unwrap();
            let path = database_path(vault.path()).unwrap();
            {
                let old = Connection::open(&path).unwrap();
                old.execute_batch(&format!(
                    "CREATE TABLE files (path TEXT PRIMARY KEY, title TEXT NOT NULL,
                         summary TEXT NOT NULL DEFAULT '', modified INTEGER NOT NULL,
                         size INTEGER NOT NULL{columns});
                     PRAGMA user_version = {version};"
                ))
                .unwrap();
            }
            let (mut index, opened) = open_database(vault.path()).unwrap();
            assert!(
                opened.fresh,
                "a {version} index with ({columns}) is rebuilt"
            );
            let found: i64 = index
                .query_row("PRAGMA user_version", [], |row| row.get(0))
                .unwrap();
            assert_eq!(found, SCHEMA_VERSION);

            let mut first = task_with_progress("a.md", Some(40));
            first.checks = vec![check(true, "Book the hall")];
            first.digest = "d1".into();
            first.note_type = Some("task".into());
            put_notes(&mut index, &[first]).unwrap();
            assert_eq!(
                check_rows(&index),
                vec![checked("a.md", 0, true, "Book the hall")]
            );
            let stored: (Option<i64>, String, Option<String>) = index
                .query_row(
                    "SELECT progress, digest, note_type FROM files WHERE path = 'a.md'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .unwrap();
            assert_eq!(stored, (Some(40), "d1".into(), Some("task".into())));
        }
    }

    #[test]
    fn a_note_sent_without_tags_has_none() {
        let json = serde_json::json!({
            "path": "a.md", "title": "A", "modified": 1, "size": 1, "body": "b"
        });
        let note: IndexedNote = serde_json::from_value(json).unwrap();
        assert!(note.tags.is_empty());
    }

    #[test]
    fn tags_can_be_read_through_the_read_only_path() {
        let mut index = empty_index();
        let mut first = note("a.md", "A", "alpha");
        first.tags = vec![tag("idea", "Idea")];
        put_notes(&mut index, &[first]).unwrap();
        let result = run_query(&index, "SELECT tag, name FROM tags", &[]).unwrap();
        assert_eq!(result.rows.len(), 1);
    }

    fn property(key: &str, text: &str) -> IndexedProperty {
        IndexedProperty {
            key: key.to_string(),
            index: 0,
            text: Some(text.to_string()),
            number: None,
            date: None,
            json: None,
        }
    }

    #[test]
    fn a_note_typed_by_a_list_is_a_note_of_each_type_in_it() {
        // The reader and the Kindle sink find literature notes by this (#507, A4).
        let mut index = empty_index();
        let mut listed = note("Library/Typed twice.md", "Typed twice", "");
        let mut book = property("type", "book");
        book.index = 1;
        listed.properties = vec![property("type", "literature"), book];
        let mut plain = note("Library/Plain.md", "Plain", "");
        plain.properties = vec![property("type", "note")];
        put_notes(&mut index, &[listed, plain]).unwrap();
        let found: Vec<String> = notes_of_type(&index, "literature")
            .unwrap()
            .into_iter()
            .map(|typed| typed.path)
            .collect();
        assert_eq!(found, vec!["Library/Typed twice.md".to_string()]);
    }

    fn link(target: &str, path: Option<&str>) -> IndexedLink {
        IndexedLink {
            target: target.to_string(),
            leaf: String::new(),
            path: path.map(str::to_string),
            kind: "wikilink".to_string(),
        }
    }

    #[test]
    fn stores_and_lists_notes() {
        let mut index = empty_index();
        put_notes(
            &mut index,
            &[note("a.md", "A", "alpha"), note("b.md", "B", "beta")],
        )
        .unwrap();

        let mut paths: Vec<String> = manifest(&index)
            .unwrap()
            .into_iter()
            .map(|e| e.path)
            .collect();
        paths.sort();
        assert_eq!(paths, vec!["a.md", "b.md"]);
    }

    #[test]
    fn reports_size_and_modification_time_for_change_detection() {
        let mut index = empty_index();
        put_notes(&mut index, &[note("a.md", "A", "alpha")]).unwrap();

        let entry = manifest(&index).unwrap().pop().unwrap();
        assert_eq!(entry.modified, 100);
        assert_eq!(entry.size, 5);
    }

    #[test]
    fn keeps_the_digest_and_type_it_is_handed_for_telling_what_changed() {
        let mut index = empty_index();
        let mut meeting = note("Kickoff.md", "Kickoff", "agenda");
        meeting.digest = "1a2b3c4d".to_string();
        meeting.note_type = Some("meeting".to_string());
        put_notes(&mut index, &[meeting, note("Idea.md", "Idea", "spark")]).unwrap();

        let mut entries = manifest(&index).unwrap();
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        let versions: Vec<(&str, &str, Option<&str>)> = entries
            .iter()
            .map(|e| (e.path.as_str(), e.digest.as_str(), e.note_type.as_deref()))
            .collect();
        assert_eq!(
            versions,
            vec![
                ("Idea.md", "", None),
                ("Kickoff.md", "1a2b3c4d", Some("meeting"))
            ]
        );
    }

    #[test]
    fn replacing_a_note_replaces_its_digest_and_type() {
        let mut index = empty_index();
        let mut first = note("Kickoff.md", "Kickoff", "agenda");
        first.digest = "1a2b3c4d".to_string();
        first.note_type = Some("meeting".to_string());
        put_notes(&mut index, &[first]).unwrap();

        let mut second = note("Kickoff.md", "Kickoff", "agenda, minutes");
        second.digest = "5e6f7a8b".to_string();
        put_notes(&mut index, &[second]).unwrap();

        let entry = manifest(&index).unwrap().pop().unwrap();
        assert_eq!((entry.digest.as_str(), entry.note_type), ("5e6f7a8b", None));
    }

    #[test]
    fn a_reopened_index_still_knows_each_note_as_it_was_stored() {
        let vault = tempfile::tempdir().unwrap();
        let (mut first, _) = open_database(vault.path()).unwrap();
        let mut meeting = note("Kickoff.md", "Kickoff", "agenda");
        meeting.digest = "1a2b3c4d".to_string();
        meeting.note_type = Some("meeting".to_string());
        put_notes(&mut first, &[meeting]).unwrap();
        drop(first);

        let (reopened, _) = open_database(vault.path()).unwrap();
        let entry = manifest(&reopened).unwrap().pop().unwrap();
        assert_eq!(
            (
                entry.path.as_str(),
                entry.digest.as_str(),
                entry.note_type.as_deref()
            ),
            ("Kickoff.md", "1a2b3c4d", Some("meeting"))
        );
    }

    #[test]
    fn opening_says_the_index_is_fresh_only_when_it_was_made_just_now() {
        let vault = tempfile::tempdir().unwrap();
        let (first, opened) = open_database(vault.path()).unwrap();
        assert!(opened.fresh);
        drop(first);

        let (_, reopened) = open_database(vault.path()).unwrap();
        assert!(!reopened.fresh);
    }

    #[test]
    fn opening_an_index_of_another_shape_says_it_is_fresh() {
        let vault = tempfile::tempdir().unwrap();
        let (older, _) = open_database(vault.path()).unwrap();
        older
            .execute_batch(&format!("PRAGMA user_version = {};", SCHEMA_VERSION - 1))
            .unwrap();
        drop(older);

        let (_, opened) = open_database(vault.path()).unwrap();
        assert!(opened.fresh);
    }

    #[test]
    fn an_index_file_that_is_not_a_database_is_thrown_away_and_rebuilt() {
        let vault = tempfile::tempdir().unwrap();
        let path = database_path(vault.path()).unwrap();
        fs::write(
            &path,
            b"this was cut short and is no database at all, not even a header",
        )
        .unwrap();

        let (mut index, opened) = open_database(vault.path()).unwrap();

        assert!(opened.fresh);
        put_notes(&mut index, &[task_with_progress("a.md", Some(40))]).unwrap();
        let kept: i64 = index
            .query_row("SELECT count(*) FROM files", [], |row| row.get(0))
            .unwrap();
        assert_eq!(kept, 1);
        drop(index);
        let (_, reopened) = open_database(vault.path()).unwrap();
        assert!(!reopened.fresh);
    }

    #[test]
    fn opening_says_whether_it_is_fresh_under_the_name_typescript_reads() {
        assert_eq!(
            serde_json::to_value(IndexOpened { fresh: true }).unwrap(),
            serde_json::json!({ "fresh": true })
        );
    }

    #[test]
    fn the_manifest_sends_the_type_under_the_name_typescript_reads() {
        let entry = IndexEntry {
            path: "Kickoff.md".to_string(),
            modified: 1,
            size: 2,
            digest: "1a2b3c4d".to_string(),
            note_type: Some("meeting".to_string()),
        };
        assert_eq!(
            serde_json::to_value(entry).unwrap(),
            serde_json::json!({
                "path": "Kickoff.md",
                "modified": 1,
                "size": 2,
                "digest": "1a2b3c4d",
                "type": "meeting"
            })
        );
    }

    #[test]
    fn a_note_is_read_with_the_type_under_the_name_typescript_sends() {
        let sent: IndexedNote = serde_json::from_value(serde_json::json!({
            "path": "Kickoff.md",
            "title": "Kickoff",
            "modified": 1,
            "size": 2,
            "body": "agenda",
            "digest": "1a2b3c4d",
            "type": "meeting"
        }))
        .unwrap();
        assert_eq!(
            (sent.digest.as_str(), sent.note_type.as_deref()),
            ("1a2b3c4d", Some("meeting"))
        );
    }

    #[test]
    fn replacing_a_note_does_not_duplicate_it() {
        let mut index = empty_index();
        put_notes(&mut index, &[note("a.md", "A", "alpha")]).unwrap();
        put_notes(&mut index, &[note("a.md", "A renamed", "alpha again")]).unwrap();

        assert_eq!(manifest(&index).unwrap().len(), 1);
        assert_eq!(stats_of(&index).notes, 1);
        assert_eq!(search(&index, "alpha", 10, None).unwrap().len(), 1);
    }

    /// How many steps SQLite takes to add one note to an index holding this many.
    fn steps_to_add_a_note_to(held: usize) -> usize {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let mut index = empty_index();
        let notes: Vec<IndexedNote> = (0..held)
            .map(|n| note(&format!("Note {n}.md"), "Note", "alpha beta gamma"))
            .collect();
        put_notes(&mut index, &notes).unwrap();

        let steps = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&steps);
        index
            .progress_handler(
                1,
                Some(move || {
                    counted.fetch_add(1, Ordering::Relaxed);
                    false
                }),
            )
            .unwrap();
        put_notes(&mut index, &[note("New.md", "New", "delta")]).unwrap();
        steps.load(Ordering::Relaxed)
    }

    /// #135: the search table has no index on `path`, so clearing a note's old
    /// row from it reads every row. Done for a note the index has never held,
    /// that made building an index of n notes n * n work: five thousand notes
    /// took most of a minute, each batch slower than the last.
    #[test]
    fn adding_a_note_costs_the_same_however_many_the_index_holds() {
        let few = steps_to_add_a_note_to(20);
        let many = steps_to_add_a_note_to(2_000);
        assert!(
            many < few * 2,
            "adding a note to 2,000 took {many} steps, to 20 took {few}"
        );
    }

    #[test]
    fn a_note_put_twice_in_one_batch_is_held_once() {
        let mut index = empty_index();
        put_notes(
            &mut index,
            &[note("a.md", "A", "alpha"), note("a.md", "A", "alpha twice")],
        )
        .unwrap();

        assert_eq!(stats_of(&index).notes, 1);
        assert_eq!(search(&index, "alpha", 10, None).unwrap().len(), 1);
        assert_eq!(search(&index, "twice", 10, None).unwrap().len(), 1);
    }

    #[test]
    fn a_note_removed_and_put_again_is_found_once() {
        let mut index = empty_index();
        put_notes(&mut index, &[note("a.md", "A", "alpha")]).unwrap();
        remove_paths(&mut index, &["a.md".to_string()]).unwrap();
        put_notes(&mut index, &[note("a.md", "A", "alpha")]).unwrap();

        assert_eq!(search(&index, "alpha", 10, None).unwrap().len(), 1);
    }

    fn stats_of(connection: &Connection) -> IndexStats {
        let count = |table: &str| -> i64 {
            connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap()
        };
        IndexStats {
            notes: count("files"),
            properties: count("props"),
            links: count("links"),
        }
    }

    #[test]
    fn replacing_a_note_replaces_its_properties_and_links() {
        let mut index = empty_index();
        let mut first = note("a.md", "A", "alpha");
        first.properties = vec![property("status", "draft")];
        first.links = vec![link("B", Some("b.md"))];
        put_notes(&mut index, &[first]).unwrap();

        let mut second = note("a.md", "A", "alpha");
        second.properties = vec![property("status", "done")];
        put_notes(&mut index, &[second]).unwrap();

        let stats = stats_of(&index);
        assert_eq!(stats.properties, 1);
        assert_eq!(stats.links, 0);
    }

    #[test]
    fn removing_a_note_removes_everything_about_it() {
        let mut index = empty_index();
        let mut first = note("a.md", "A", "alpha");
        first.properties = vec![property("status", "draft")];
        first.links = vec![link("B", Some("b.md"))];
        put_notes(&mut index, &[first]).unwrap();

        remove_paths(&mut index, &["a.md".to_string()]).unwrap();

        let stats = stats_of(&index);
        assert_eq!((stats.notes, stats.properties, stats.links), (0, 0, 0));
        assert!(search(&index, "alpha", 10, None).unwrap().is_empty());
    }

    #[test]
    fn finds_a_note_by_a_word_in_its_body() {
        let mut index = empty_index();
        put_notes(&mut index, &[note("a.md", "A", "the quick brown fox")]).unwrap();

        let hits = search(&index, "brown", 10, None).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "a.md");
        assert!(hits[0].snippet.contains("<<brown>>"));
    }

    #[test]
    fn finds_a_note_by_its_title() {
        let mut index = empty_index();
        put_notes(
            &mut index,
            &[note("a.md", "Weekly review", "unrelated body")],
        )
        .unwrap();
        assert_eq!(search(&index, "weekly", 10, None).unwrap().len(), 1);
    }

    #[test]
    fn search_ignores_case_and_accents() {
        let mut index = empty_index();
        put_notes(&mut index, &[note("a.md", "A", "Café RÉSUMÉ")]).unwrap();
        assert_eq!(search(&index, "cafe", 10, None).unwrap().len(), 1);
        assert_eq!(search(&index, "resume", 10, None).unwrap().len(), 1);
    }

    #[test]
    fn search_leaves_out_the_prefix_it_is_handed() {
        let mut index = empty_index();
        put_notes(
            &mut index,
            &[
                note("Live.md", "Live", "shared word"),
                note("Archive/Old.md", "Old", "shared word"),
                note("archive/hand.md", "Hand", "shared word"),
                note("Notes/Archive/kept.md", "Kept", "shared word"),
            ],
        )
        .unwrap();
        let mut paths: Vec<String> = search(&index, "shared", 10, Some("archive/"))
            .unwrap()
            .into_iter()
            .map(|hit| hit.path)
            .collect();
        paths.sort();
        assert_eq!(paths, vec!["Live.md", "Notes/Archive/kept.md"]);
        assert_eq!(search(&index, "shared", 10, None).unwrap().len(), 4);
    }

    #[test]
    fn search_respects_the_limit() {
        let mut index = empty_index();
        let notes: Vec<IndexedNote> = (0..10)
            .map(|i| note(&format!("{i}.md"), "T", "shared word"))
            .collect();
        put_notes(&mut index, &notes).unwrap();
        assert_eq!(search(&index, "shared", 3, None).unwrap().len(), 3);
    }

    /// A meeting's long transcript and the short notes that merely mention
    /// the same people must not push the note whose title is the search out
    /// of the first page (#211).
    #[test]
    fn a_note_titled_with_every_word_comes_before_notes_that_only_mention_them() {
        let mut index = empty_index();
        let transcript = "Mara said the roadmap slipped. Tobias asked about hiring. ".repeat(400);
        let mut notes = vec![note(
            "Inbox/Meetings/2026-10-14 Mara Tobias 1-1.md",
            "Mara / Tobias 1-1",
            &transcript,
        )];
        notes.extend((0..30).map(|i| {
            note(
                &format!("Daily/2026-05-{i:02}.md"),
                &format!("2026-05-{i:02}"),
                "Mara and Tobias, 1-1 moved.",
            )
        }));
        put_notes(&mut index, &notes).unwrap();

        let hits = search(&index, "\"Mara\" \"Tobias\" \"1-1\"*", 5, None).unwrap();
        assert_eq!(hits[0].path, "Inbox/Meetings/2026-10-14 Mara Tobias 1-1.md");
    }

    /// A meeting's day is in its file name, not its title or body (#211).
    #[test]
    fn finds_a_note_by_the_day_in_its_file_name() {
        let mut index = empty_index();
        put_notes(
            &mut index,
            &[
                note(
                    "Inbox/Meetings/2026-10-14 Standup.md",
                    "Standup",
                    "who is out",
                ),
                note(
                    "Inbox/Meetings/2026-10-13 Standup.md",
                    "Standup",
                    "who is out",
                ),
            ],
        )
        .unwrap();
        let hits = search(&index, "\"2026-10-14\"*", 10, None).unwrap();
        let paths: Vec<&str> = hits.iter().map(|hit| hit.path.as_str()).collect();
        assert_eq!(paths, vec!["Inbox/Meetings/2026-10-14 Standup.md"]);
    }

    #[test]
    fn search_finds_nothing_for_a_word_that_is_not_there() {
        let mut index = empty_index();
        put_notes(&mut index, &[note("a.md", "A", "alpha")]).unwrap();
        assert!(search(&index, "omega", 10, None).unwrap().is_empty());
    }

    #[test]
    fn a_malformed_query_is_an_error_rather_than_a_panic() {
        let mut index = empty_index();
        put_notes(&mut index, &[note("a.md", "A", "alpha")]).unwrap();
        assert!(search(&index, "\"unclosed", 10, None).is_err());
    }

    #[test]
    fn backlinks_come_from_resolved_links_only() {
        let mut index = empty_index();
        let mut source = note("a.md", "A", "body");
        source.links = vec![link("Target", Some("target.md")), link("Ghost", None)];
        put_notes(&mut index, &[source, note("target.md", "Target", "body")]).unwrap();

        assert_eq!(backlinks(&index, "target.md").unwrap(), vec!["a.md"]);
        assert!(backlinks(&index, "ghost.md").unwrap().is_empty());
    }

    #[test]
    fn a_note_linking_to_itself_is_not_its_own_backlink() {
        let mut index = empty_index();
        let mut self_linking = note("a.md", "A", "body");
        self_linking.links = vec![link("A", Some("a.md"))];
        put_notes(&mut index, &[self_linking]).unwrap();

        assert!(backlinks(&index, "a.md").unwrap().is_empty());
    }

    #[test]
    fn several_links_to_the_same_note_count_once() {
        let mut index = empty_index();
        let mut source = note("a.md", "A", "body");
        source.links = vec![link("T", Some("t.md")), link("t", Some("t.md"))];
        put_notes(&mut index, &[source]).unwrap();

        assert_eq!(backlinks(&index, "t.md").unwrap(), vec!["a.md"]);
    }

    #[test]
    fn properties_are_stored_with_their_typed_values() {
        let mut index = empty_index();
        let mut typed = note("a.md", "A", "body");
        typed.properties = vec![
            IndexedProperty {
                key: "arr".into(),
                index: 0,
                text: None,
                number: Some(1_500_000.0),
                date: None,
                json: None,
            },
            IndexedProperty {
                key: "tags".into(),
                index: 1,
                text: Some("project".into()),
                number: None,
                date: None,
                json: None,
            },
        ];
        put_notes(&mut index, &[typed]).unwrap();

        let value: f64 = index
            .query_row("SELECT value_num FROM props WHERE key = 'arr'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(value, 1_500_000.0);

        let idx: i64 = index
            .query_row("SELECT idx FROM props WHERE key = 'tags'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(idx, 1);
    }

    fn company_type() -> TypeSpec {
        spec_of(
            "company",
            false,
            vec![
                TypeColumn {
                    key: "stage".into(),
                    kind: "text".into(),
                    many: false,
                },
                TypeColumn {
                    key: "arr".into(),
                    kind: "number".into(),
                    many: false,
                },
                TypeColumn {
                    key: "founded".into(),
                    kind: "date".into(),
                    many: false,
                },
                TypeColumn {
                    key: "tags".into(),
                    kind: "multiSelect".into(),
                    many: true,
                },
            ],
        )
    }

    fn typed_note(path: &str, title: &str, values: &[(&str, &str)]) -> IndexedNote {
        let mut note = note(path, title, "body");
        note.properties = vec![property("type", "company")];
        for (key, value) in values {
            note.properties.push(IndexedProperty {
                key: (*key).to_string(),
                index: 0,
                text: Some((*value).to_string()),
                number: value.parse::<f64>().ok(),
                date: if key.contains("founded") {
                    Some((*value).to_string())
                } else {
                    None
                },
                json: None,
            });
        }
        note
    }

    #[test]
    fn a_view_gives_a_column_per_property() {
        let mut index = empty_index();
        put_notes(
            &mut index,
            &[typed_note("a.md", "Acme", &[("stage", "seed")])],
        )
        .unwrap();
        rebuild_views(&index, &[company_type()]).unwrap();

        let result = run_query(&index, "SELECT title, stage FROM v_company", &[]).unwrap();
        assert_eq!(result.columns, vec!["title", "stage"]);
        assert_eq!(result.rows.len(), 1);
        assert_eq!(result.rows[0][0], serde_json::json!("Acme"));
        assert_eq!(result.rows[0][1], serde_json::json!("seed"));
    }

    #[test]
    fn a_view_holds_only_notes_of_its_type() {
        let mut index = empty_index();
        let mut other = note("b.md", "A person", "body");
        other.properties = vec![property("type", "person")];
        put_notes(&mut index, &[typed_note("a.md", "Acme", &[]), other]).unwrap();
        rebuild_views(&index, &[company_type()]).unwrap();

        let result = run_query(&index, "SELECT title FROM v_company", &[]).unwrap();
        assert_eq!(result.rows.len(), 1);
        assert_eq!(result.rows[0][0], serde_json::json!("Acme"));
    }

    #[test]
    fn a_number_column_compares_as_a_number() {
        let mut index = empty_index();
        put_notes(
            &mut index,
            &[
                typed_note("a.md", "Small", &[("arr", "90")]),
                typed_note("b.md", "Big", &[("arr", "1000")]),
            ],
        )
        .unwrap();
        rebuild_views(&index, &[company_type()]).unwrap();

        let result = run_query(
            &index,
            "SELECT title FROM v_company WHERE arr > ?",
            &[serde_json::json!(100)],
        )
        .unwrap();
        assert_eq!(result.rows.len(), 1);
        assert_eq!(result.rows[0][0], serde_json::json!("Big"));
    }

    #[test]
    fn a_list_property_becomes_one_cell() {
        let mut index = empty_index();
        let mut note = typed_note("a.md", "Acme", &[]);
        note.properties.push(IndexedProperty {
            key: "tags".into(),
            index: 0,
            text: Some("one".into()),
            number: None,
            date: None,
            json: None,
        });
        note.properties.push(IndexedProperty {
            key: "tags".into(),
            index: 1,
            text: Some("two".into()),
            number: None,
            date: None,
            json: None,
        });
        put_notes(&mut index, &[note]).unwrap();
        rebuild_views(&index, &[company_type()]).unwrap();

        let result = run_query(&index, "SELECT tags FROM v_company", &[]).unwrap();
        assert_eq!(result.rows[0][0], serde_json::json!("one, two"));
    }

    #[test]
    fn rebuilding_replaces_the_previous_views() {
        let mut index = empty_index();
        put_notes(
            &mut index,
            &[typed_note("a.md", "Acme", &[("stage", "seed")])],
        )
        .unwrap();
        rebuild_views(&index, &[company_type()]).unwrap();

        // The type loses a property; the view must lose the column with it.
        let trimmed = spec_of(
            "company",
            false,
            vec![TypeColumn {
                key: "stage".into(),
                kind: "text".into(),
                many: false,
            }],
        );
        rebuild_views(&index, &[trimmed]).unwrap();

        assert!(run_query(&index, "SELECT arr FROM v_company", &[]).is_err());
        assert!(run_query(&index, "SELECT stage FROM v_company", &[]).is_ok());
    }

    /// The index runs only the one SELECT TypeScript sent: text that is no
    /// SELECT, or that carries a second statement, makes no view and changes
    /// nothing.
    #[test]
    fn a_view_is_only_ever_one_select() {
        let index = empty_index();
        let not_a_select = TypeSpec {
            name: "task".into(),
            select: "DELETE FROM files".into(),
        };
        rebuild_views(&index, &[not_a_select]).unwrap();
        let two = TypeSpec {
            name: "task".into(),
            select: "SELECT 1; DROP TABLE files".into(),
        };
        assert!(rebuild_views(&index, &[two]).is_err());
        assert!(run_query(&index, "SELECT COUNT(*) FROM files", &[]).is_ok());
        let views: i64 = index
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='view'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(views, 0);
    }

    #[test]
    fn a_view_for_a_type_with_an_unusable_name_is_not_built() {
        let index = empty_index();
        let bad = spec_of("drop table", false, Vec::new());
        rebuild_views(&index, &[bad]).unwrap();

        let views: i64 = index
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='view'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(views, 0);
    }

    #[test]
    fn a_query_binds_its_parameters_rather_than_trusting_them() {
        let mut index = empty_index();
        put_notes(
            &mut index,
            &[typed_note("a.md", "Acme", &[("stage", "seed")])],
        )
        .unwrap();
        rebuild_views(&index, &[company_type()]).unwrap();

        let attack = serde_json::json!("seed'; DROP TABLE files;--");
        let result = run_query(
            &index,
            "SELECT title FROM v_company WHERE stage IS ?",
            &[attack],
        )
        .unwrap();
        assert!(result.rows.is_empty());

        // The table is still there.
        assert!(run_query(&index, "SELECT COUNT(*) FROM files", &[]).is_ok());
    }

    /// An index on disk opened read-write: the worst case, where only
    /// `run_query`'s own checks stand between the SQL and the files.
    fn index_on_disk() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let connection = Connection::open(dir.path().join("index.db")).unwrap();
        create_schema(&connection).unwrap();
        (dir, connection)
    }

    fn attached_databases(connection: &Connection) -> Vec<String> {
        let mut statement = connection
            .prepare("SELECT name FROM pragma_database_list")
            .unwrap();
        let names = statement.query_map([], |row| row.get(0)).unwrap();
        names.collect::<Result<_, _>>().unwrap()
    }

    fn file_count(connection: &Connection) -> i64 {
        connection
            .query_row("SELECT COUNT(*) FROM files", [], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn a_query_cannot_attach_another_database_or_create_its_file() {
        let (dir, index) = index_on_disk();
        let other = dir.path().join("other.db");

        let sql = format!("ATTACH DATABASE '{}' AS other", other.display());
        assert!(run_query(&index, &sql, &[]).is_err());

        assert!(!other.exists());
        assert_eq!(attached_databases(&index), vec!["main"]);
    }

    #[test]
    fn a_query_cannot_vacuum_the_index_into_a_new_file() {
        let (dir, index) = index_on_disk();
        let copy = dir.path().join("copy.plist");

        let sql = format!("VACUUM INTO '{}'", copy.display());
        assert!(run_query(&index, &sql, &[]).is_err());

        assert!(!copy.exists());
    }

    #[test]
    fn a_query_cannot_detach_a_database() {
        let (dir, index) = index_on_disk();
        let other = dir.path().join("other.db");
        index
            .execute("ATTACH DATABASE ?1 AS other", [other.display().to_string()])
            .unwrap();

        assert!(run_query(&index, "DETACH DATABASE other", &[]).is_err());

        assert_eq!(attached_databases(&index), vec!["main", "other"]);
    }

    #[test]
    fn a_query_cannot_write_even_on_a_writable_connection() {
        let (_dir, index) = index_on_disk();

        let insert = "INSERT INTO files (path, title, modified, size) VALUES ('x.md', 'x', 1, 1)";
        assert!(run_query(&index, insert, &[]).is_err());
        assert!(run_query(&index, "SELECT 1; DELETE FROM files", &[]).is_err());

        assert_eq!(file_count(&index), 0);
    }

    #[test]
    fn a_query_cannot_change_how_the_connection_behaves() {
        let (_dir, index) = index_on_disk();

        assert!(run_query(&index, "PRAGMA writable_schema = 1", &[]).is_err());
        assert!(run_query(&index, "PRAGMA query_only = 0", &[]).is_err());
        // An open transaction would pin every later query to this snapshot.
        assert!(run_query(&index, "BEGIN", &[]).is_err());
        assert!(run_query(&index, "SAVEPOINT held", &[]).is_err());

        let writable: i64 = index
            .query_row("PRAGMA writable_schema", [], |row| row.get(0))
            .unwrap();
        assert_eq!(writable, 0);
        assert!(index.is_autocommit());
    }

    #[test]
    fn a_query_cannot_learn_where_the_index_file_is() {
        let (_dir, index) = index_on_disk();

        for sql in [
            "PRAGMA database_list",
            "pragma DATABASE_LIST",
            "SELECT file FROM pragma_database_list",
            "SELECT * FROM pragma_database_list()",
            "SELECT file FROM main.pragma_database_list",
        ] {
            assert!(run_query(&index, sql, &[]).is_err(), "{sql} was allowed");
        }
    }

    #[test]
    fn a_query_can_still_read_and_describe_the_index() {
        let (_dir, index) = index_on_disk();

        let described = run_query(&index, "PRAGMA table_info(files)", &[]).unwrap();
        assert!(described.rows.iter().any(|row| row[1] == "path"));
        let with = run_query(&index, "WITH n AS (SELECT 1 AS one) SELECT one FROM n", &[]);
        assert_eq!(with.unwrap().rows, vec![vec![serde_json::json!(1)]]);
        assert!(run_query(&index, "PRAGMA user_version", &[]).is_ok());

        // The indexer's own statements on the connection are not held to the rule.
        index
            .execute(
                "INSERT INTO files (path, title, modified, size) VALUES ('x.md', 'x', 1, 1)",
                [],
            )
            .unwrap();
        assert_eq!(file_count(&index), 1);
    }

    /// The query page's schema list (`SCHEMA_SQL` in the domain) reads
    /// `sqlite_master` and `pragma_table_info` through the same guard as any
    /// other query: allowed, and it names each type's view and its columns.
    #[test]
    fn the_schema_can_be_listed_through_the_read_only_path() {
        let index = empty_index();
        rebuild_views(&index, &[company_type()]).unwrap();
        let schema = "SELECT m.name AS \"table\", m.type AS \"kind\", p.name AS \"column\"
FROM sqlite_master AS m, pragma_table_info(m.name) AS p
WHERE m.type IN ('table', 'view')
AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
AND m.name NOT LIKE 'fts\\_%' ESCAPE '\\'
ORDER BY m.type DESC, m.name, p.cid";
        let result = run_query(&index, schema, &[]).unwrap();
        assert_eq!(result.columns, vec!["table", "kind", "column"]);
        assert!(result
            .rows
            .iter()
            .any(|row| row[0] == "v_company" && row[1] == "view" && row[2] == "stage"));
        assert!(result.rows.iter().all(|row| row[0] != "fts_data"));
    }

    /// A statement typed on the query page that writes is refused, whatever it is.
    #[test]
    fn a_hand_written_write_is_refused() {
        let index = empty_index();
        for sql in [
            "DELETE FROM files",
            "UPDATE files SET title = 'x'",
            "DROP TABLE files",
            "CREATE TABLE x (y)",
        ] {
            assert!(run_query(&index, sql, &[]).is_err(), "{sql} was allowed");
        }
    }

    #[test]
    fn a_query_reports_its_column_names() {
        let index = empty_index();
        rebuild_views(&index, &[company_type()]).unwrap();
        let result = run_query(&index, "SELECT path, title, stage FROM v_company", &[]).unwrap();
        assert_eq!(result.columns, vec!["path", "title", "stage"]);
    }

    /// The SQL below is what `compileViewQuery` produces for a dashboard widget.
    /// The TypeScript tests check that it is generated; these check that SQLite
    /// accepts it and answers correctly, which is the half that only the real
    /// database can tell us.
    #[test]
    fn an_aggregate_over_a_view_returns_one_number() {
        let mut index = empty_index();
        put_notes(
            &mut index,
            &[
                typed_note("a.md", "Acme", &[("stage", "seed"), ("arr", "100")]),
                typed_note("b.md", "Beta", &[("stage", "seed"), ("arr", "300")]),
                typed_note("c.md", "Cyan", &[("stage", "series-a"), ("arr", "900")]),
            ],
        )
        .unwrap();
        rebuild_views(&index, &[company_type()]).unwrap();

        let result = run_query(
            &index,
            "SELECT SUM(\"arr\") AS \"value\"\nFROM \"v_company\"\nWHERE \"stage\" IS ?\nLIMIT ?",
            &[serde_json::json!("seed"), serde_json::json!(50)],
        )
        .unwrap();

        assert_eq!(result.columns, vec!["value"]);
        assert_eq!(result.rows.len(), 1);
        assert_eq!(result.rows[0][0], serde_json::json!(400.0));
    }

    #[test]
    fn an_aggregate_over_nothing_returns_null_rather_than_no_rows() {
        let index = empty_index();
        rebuild_views(&index, &[company_type()]).unwrap();

        let result = run_query(
            &index,
            "SELECT MAX(\"founded\") AS \"value\"\nFROM \"v_company\"\nLIMIT ?",
            &[serde_json::json!(50)],
        )
        .unwrap();

        assert_eq!(result.rows.len(), 1);
        assert_eq!(result.rows[0][0], serde_json::Value::Null);
    }

    #[test]
    fn counting_a_view_returns_a_row_per_value_biggest_first() {
        let mut index = empty_index();
        put_notes(
            &mut index,
            &[
                typed_note("a.md", "Acme", &[("stage", "seed")]),
                typed_note("b.md", "Beta", &[("stage", "seed")]),
                typed_note("c.md", "Cyan", &[("stage", "series-a")]),
            ],
        )
        .unwrap();
        rebuild_views(&index, &[company_type()]).unwrap();

        let result = run_query(
            &index,
            "SELECT COALESCE(\"stage\", '') AS \"label\", COUNT(*) AS \"count\"\nFROM \"v_company\"\nGROUP BY COALESCE(\"stage\", '')\nORDER BY \"count\" DESC, \"label\" ASC\nLIMIT ?",
            &[serde_json::json!(50)],
        )
        .unwrap();

        assert_eq!(result.columns, vec!["label", "count"]);
        assert_eq!(result.rows[0][0], serde_json::json!("seed"));
        assert_eq!(result.rows[0][1], serde_json::json!(2));
        assert_eq!(result.rows[1][0], serde_json::json!("series-a"));
    }

    #[test]
    fn a_note_missing_the_grouping_property_counts_under_the_empty_label() {
        let mut index = empty_index();
        put_notes(
            &mut index,
            &[
                typed_note("a.md", "Acme", &[("stage", "seed")]),
                typed_note("b.md", "Beta", &[]),
            ],
        )
        .unwrap();
        rebuild_views(&index, &[company_type()]).unwrap();

        let result = run_query(
            &index,
            "SELECT COALESCE(\"stage\", '') AS \"label\", COUNT(*) AS \"count\"\nFROM \"v_company\"\nGROUP BY COALESCE(\"stage\", '')\nORDER BY \"count\" DESC, \"label\" ASC\nLIMIT ?",
            &[serde_json::json!(50)],
        )
        .unwrap();

        let labels: Vec<&serde_json::Value> = result.rows.iter().map(|row| &row[0]).collect();
        assert!(labels.contains(&&serde_json::json!("")));
    }

    #[test]
    fn a_broken_query_is_an_error_rather_than_a_panic() {
        let index = empty_index();
        assert!(run_query(&index, "SELECT nope FROM nowhere", &[]).is_err());
    }

    #[cfg(test)]
    mod card_tests {
        use super::*;

        #[test]
        fn a_view_prefers_the_title_the_note_gives_itself() {
            let mut index = empty_index();

            let mut note = IndexedNote {
                path: "P00-01.md".into(),
                title: "P00-01".into(),
                modified: 1,
                size: 1,
                digest: String::new(),
                note_type: None,
                body: "body".into(),
                summary: "What it is about.".into(),
                properties: vec![
                    IndexedProperty {
                        key: "type".into(),
                        index: 0,
                        text: Some("task".into()),
                        number: None,
                        date: None,
                        json: None,
                    },
                    IndexedProperty {
                        key: "title".into(),
                        index: 0,
                        text: Some("Install the toolchain".into()),
                        number: None,
                        date: None,
                        json: None,
                    },
                ],
                links: Vec::new(),
                tags: Vec::new(),
                relations: Vec::new(),
                blocks: Vec::new(),
                checks: Vec::new(),
                progress: None,
                highlights: Vec::new(),
            };
            note.links.clear();
            put_notes(&mut index, &[note]).unwrap();
            rebuild_views(&index, &[spec_of("task", false, Vec::new())]).unwrap();

            let result =
                run_query(&index, "SELECT title, summary, modified FROM v_task", &[]).unwrap();
            assert_eq!(
                result.rows[0][0],
                serde_json::json!("Install the toolchain")
            );
            assert_eq!(result.rows[0][1], serde_json::json!("What it is about."));
            // A feed orders by when the file last changed, so the view carries it.
            assert_eq!(result.rows[0][2], serde_json::json!(1));
        }

        #[test]
        fn a_view_falls_back_to_the_filename_when_there_is_no_title() {
            let mut index = empty_index();

            let mut note = note("plain.md", "plain", "body");
            note.properties = vec![property("type", "task")];
            put_notes(&mut index, &[note]).unwrap();
            rebuild_views(&index, &[spec_of("task", false, Vec::new())]).unwrap();

            let result = run_query(&index, "SELECT title FROM v_task", &[]).unwrap();
            assert_eq!(result.rows[0][0], serde_json::json!("plain"));
        }

        #[test]
        fn an_empty_index_answers_without_failing() {
            let index = empty_index();
            assert!(manifest(&index).unwrap().is_empty());
            assert!(search(&index, "anything", 10, None).unwrap().is_empty());
            assert!(backlinks(&index, "a.md").unwrap().is_empty());
        }
    }

    /// Attack on PR #616 (head 8e0e3ddd): the index now runs the `SELECT`
    /// TypeScript sends for each type's view, behind `is_identifier` and a
    /// `SELECT ` prefix.
    mod attack_616b {
        use super::*;

        fn view_names(index: &Connection) -> Vec<String> {
            let mut statement = index
                .prepare("SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name")
                .unwrap();
            let names = statement
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            names
        }

        fn select_of(name: &str, select: &str) -> TypeSpec {
            TypeSpec {
                name: name.into(),
                select: select.into(),
            }
        }

        /// FAILING: `.atlas/types` may hold two types whose names differ only
        /// in case (check.ts refuses them in a FROM, `refuseSpellings`). Their
        /// views, `v_Task` and `v_task`, are one name to SQLite, so the second
        /// CREATE VIEW fails, the transaction rolls back, and no type has a
        /// view: every type's table, quick-view count and widget is broken by
        /// one stray type file, on an index first made with no views at all.
        #[test]
        fn two_types_named_alike_in_any_case_leave_every_other_type_its_view() {
            let index = empty_index();
            let result = rebuild_views(
                &index,
                &[
                    company_type(),
                    spec_of("Task", false, Vec::new()),
                    spec_of("task", false, Vec::new()),
                ],
            );
            assert!(result.is_ok(), "{result:?}");
            assert!(view_names(&index).contains(&"v_company".to_string()));
        }

        /// Text that is no single SELECT makes no view and changes nothing:
        /// a CTE that writes, a second statement after `;`, whitespace or a
        /// comment, an ATTACH, and a NUL before a second statement.
        #[test]
        fn a_view_text_never_runs_a_second_statement_or_a_write() {
            let mut index = empty_index();
            put_notes(
                &mut index,
                &[note_with_rows("a.md", &[("type", 0, "task", None)])],
            )
            .unwrap();
            let hostile = [
                "WITH x AS (SELECT 1) DELETE FROM files",
                "SELECT 1; DELETE FROM files",
                "SELECT 1;\n\n  DELETE FROM files",
                "SELECT 1 /* c */; DELETE FROM files",
                "SELECT 1 -- c\n; DELETE FROM files",
                "SELECT 1; ATTACH ':memory:' AS other",
                "SELECT 1\0; DELETE FROM files",
                " SELECT 1",
                "select 1",
            ];
            for text in hostile {
                let _ = rebuild_views(&index, &[select_of("task", text)]);
                let files: i64 = index
                    .query_row("SELECT COUNT(*) FROM files", [], |row| row.get(0))
                    .unwrap();
                assert_eq!(files, 1, "{text:?} changed the files");
                let attached: i64 = index
                    .query_row("SELECT COUNT(*) FROM pragma_database_list", [], |row| {
                        row.get(0)
                    })
                    .unwrap();
                assert_eq!(attached, 1, "{text:?} attached a database");
            }
            // A trailing comment or `;` is still the one SELECT.
            rebuild_views(&index, &[select_of("task", "SELECT 1 AS one; -- end\n")]).unwrap();
            assert_eq!(view_names(&index), vec!["v_task".to_string()]);
        }

        /// An index main made (no `props_type_fold`, main's own views) opened
        /// by this branch: the fold index is made, the next rebuild leaves
        /// only the views it was sent, and the notes are kept (same version).
        /// Then main's writes and its view text still run with the extra
        /// index in place, as they would after a roll back.
        #[test]
        fn an_index_made_on_main_gains_the_fold_index_and_loses_its_stale_views() {
            let vault = tempfile::tempdir().unwrap();
            {
                let (mut index, _) = open_database(vault.path()).unwrap();
                put_notes(
                    &mut index,
                    &[note_with_rows("a.md", &[("type", 0, "Task", None)])],
                )
                .unwrap();
                index
                    .execute_batch(
                        "DROP INDEX IF EXISTS props_type_fold;
                         CREATE VIEW \"v_task\" AS SELECT path FROM files;
                         CREATE VIEW \"v_gone\" AS SELECT path FROM files;",
                    )
                    .unwrap();
            }
            let (mut index, opened) = open_database(vault.path()).unwrap();
            assert!(!opened.fresh);
            let folds: i64 = index
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'props_type_fold'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(folds, 1);
            let folded = "SELECT n.path AS \"path\" FROM files AS n WHERE n.path IN (SELECT path FROM props WHERE key = 'type' AND lower(trim(value_text)) = 'task')";
            rebuild_views(&index, &[select_of("task", folded)]).unwrap();
            assert_eq!(view_names(&index), vec!["v_task".to_string()]);
            let rows = run_query(&index, "SELECT path FROM v_task", &[]).unwrap();
            assert_eq!(rows.rows.len(), 1);

            // Main's code on the same file: its writes and its view text.
            put_notes(
                &mut index,
                &[
                    note_with_rows("a.md", &[("type", 0, " TASK ", None)]),
                    note_with_rows("b.md", &[("type", 0, "task", None)]),
                ],
            )
            .unwrap();
            rebuild_views(&index, &[spec_of("task", false, Vec::new())]).unwrap();
            let rows = run_query(&index, "SELECT path FROM v_task", &[]).unwrap();
            assert_eq!(rows.rows.len(), 1);
            let integrity: String = index
                .query_row("PRAGMA integrity_check", [], |row| row.get(0))
                .unwrap();
            assert_eq!(integrity, "ok");
        }
    }

    /// Attacks on #135 (PR #138): what the index does now that its commands
    /// can overlap, and what the search-table shortcut left behind.
    mod attack_135 {
        use super::*;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::{mpsc, Arc};
        use std::time::Duration;

        /// How many steps SQLite takes to index again one note of an index holding this many.
        fn steps_to_index_again_a_note_of(held: usize) -> usize {
            let mut index = empty_index();
            let notes: Vec<IndexedNote> = (0..held)
                .map(|n| note(&format!("Note {n}.md"), "Note", "alpha beta gamma"))
                .collect();
            put_notes(&mut index, &notes).unwrap();

            let steps = Arc::new(AtomicUsize::new(0));
            let counted = Arc::clone(&steps);
            index
                .progress_handler(
                    1,
                    Some(move || {
                        counted.fetch_add(1, Ordering::Relaxed);
                        false
                    }),
                )
                .unwrap();
            put_notes(&mut index, &[note("Note 0.md", "Note", "delta")]).unwrap();
            steps.load(Ordering::Relaxed)
        }

        /// The shortcut only covers a note the index has never held. A note it
        /// holds still has its search row found by reading every row, so a
        /// vault whose notes all changed at once (a pull, a sync that touched
        /// every file, a relation re-resolved across the vault) is n * n again,
        /// and each batch holds the index lock, which search waits on.
        #[test]
        fn indexing_a_note_again_costs_the_same_however_many_the_index_holds() {
            let few = steps_to_index_again_a_note_of(20);
            let many = steps_to_index_again_a_note_of(2_000);
            assert!(
                many < few * 2,
                "indexing a note again among 2,000 took {many} steps, among 20 took {few}"
            );
        }

        /// Before #138 every put cleared the note's search row, so an index
        /// whose search table had got ahead of `files` healed on the next
        /// read of the note. Now the row is only cleared for a note `files`
        /// holds, and the note is found twice until the index is rebuilt.
        #[test]
        fn a_search_row_left_without_its_note_is_replaced_when_the_note_is_indexed() {
            let mut index = empty_index();
            index
                .execute(
                    "INSERT INTO fts (path, title, body) VALUES ('a.md', 'A', 'alpha as it was')",
                    [],
                )
                .unwrap();

            put_notes(&mut index, &[note("a.md", "A", "alpha as it is")]).unwrap();

            let hits = search(&index, "alpha", 10, None).unwrap();
            assert_eq!(hits.len(), 1, "the note is found {} times", hits.len());
        }

        fn notes_counted_in(index: &IndexState, root: &Path) -> serde_json::Value {
            index
                .query(root, "SELECT COUNT(*) FROM files", &[])
                .unwrap()
                .rows[0][0]
                .clone()
        }

        /// What a DFAI query (`compileAtlasQuery`) asks of every note: is this
        /// one of the types listed, in any case? Asked as the type's notes,
        /// found through `props_type_fold`. Pinned by `index-rs.pin.test.ts`.
        const NOTES_OF_A_TYPE: &str = "SELECT n.path FROM files AS n
             WHERE n.path IN (SELECT t.path FROM props AS t
                              WHERE t.key = 'type' AND lower(trim(t.value_text)) IN (?))
             ORDER BY n.title LIMIT ?";

        /// #143: a view over every meeting came back "interrupted" at 614 of them.
        #[test]
        fn checking_each_notes_type_stays_within_the_query_budget_in_a_large_vault() {
            let vault = tempfile::tempdir().unwrap();
            let index = IndexState::default();
            index.open(vault.path()).unwrap();
            let meetings: Vec<IndexedNote> = (0..1_200)
                .map(|at| IndexedNote {
                    properties: vec![property("type", "meeting")],
                    ..note(
                        &format!("meetings/{at:04}.md"),
                        &format!("Meeting {at:04}"),
                        "",
                    )
                })
                .collect();
            index.put(None, &meetings).unwrap();

            let found = index.query(
                vault.path(),
                NOTES_OF_A_TYPE,
                &[serde_json::json!("meeting"), serde_json::json!(5)],
            );

            assert_eq!(found.map(|result| result.rows.len()), Ok(5));
        }

        /// The Linked notes section of a person's page (P30-06), as
        /// `linkedSectionPlans('person', …)` writes it and `compileAtlasQuery`
        /// compiles it: `FROM meeting, person, project WHERE CONNECTED TO this
        /// AND NOT (type = meeting AND attendees = this) SORT BY modified DESC
        /// SHOW title LIMIT 202`, with `this` the person's page.
        const LINKED_NOTES_OF_A_PERSON: &str = r#"/* atlas-query */ SELECT n.path AS "path", n.title AS "title", (SELECT CASE lower(trim(t.value_text)) WHEN ? THEN ? WHEN ? THEN ? WHEN ? THEN ? END FROM props AS t WHERE t.path = n.path AND t.key = 'type' AND lower(trim(t.value_text)) IN (?, ?, ?) ORDER BY t.idx, t.rowid LIMIT 1) AS "type"
FROM files AS n
WHERE n.path IN (SELECT t.path FROM props AS t WHERE t.key = 'type' AND lower(trim(t.value_text)) IN (?, ?, ?))
  AND instr('/' || n.path, '/.') = 0 AND instr('/' || lower(n.path) || '/', '/node_modules/') = 0
  AND lower(substr(n.path, 1, 8)) <> 'archive/'
  AND NOT EXISTS (SELECT 1 FROM props AS para_value WHERE para_value.path = n.path
  AND para_value.key = 'para' AND lower(trim(para_value.value_text)) = 'archive'
  AND EXISTS (SELECT 1 FROM props AS para_type WHERE para_type.path = n.path
    AND para_type.key = 'type' AND lower(trim(para_type.value_text)) = 'project'))
  AND (((n.path <> ? AND (EXISTS (SELECT 1 FROM links AS l WHERE l.src = n.path AND l.dst = ?) OR EXISTS (SELECT 1 FROM relations AS r WHERE r.src = n.path AND r.dst = ?) OR EXISTS (SELECT 1 FROM links AS l WHERE l.src = ? AND l.dst = n.path) OR EXISTS (SELECT 1 FROM relations AS r WHERE r.src = ? AND r.dst = n.path)))) AND (NOT ((EXISTS (SELECT 1 FROM props AS p WHERE p.path = n.path AND p.key = ? AND COALESCE(p.value_text, p.value_json, '') <> '' AND lower(trim(p.value_text)) = ?)) AND (EXISTS (SELECT 1 FROM relations AS r WHERE r.src = n.path AND r.key = ? AND r.dst = ?)))))
ORDER BY NULLIF((SELECT f.modified FROM files AS f WHERE f.path = n.path ORDER BY f.rowid LIMIT 1), '') DESC NULLS LAST, n.title COLLATE NOCASE ASC, n.path ASC
LIMIT ?"#;

        /// #143's other half: `l.src = n.path AND l.dst = ?` ties `links_src`
        /// with `links_dst` (and `r.src = n.path AND r.dst = ?` ties
        /// `relations_dst` with the `src` column of `relations_src`), and the
        /// `dst` index wins. So for every note the query reads every link
        /// and relation into the page: a person in 1,000 meetings who owns
        /// 300 tasks has their page's Linked notes (and Open tasks) come back
        /// "interrupted". With `links_dst` and `relations_dst` covering
        /// `(dst, src)` both ends are looked up at once. (This vault only runs
        /// out with both indexes as they were; the tests below catch either
        /// one put back on its own.)
        #[test]
        fn a_person_in_hundreds_of_meetings_has_their_linked_notes_within_the_query_budget() {
            let vault = tempfile::tempdir().unwrap();
            let index = IndexState::default();
            index.open(vault.path()).unwrap();
            let page = "people/Mara Quill.md";
            let mut notes = vec![IndexedNote {
                properties: vec![property("type", "person")],
                ..note(page, "Mara Quill", "")
            }];
            notes.extend((0..1_000).map(|at| IndexedNote {
                properties: vec![property("type", "meeting")],
                relations: vec![relation("attendees", 0, "Mara Quill", Some(page))],
                links: vec![link("Mara Quill", Some(page))],
                ..note(
                    &format!("meetings/{at:04}.md"),
                    &format!("Meeting {at:04}"),
                    "",
                )
            }));
            notes.extend((0..300).map(|at| IndexedNote {
                properties: vec![property("type", "task")],
                relations: vec![relation("owner", 0, "Mara Quill", Some(page))],
                ..note(&format!("tasks/{at:04}.md"), &format!("Task {at:04}"), "")
            }));
            index.put(None, &notes).unwrap();

            let found = index.query(
                vault.path(),
                LINKED_NOTES_OF_A_PERSON,
                &[
                    serde_json::json!("meeting"),
                    serde_json::json!("meeting"),
                    serde_json::json!("person"),
                    serde_json::json!("person"),
                    serde_json::json!("project"),
                    serde_json::json!("project"),
                    serde_json::json!("meeting"),
                    serde_json::json!("person"),
                    serde_json::json!("project"),
                    serde_json::json!("meeting"),
                    serde_json::json!("person"),
                    serde_json::json!("project"),
                    serde_json::json!("people/Mara Quill.md"),
                    serde_json::json!("people/Mara Quill.md"),
                    serde_json::json!("people/Mara Quill.md"),
                    serde_json::json!("people/Mara Quill.md"),
                    serde_json::json!("people/Mara Quill.md"),
                    serde_json::json!("type"),
                    serde_json::json!("meeting"),
                    serde_json::json!("attendees"),
                    serde_json::json!("people/Mara Quill.md"),
                    serde_json::json!(202),
                ],
            );

            assert_eq!(found.map(|result| result.rows.len()), Ok(0));
        }

        /// The page every test below asks about, as `this`.
        const MARA: &str = "people/Mara Quill.md";

        fn person_page(path: &str, title: &str, links: Vec<IndexedLink>) -> IndexedNote {
            IndexedNote {
                properties: vec![property("type", "person")],
                links,
                ..note(path, title, "")
            }
        }

        fn meeting(
            at: usize,
            relations: Vec<IndexedRelation>,
            links: Vec<IndexedLink>,
        ) -> IndexedNote {
            IndexedNote {
                properties: vec![property("type", "meeting")],
                relations,
                links,
                ..note(
                    &format!("meetings/{at:04}.md"),
                    &format!("Meeting {at:04}"),
                    "",
                )
            }
        }

        /// How many rows a compiled DFAI query finds in an index holding
        /// `notes`, asked as `index_query` asks it, budget and all.
        fn rows_found(
            notes: &[IndexedNote],
            sql: &str,
            parameters: &[serde_json::Value],
        ) -> Result<usize, String> {
            let vault = tempfile::tempdir().unwrap();
            let index = IndexState::default();
            index.open(vault.path()).unwrap();
            index.put(None, notes).unwrap();
            index
                .query(vault.path(), sql, parameters)
                .map(|result| result.rows.len())
        }

        /// `FROM meeting WHERE LINKS TO this`, as `compileAtlasQuery` compiles it.
        const MEETINGS_LINKING_TO_THIS: &str = r#"/* atlas-query */ SELECT n.path AS "path", n.title AS "title", (SELECT CASE lower(trim(t.value_text)) WHEN ? THEN ? END FROM props AS t WHERE t.path = n.path AND t.key = 'type' AND lower(trim(t.value_text)) IN (?) ORDER BY t.idx, t.rowid LIMIT 1) AS "type"
FROM files AS n
WHERE n.path IN (SELECT t.path FROM props AS t WHERE t.key = 'type' AND lower(trim(t.value_text)) IN (?))
  AND instr('/' || n.path, '/.') = 0 AND instr('/' || lower(n.path) || '/', '/node_modules/') = 0
  AND lower(substr(n.path, 1, 8)) <> 'archive/'
  AND (EXISTS (SELECT 1 FROM links AS l WHERE l.src = n.path AND l.dst = ? AND l.src <> l.dst))
ORDER BY n.title COLLATE NOCASE ASC, n.path ASC
LIMIT ?"#;

        /// #143: `l.src = n.path AND l.dst = ?` tied `links_src (src)` with
        /// `links_dst (dst)`, and the `dst` index won, so each meeting read
        /// every link to the page before finding its own.
        #[test]
        fn what_links_to_a_person_in_two_thousand_meetings_is_found_within_the_query_budget() {
            let mut notes = vec![person_page(MARA, "Mara Quill", vec![])];
            notes.extend(
                (0..2_000).map(|at| meeting(at, vec![], vec![link("Mara Quill", Some(MARA))])),
            );

            let found = rows_found(
                &notes,
                MEETINGS_LINKING_TO_THIS,
                &[
                    serde_json::json!("meeting"),
                    serde_json::json!("meeting"),
                    serde_json::json!("meeting"),
                    serde_json::json!("meeting"),
                    serde_json::json!(MARA),
                    serde_json::json!(2_000),
                ],
            );

            assert_eq!(found, Ok(2_000));
        }

        /// `FROM meeting WHERE CONNECTED TO this`, as `compileAtlasQuery` compiles it.
        const MEETINGS_CONNECTED_TO_THIS: &str = r#"/* atlas-query */ SELECT n.path AS "path", n.title AS "title", (SELECT CASE lower(trim(t.value_text)) WHEN ? THEN ? END FROM props AS t WHERE t.path = n.path AND t.key = 'type' AND lower(trim(t.value_text)) IN (?) ORDER BY t.idx, t.rowid LIMIT 1) AS "type"
FROM files AS n
WHERE n.path IN (SELECT t.path FROM props AS t WHERE t.key = 'type' AND lower(trim(t.value_text)) IN (?))
  AND instr('/' || n.path, '/.') = 0 AND instr('/' || lower(n.path) || '/', '/node_modules/') = 0
  AND lower(substr(n.path, 1, 8)) <> 'archive/'
  AND ((n.path <> ? AND (EXISTS (SELECT 1 FROM links AS l WHERE l.src = n.path AND l.dst = ?) OR EXISTS (SELECT 1 FROM relations AS r WHERE r.src = n.path AND r.dst = ?) OR EXISTS (SELECT 1 FROM links AS l WHERE l.src = ? AND l.dst = n.path) OR EXISTS (SELECT 1 FROM relations AS r WHERE r.src = ? AND r.dst = n.path))))
ORDER BY n.title COLLATE NOCASE ASC, n.path ASC
LIMIT ?"#;

        /// #143: as for links, `r.src = n.path AND r.dst = ?` tied the `src`
        /// column of `relations_src (src, key)` with `relations_dst (dst)`.
        /// Two thousand meetings name the person only as an attendee, so each
        /// asks the links and then the relations; a thousand only link to them.
        #[test]
        fn what_is_connected_to_a_person_in_three_thousand_meetings_is_found_within_the_query_budget(
        ) {
            let mut notes = vec![person_page(MARA, "Mara Quill", vec![])];
            notes.extend((0..2_000).map(|at| {
                meeting(
                    at,
                    vec![relation("attendees", 0, "Mara Quill", Some(MARA))],
                    vec![],
                )
            }));
            notes.extend(
                (2_000..3_000).map(|at| meeting(at, vec![], vec![link("Mara Quill", Some(MARA))])),
            );

            let found = rows_found(
                &notes,
                MEETINGS_CONNECTED_TO_THIS,
                &[
                    serde_json::json!("meeting"),
                    serde_json::json!("meeting"),
                    serde_json::json!("meeting"),
                    serde_json::json!("meeting"),
                    serde_json::json!(MARA),
                    serde_json::json!(MARA),
                    serde_json::json!(MARA),
                    serde_json::json!(MARA),
                    serde_json::json!(MARA),
                    serde_json::json!(3_000),
                ],
            );

            assert_eq!(found, Ok(3_000));
        }

        /// `FROM meeting WHERE attendees CONNECTED TO this`, as
        /// `compileAtlasQuery` compiles it.
        const MEETINGS_WITH_AN_ATTENDEE_CONNECTED_TO_THIS: &str = r#"/* atlas-query */ SELECT n.path AS "path", n.title AS "title", (SELECT CASE lower(trim(t.value_text)) WHEN ? THEN ? END FROM props AS t WHERE t.path = n.path AND t.key = 'type' AND lower(trim(t.value_text)) IN (?) ORDER BY t.idx, t.rowid LIMIT 1) AS "type"
FROM files AS n
WHERE n.path IN (SELECT t.path FROM props AS t WHERE t.key = 'type' AND lower(trim(t.value_text)) IN (?))
  AND instr('/' || n.path, '/.') = 0 AND instr('/' || lower(n.path) || '/', '/node_modules/') = 0
  AND lower(substr(n.path, 1, 8)) <> 'archive/'
  AND (EXISTS (SELECT 1 FROM relations AS h WHERE h.src = n.path AND h.key = ? AND h.dst IS NOT NULL AND (h.dst <> ? AND (EXISTS (SELECT 1 FROM links AS l WHERE l.src = h.dst AND l.dst = ?) OR EXISTS (SELECT 1 FROM relations AS r WHERE r.src = h.dst AND r.dst = ?) OR EXISTS (SELECT 1 FROM links AS l WHERE l.src = ? AND l.dst = h.dst) OR EXISTS (SELECT 1 FROM relations AS r WHERE r.src = ? AND r.dst = h.dst)))))
ORDER BY n.title COLLATE NOCASE ASC, n.path ASC
LIMIT ?"#;

        /// #143: each attendee of each meeting is asked whether it links to,
        /// or names, the person — the same two ties, once per attendee rather
        /// than once per note. Of five colleagues only the first links to the
        /// person, so a fifth of the meetings are found.
        #[test]
        fn meetings_whose_attendees_are_connected_to_a_person_in_fifteen_hundred_meetings_are_found_within_the_query_budget(
        ) {
            let colleague = |at: usize| format!("people/Colleague {}.md", at % 5);
            let mut notes = vec![person_page(MARA, "Mara Quill", vec![])];
            notes.extend((0..5).map(|at| {
                let links = if at == 0 {
                    vec![link("Mara Quill", Some(MARA))]
                } else {
                    vec![]
                };
                person_page(&colleague(at), &format!("Colleague {at}"), links)
            }));
            notes.extend((0..1_500).map(|at| {
                meeting(
                    at,
                    vec![
                        relation("attendees", 0, "Mara Quill", Some(MARA)),
                        relation("attendees", 1, "Colleague", Some(&colleague(at))),
                    ],
                    vec![link("Mara Quill", Some(MARA))],
                )
            }));

            let found = rows_found(
                &notes,
                MEETINGS_WITH_AN_ATTENDEE_CONNECTED_TO_THIS,
                &[
                    serde_json::json!("meeting"),
                    serde_json::json!("meeting"),
                    serde_json::json!("meeting"),
                    serde_json::json!("meeting"),
                    serde_json::json!("attendees"),
                    serde_json::json!(MARA),
                    serde_json::json!(MARA),
                    serde_json::json!(MARA),
                    serde_json::json!(MARA),
                    serde_json::json!(MARA),
                    serde_json::json!(1_500),
                ],
            );

            assert_eq!(found, Ok(300));
        }

        /// `FROM task WHERE project.status = doing LIMIT 5000`, as
        /// `compileAtlasQuery` compiles it: a condition read through a link.
        const TASKS_BY_THEIR_PROJECTS_STATUS: &str = r#"/* atlas-query */ SELECT n.path AS "path", n.title AS "title", (SELECT CASE lower(trim(t.value_text)) WHEN ? THEN ? END FROM props AS t WHERE t.path = n.path AND t.key = 'type' AND lower(trim(t.value_text)) IN (?) ORDER BY t.idx, t.rowid LIMIT 1) AS "type", (SELECT p.value_text FROM relations AS h CROSS JOIN props AS p ON p.path = h.dst WHERE h.src = n.path AND h.key = ? AND instr('/' || h.dst, '/.') = 0 AND instr('/' || lower(h.dst) || '/', '/node_modules/') = 0 AND p.key = ? AND COALESCE(p.value_text, p.value_json, '') <> '' AND NOT EXISTS (SELECT 1 FROM props AS q WHERE q.path = p.path AND q.key = p.key AND COALESCE(q.value_text, q.value_json, '') <> '' AND q.rowid <> p.rowid) ORDER BY h.idx, p.idx, p.rowid LIMIT 1) AS "project.status"
FROM files AS n
WHERE n.path IN (SELECT t.path FROM props AS t WHERE t.key = 'type' AND lower(trim(t.value_text)) IN (?))
  AND instr('/' || n.path, '/.') = 0 AND instr('/' || lower(n.path) || '/', '/node_modules/') = 0
  AND lower(substr(n.path, 1, 8)) <> 'archive/'
  AND (EXISTS (SELECT 1 FROM relations AS h CROSS JOIN props AS p ON p.path = h.dst WHERE h.src = n.path AND h.key = ? AND instr('/' || h.dst, '/.') = 0 AND instr('/' || lower(h.dst) || '/', '/node_modules/') = 0 AND p.key = ? AND COALESCE(p.value_text, p.value_json, '') <> '' AND NOT EXISTS (SELECT 1 FROM props AS q WHERE q.path = p.path AND q.key = p.key AND COALESCE(q.value_text, q.value_json, '') <> '' AND q.rowid <> p.rowid) AND p.value_text = ?))
ORDER BY n.title COLLATE NOCASE ASC, n.path ASC
LIMIT ?"#;

        /// Attack 616b: a condition through a link must seek the task's own
        /// links and then the linked note by path. Driven from the value
        /// instead (props_key), every project holding the status was read
        /// once per task, and 8,000 tasks ran into the query budget.
        #[test]
        fn eight_thousand_tasks_asked_through_their_project_stay_within_the_query_budget() {
            let mut notes: Vec<IndexedNote> = (0..50)
                .map(|at| IndexedNote {
                    properties: vec![property("type", "project"), property("status", "doing")],
                    ..note(
                        &format!("projects/{at:02}.md"),
                        &format!("Project {at:02}"),
                        "",
                    )
                })
                .collect();
            // The tasks share their projects' status: the rows a value-driven plan walks.
            notes.extend((0..8_000).map(|at| IndexedNote {
                properties: vec![property("type", "task"), property("status", "doing")],
                relations: vec![relation(
                    "project",
                    0,
                    &format!("Project {:02}", at % 50),
                    Some(&format!("projects/{:02}.md", at % 50)),
                )],
                ..note(&format!("tasks/{at:04}.md"), &format!("Task {at:04}"), "")
            }));

            let found = rows_found(
                &notes,
                TASKS_BY_THEIR_PROJECTS_STATUS,
                &[
                    serde_json::json!("task"),
                    serde_json::json!("task"),
                    serde_json::json!("task"),
                    serde_json::json!("project"),
                    serde_json::json!("status"),
                    serde_json::json!("task"),
                    serde_json::json!("project"),
                    serde_json::json!("status"),
                    serde_json::json!("doing"),
                    serde_json::json!(5_000),
                ],
            );

            assert_eq!(found, Ok(5_000));
        }

        /// The Open tasks section of a person's page (P30-06), as
        /// `linkedSectionPlans('person', …)` writes it and `compileAtlasQuery`
        /// compiles it: `FROM task WHERE CONNECTED TO this AND status != done
        /// AND NOT (status = waiting AND waiting_on = this) SORT BY due, title
        /// GROUP BY status SHOW due LIMIT 202`, with `this` the person's page.
        const OPEN_TASKS_OF_A_PERSON: &str = r#"/* atlas-query */ SELECT n.path AS "path", n.title AS "title", (SELECT CASE lower(trim(t.value_text)) WHEN ? THEN ? END FROM props AS t WHERE t.path = n.path AND t.key = 'type' AND lower(trim(t.value_text)) IN (?) ORDER BY t.idx, t.rowid LIMIT 1) AS "type", (SELECT p.value_date FROM props AS p WHERE p.path = n.path AND p.key = ? AND COALESCE(p.value_text, p.value_json, '') <> '' AND p.value_date IS NOT NULL ORDER BY p.idx, p.rowid LIMIT 1) AS "due", (SELECT CASE WHEN count(*) = 1 THEN max(p.value_text) END FROM props AS p WHERE p.path = n.path AND p.key = ? AND COALESCE(p.value_text, p.value_json, '') <> '') AS "status"
FROM files AS n
WHERE n.path IN (SELECT t.path FROM props AS t WHERE t.key = 'type' AND lower(trim(t.value_text)) IN (?))
  AND instr('/' || n.path, '/.') = 0 AND instr('/' || lower(n.path) || '/', '/node_modules/') = 0
  AND lower(substr(n.path, 1, 8)) <> 'archive/'
  AND ((((n.path <> ? AND (EXISTS (SELECT 1 FROM links AS l WHERE l.src = n.path AND l.dst = ?) OR EXISTS (SELECT 1 FROM relations AS r WHERE r.src = n.path AND r.dst = ?) OR EXISTS (SELECT 1 FROM links AS l WHERE l.src = ? AND l.dst = n.path) OR EXISTS (SELECT 1 FROM relations AS r WHERE r.src = ? AND r.dst = n.path)))) AND (COALESCE((SELECT CASE WHEN count(*) = 1 THEN max(p.value_text) END FROM props AS p WHERE p.path = n.path AND p.key = ? AND COALESCE(p.value_text, p.value_json, '') <> '') = ?, 0) = 0)) AND ((NOT ((COALESCE((SELECT CASE WHEN count(*) = 1 THEN max(p.value_text) END FROM props AS p WHERE p.path = n.path AND p.key = ? AND COALESCE(p.value_text, p.value_json, '') <> '') = ?, 0)) AND (EXISTS (SELECT 1 FROM relations AS r WHERE r.src = n.path AND r.key = ? AND r.dst = ?))))))
ORDER BY NULLIF((SELECT replace(p.value_date, ' ', 'T') FROM props AS p WHERE p.path = n.path AND p.key = ? AND COALESCE(p.value_text, p.value_json, '') <> '' AND p.value_date IS NOT NULL ORDER BY p.idx, p.rowid LIMIT 1), '') ASC NULLS LAST, NULLIF((SELECT f.title FROM files AS f WHERE f.path = n.path ORDER BY f.rowid LIMIT 1), '') COLLATE NOCASE ASC NULLS LAST, n.title COLLATE NOCASE ASC, n.path ASC
LIMIT ?"#;

        /// #143: the person's tasks name them as owner and do not link to
        /// them, so each task asks the links and then the relations, among
        /// the links and relations of the 1,000 meetings that name them too.
        #[test]
        fn a_person_in_a_thousand_meetings_has_their_open_tasks_within_the_query_budget() {
            let mut notes = vec![person_page(MARA, "Mara Quill", vec![])];
            notes.extend((0..1_000).map(|at| {
                meeting(
                    at,
                    vec![relation("attendees", 0, "Mara Quill", Some(MARA))],
                    vec![link("Mara Quill", Some(MARA))],
                )
            }));
            notes.extend((0..1_500).map(|at| IndexedNote {
                properties: vec![property("type", "task"), property("status", "next")],
                relations: vec![relation("owner", 0, "Mara Quill", Some(MARA))],
                ..note(&format!("tasks/{at:04}.md"), &format!("Task {at:04}"), "")
            }));

            let found = rows_found(
                &notes,
                OPEN_TASKS_OF_A_PERSON,
                &[
                    serde_json::json!("task"),
                    serde_json::json!("task"),
                    serde_json::json!("task"),
                    serde_json::json!("due"),
                    serde_json::json!("status"),
                    serde_json::json!("task"),
                    serde_json::json!(MARA),
                    serde_json::json!(MARA),
                    serde_json::json!(MARA),
                    serde_json::json!(MARA),
                    serde_json::json!(MARA),
                    serde_json::json!("status"),
                    serde_json::json!("done"),
                    serde_json::json!("status"),
                    serde_json::json!("waiting"),
                    serde_json::json!("waiting_on"),
                    serde_json::json!(MARA),
                    serde_json::json!("due"),
                    serde_json::json!(202),
                ],
            );

            assert_eq!(found, Ok(202));
        }

        /// #137, at the seam the commands now share (`IndexState`): a query
        /// leaves the reading connection open, as `index_query` always has,
        /// and the index is then cleared as `index_clear` clears it. (As
        /// first written this held a connection of its own and deleted the
        /// file by hand, since there was no seam to call; it is the same
        /// question, asked of the code the commands run.)
        #[test]
        fn a_query_after_the_index_is_cleared_reads_the_index_that_is_there_now() {
            let vault = tempfile::tempdir().unwrap();
            let index = IndexState::default();
            index.open(vault.path()).unwrap();
            index.put(None, &[note("a.md", "A", "alpha")]).unwrap();
            assert_eq!(notes_counted_in(&index, vault.path()), serde_json::json!(1));

            index.clear(vault.path()).unwrap();

            assert_eq!(
                notes_counted_in(&index, vault.path()),
                serde_json::json!(0),
                "a view still reads the note the cleared index does not hold"
            );
        }

        /// The same for an index of an older shape, thrown away as the app opens the vault.
        #[test]
        fn a_query_made_before_an_old_index_is_thrown_away_does_not_outlive_it() {
            let vault = tempfile::tempdir().unwrap();
            let index = IndexState::default();
            index.open(vault.path()).unwrap();
            index.put(None, &[note("a.md", "A", "alpha")]).unwrap();
            index
                .with_connection(|connection| {
                    connection
                        .execute_batch(&format!("PRAGMA user_version = {};", SCHEMA_VERSION - 1))
                        .map_err(|error| error.to_string())
                })
                .unwrap();
            assert_eq!(notes_counted_in(&index, vault.path()), serde_json::json!(1));

            assert!(index.open(vault.path()).unwrap().fresh);

            assert_eq!(notes_counted_in(&index, vault.path()), serde_json::json!(0));
        }

        #[test]
        fn a_query_reads_the_vault_it_names_not_the_one_last_read() {
            let (larkspur, quill) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
            let index = IndexState::default();
            index.open(quill.path()).unwrap();
            index.put(None, &[note("q.md", "Q", "quill")]).unwrap();
            index.open(larkspur.path()).unwrap();
            assert_eq!(
                notes_counted_in(&index, larkspur.path()),
                serde_json::json!(0)
            );

            // Asked of the other vault, as a query arriving before its `index_open` is.
            assert_eq!(notes_counted_in(&index, quill.path()), serde_json::json!(1));
        }

        /// A batch read from one vault, arriving after another has been opened.
        #[test]
        fn a_batch_meant_for_a_vault_no_longer_open_is_refused_not_written_to_the_next() {
            let (larkspur, quill) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
            let index = IndexState::default();
            index.open(larkspur.path()).unwrap();
            index.open(quill.path()).unwrap();
            let late = [note("Idea.md", "Idea", "a spark in Larkspur")];

            let refused = index.put(larkspur.path().to_str(), &late).unwrap_err();

            assert_eq!(
                refused,
                "another vault was opened before this could be indexed"
            );
            assert_eq!(notes_counted_in(&index, quill.path()), serde_json::json!(0));
            // Meant for the vault that is open, it is written.
            index.put(quill.path().to_str(), &late).unwrap();
            assert_eq!(notes_counted_in(&index, quill.path()), serde_json::json!(1));
        }

        /// The views are dropped and made again as one change: a reader never
        /// finds a type without its view, and a rebuild that fails part-way
        /// leaves the views that were there.
        #[test]
        fn views_made_again_are_replaced_in_one_step_or_not_at_all() {
            let vault = tempfile::tempdir().unwrap();
            let index = IndexState::default();
            index.open(vault.path()).unwrap();
            let spec = |name: &str| spec_of(name, false, Vec::new());
            index
                .with_connection(|connection| rebuild_views(connection, &[spec("task")]))
                .unwrap();

            // The second view cannot be made, after the old ones are dropped.
            let failed = index.with_connection(|connection| {
                rebuild_views(
                    connection,
                    &[
                        spec("meeting"),
                        TypeSpec {
                            name: "project".into(),
                            select: "SELECT FROM WHERE".into(),
                        },
                    ],
                )
            });

            assert!(failed.is_err());
            index
                .query(vault.path(), "SELECT COUNT(*) FROM v_task", &[])
                .expect("the view that was there is gone");
        }

        /// Runs `work` on its own thread and fails if it has not finished in time: a deadlock, said.
        fn within<T: Send + 'static>(
            limit: Duration,
            work: impl FnOnce() -> T + Send + 'static,
        ) -> T {
            let (done, finished) = mpsc::channel();
            std::thread::spawn(move || {
                let _ = done.send(work());
            });
            finished
                .recv_timeout(limit)
                .expect("the index did not answer in time: a deadlock, or a panic")
        }

        /// Batches written, queries read and the index cleared, all at once, as
        /// the commands may now be (they are `async`, so no thread orders them).
        /// Nothing may fail for want of a lock, nothing may hang, and a query
        /// may not be answered from a file that is half way to being an index:
        /// on the main thread a query ran before a clear or after it, never during.
        #[test]
        fn puts_queries_and_clears_at_once_never_fail_or_find_a_half_made_index() {
            let problems = within(Duration::from_secs(120), || {
                let vault = tempfile::tempdir().unwrap();
                let root = vault.path().to_path_buf();
                // The state the commands share, and its own `put`, `clear` and
                // `query`: what `index_put`, `index_clear` and `index_query` run.
                // (As first written this took the lock, deleted the file and
                // opened a reader by hand, mirroring the commands as they were.)
                let held = Arc::new(IndexState::default());
                held.open(&root).unwrap();
                let problems = Arc::new(Mutex::new(Vec::<String>::new()));
                let said = |problems: &Arc<Mutex<Vec<String>>>, who: &str, problem: String| {
                    problems.lock().unwrap().push(format!("{who}: {problem}"));
                };

                let mut threads = Vec::new();
                for writer in 0..3 {
                    let (held, problems, root) =
                        (Arc::clone(&held), Arc::clone(&problems), root.clone());
                    threads.push(std::thread::spawn(move || {
                        for batch in 0..40 {
                            let notes: Vec<IndexedNote> = (0..50)
                                .map(|n| {
                                    note(
                                        &format!("w{writer}/b{batch}/n{n}.md"),
                                        "Note",
                                        "alpha beta",
                                    )
                                })
                                .collect();
                            if let Err(problem) = held.put(root.to_str(), &notes) {
                                said(&problems, "put", problem);
                            }
                        }
                    }));
                }
                {
                    let (held, problems, root) =
                        (Arc::clone(&held), Arc::clone(&problems), root.clone());
                    threads.push(std::thread::spawn(move || {
                        for _ in 0..25 {
                            if let Err(problem) = held.clear(&root) {
                                said(&problems, "clear", problem);
                            }
                            std::thread::yield_now();
                        }
                    }));
                }
                for _ in 0..3 {
                    let (held, problems, root) =
                        (Arc::clone(&held), Arc::clone(&problems), root.clone());
                    threads.push(std::thread::spawn(move || {
                        for _ in 0..400 {
                            let answer = held.query(&root, "SELECT COUNT(*) FROM files", &[]);
                            if let Err(problem) = answer {
                                said(&problems, "query", problem);
                            }
                        }
                    }));
                }
                for thread in threads {
                    thread.join().expect("a command panicked");
                }
                let problems = problems.lock().unwrap().clone();
                problems
            });

            let mut kinds: Vec<String> = problems.clone();
            kinds.sort();
            kinds.dedup();
            assert!(
                problems.is_empty(),
                "{} commands failed; the kinds of failure: {kinds:#?}",
                problems.len()
            );
        }

        /// The open projects tied to a meeting's people, as
        /// `compileProjectTiesQuery` writes it for one attendee.
        const PROJECT_TIES_OF_ONE_PERSON: &str = r#"/* meeting links: projects */ WITH open_projects AS (
  SELECT files.path AS path, files.title AS title FROM files
   WHERE files.path IN (SELECT path FROM props WHERE key = 'type' AND value_text = ?)
     AND instr('/' || files.path, '/.') = 0 AND instr('/' || lower(files.path) || '/', '/node_modules/') = 0 AND lower(substr(files.path, 1, 8)) <> 'archive/'
     AND NOT EXISTS (SELECT 1 FROM props AS state WHERE state.path = files.path
                      AND state.key = 'status' AND lower(state.value_text) IN (?, ?, ?))
)
SELECT open_projects.path AS "project", open_projects.title AS "title", relations.dst AS "entity"
  FROM open_projects JOIN relations ON relations.src = open_projects.path
 WHERE relations.dst IN (?)
UNION
SELECT open_projects.path, open_projects.title, relations.src
  FROM open_projects JOIN relations ON relations.dst = open_projects.path
 WHERE relations.src IN (?)
UNION
SELECT open_projects.path, open_projects.title, other.dst
  FROM open_projects
  CROSS JOIN relations AS filed ON filed.dst = open_projects.path AND filed.key = ?
  CROSS JOIN relations AS other ON other.src = filed.src AND other.key IN (?, ?)
 WHERE +other.dst IN (?) AND filed.src <> ?
ORDER BY 1, 3"#;

        /// Adversarial (#143, eacb525): joined plainly, `filed.dst =
        /// open_projects.path AND filed.src = other.src` ties
        /// `relations_dst (dst, src)` with `relations_src (src, key)`; SQLite
        /// starts from the person and takes the dst index with `dst` bound to
        /// every open project, so each meeting naming the person probes once
        /// per project and the query runs out of the budget (6.4M steps here).
        /// `CROSS JOIN` and `+other.dst` pin it to project first, then each
        /// filed note's own links: about 0.18M.
        #[test]
        fn linking_a_meeting_whose_attendee_is_in_thousands_of_meetings_finds_project_ties_within_the_query_budget(
        ) {
            let mut notes = vec![person_page(MARA, "Mara Quill", vec![])];
            notes.extend((0..500).map(|at| IndexedNote {
                properties: vec![property("type", "project")],
                ..note(
                    &format!("projects/{at:03}.md"),
                    &format!("Project {at:03}"),
                    "",
                )
            }));
            notes.extend((0..2_500).map(|at| {
                meeting(
                    at,
                    vec![
                        relation("people", 0, "Mara Quill", Some(MARA)),
                        relation(
                            "project",
                            0,
                            "P",
                            Some(&format!("projects/{:03}.md", at % 500)),
                        ),
                    ],
                    vec![],
                )
            }));

            let found = rows_found(
                &notes,
                PROJECT_TIES_OF_ONE_PERSON,
                &[
                    serde_json::json!("project"),
                    serde_json::json!("done"),
                    serde_json::json!("cancelled"),
                    serde_json::json!("dropped"),
                    serde_json::json!(MARA),
                    serde_json::json!(MARA),
                    serde_json::json!("project"),
                    serde_json::json!("people"),
                    serde_json::json!("companies"),
                    serde_json::json!(MARA),
                    serde_json::json!("meetings/0001.md"),
                ],
            );

            assert_eq!(found, Ok(500));
        }
    }

    /// Unlinked mentions asks for the top 25 hits on a note's name and keeps
    /// those whose body names it. A folder of 30 notes named for the project
    /// must not fill all 25 slots on the folder name alone.
    #[test]
    fn a_body_mention_is_not_crowded_out_of_the_first_25_hits_by_a_folder_name() {
        let mut index = empty_index();
        let mut notes: Vec<IndexedNote> = (0..30)
            .map(|i| {
                note(
                    &format!("Projects/Larkspur/Notes {i:02}.md"),
                    &format!("Notes {i:02}"),
                    "rollout plan and open questions",
                )
            })
            .collect();
        notes.push(note(
            "Daily/2026-10-01.md",
            "2026-10-01",
            "Met with Larkspur about the rollout.",
        ));
        put_notes(&mut index, &notes).unwrap();

        let hits = search(&index, "\"Larkspur\"*", 25, None).unwrap();
        let paths: Vec<&str> = hits.iter().map(|hit| hit.path.as_str()).collect();
        assert!(
            paths.contains(&"Daily/2026-10-01.md"),
            "the only note mentioning Larkspur in its body is missing from the top 25: {paths:?}"
        );
    }

    /// Every note's path ends `.md`; the extension is not something anyone
    /// searches for, and as a prefix term "m" would match the whole vault.
    #[test]
    fn searching_md_does_not_match_every_note_by_its_extension() {
        let mut index = empty_index();
        put_notes(
            &mut index,
            &[
                note("Projects/Q3.md", "Q3", "budget review"),
                note("People/Tobias Fenn.md", "Tobias Fenn", "engineer"),
                note("Daily/2026-10-14.md", "2026-10-14", "standup at ten"),
            ],
        )
        .unwrap();
        let hits = search(&index, "\"md\"*", 10, None).unwrap();
        let paths: Vec<&str> = hits.iter().map(|hit| hit.path.as_str()).collect();
        assert!(paths.is_empty(), "no note says md, yet: {paths:?}");
    }

    // --- Tests for the research area (#507): highlights_fts under hostile input. ---

    fn highlight_search_index() -> Connection {
        let mut index = empty_index();
        let mut source = note("Library/Art.md", "The Art of War", "notes body");
        let mut commented = highlight("k1", "All warfare is based on deception");
        commented.comment = "Compare the Larkspur pitch".to_string();
        source.highlights = vec![
            commented,
            highlight("k2", "Know the enemy and know yourself"),
        ];
        put_notes(&mut index, &[source]).unwrap();
        index
    }

    /// What `toSearchQuery` makes of what was typed: each word quoted, the last a prefix.
    fn typed(words: &str) -> String {
        let terms: Vec<String> = words
            .split_whitespace()
            .map(|term| term.replace('"', ""))
            .filter(|term| !term.is_empty())
            .collect();
        let last = terms.len().saturating_sub(1);
        terms
            .iter()
            .enumerate()
            .map(|(at, term)| {
                if at == last {
                    format!("\"{term}\"*")
                } else {
                    format!("\"{term}\"")
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    #[test]
    fn highlight_search_fts_syntax_typed_into_search_neither_errors_nor_matches_everything() {
        let index = highlight_search_index();
        for words in [
            "-", "*", ":", "^", "NEAR", "NEAR(", "quote:", "-enemy", "enemy*", "\"enemy", "AND",
            "OR", "NOT", "(", ")", "{quote}", "+", "a:b", "'", "‐", "…",
        ] {
            let query = typed(words);
            let found = search_highlights(&index, &query, 10, None)
                .unwrap_or_else(|error| panic!("{words:?} as {query:?} failed: {error}"));
            assert!(
                found.len() < 2,
                "{words:?} as {query:?} matched every highlight: {found:?}",
                found = found
                    .iter()
                    .map(|hit| hit.block.clone())
                    .collect::<Vec<_>>()
            );
        }
    }

    #[test]
    fn highlight_search_a_very_long_typed_query_is_answered_not_an_error() {
        let index = highlight_search_index();
        let words = vec!["enemy"; 400].join(" ");
        let found = search_highlights(&index, &typed(&words), 10, None);
        assert!(found.is_ok(), "400 words failed: {:?}", found.err());
        let long_word = "x".repeat(20_000);
        assert!(search_highlights(&index, &typed(&long_word), 10, None).is_ok());
    }

    #[test]
    fn highlight_search_reordering_a_notes_highlights_keeps_each_hit_on_its_own_block() {
        let mut index = highlight_search_index();
        let mut reordered = note("Library/Art.md", "The Art of War", "notes body");
        reordered.highlights = vec![
            highlight("k2", "Know the enemy and know yourself"),
            highlight("k1", "All warfare is based on deception"),
            highlight("k3", "Supreme excellence"),
        ];
        put_notes(&mut index, &[reordered]).unwrap();
        let block = |query: &str| {
            search_highlights(&index, query, 10, None)
                .unwrap()
                .into_iter()
                .map(|hit| hit.block)
                .collect::<Vec<_>>()
        };
        assert_eq!(block("\"enemy\""), vec![Some("k2".to_string())]);
        assert_eq!(block("\"deception\""), vec![Some("k1".to_string())]);
        assert_eq!(block("\"excellence\""), vec![Some("k3".to_string())]);
        // The comment went with its highlight: k1 is rewritten without one.
        assert!(block("\"larkspur\"").is_empty());
        let (rows, searchable): (i64, i64) = index
            .query_row(
                "SELECT (SELECT count(*) FROM highlights), (SELECT count(*) FROM highlights_fts)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((rows, searchable), (3, 3));
    }

    #[test]
    fn highlight_search_a_prefix_finds_a_longer_word_and_a_folded_accent() {
        let index = highlight_search_index();
        let hits = search_highlights(&index, &typed("war"), 10, None).unwrap();
        assert_eq!(
            hits.iter().map(|hit| hit.block.clone()).collect::<Vec<_>>(),
            vec![Some("k1".to_string())]
        );
        let hits = search_highlights(&index, &typed("décéption"), 10, None).unwrap();
        assert_eq!(hits.len(), 1);
    }

    // --- The Library's and All highlights' statements, as TypeScript compiles them (#507). ---

    /// The text `research-statements.golden.test.ts` compiles and checks in.
    const RESEARCH_STATEMENTS: &str =
        include_str!("../../../../packages/domain/src/research/research-statements.golden.json");

    fn research_statement(name: &str) -> (String, Vec<serde_json::Value>) {
        let statements: serde_json::Value = serde_json::from_str(RESEARCH_STATEMENTS).unwrap();
        let statement = &statements[name];
        (
            statement["sql"].as_str().unwrap().to_string(),
            statement["parameters"].as_array().unwrap().clone(),
        )
    }

    fn literature(path: &str) -> IndexedNote {
        let mut source = note(path, path.trim_start_matches("Library/"), "");
        source.note_type = Some("literature".to_string());
        source.properties = vec![IndexedProperty {
            key: "type".to_string(),
            index: 0,
            text: Some("literature".to_string()),
            number: None,
            date: None,
            json: None,
        }];
        source
    }

    const SEEDED_SOURCES: usize = 1_500;
    const HIGHLIGHTS_PER_SOURCE: usize = 100;

    /// 150,000 highlights in 1,500 literature notes, and some that must not be listed:
    /// those of a note that is not literature, and of one in the Archive.
    fn seeded_research_index(root: &Path) {
        let (mut writer, _) = open_database(root).unwrap();
        let mut sources: Vec<IndexedNote> = (0..SEEDED_SOURCES)
            .map(|at| literature(&format!("Library/Shelf {at:04}.md")))
            .collect();
        sources.push(literature("Library/Ledger.md"));
        sources.push(literature("Library/Verses.md"));
        sources.push(literature("Archive/Old Ledger.md"));
        sources.push(note("Notes/Plain.md", "Plain", ""));
        put_notes(&mut writer, &sources).unwrap();
        let transaction = writer.transaction().unwrap();
        {
            let mut insert = transaction
                .prepare(
                    "INSERT INTO highlights (path, idx, id, kind, quote, comment, mark, color, anchor)
                     VALUES (?1, ?2, ?3, 'pdf', ?4, '', 'highlight', 'yellow', '{\"page\":3}')",
                )
                .unwrap();
            for source in &sources {
                let count = if source.path.starts_with("Library/Shelf") {
                    HIGHLIGHTS_PER_SOURCE
                } else {
                    5
                };
                for at in 0..count {
                    let quote = format!("Quote {at} of {}", source.path);
                    insert
                        .execute(params![source.path, at as i64, format!("h{at:05}"), quote])
                        .unwrap();
                }
            }
        }
        transaction.commit().unwrap();
    }

    #[test]
    fn research_statements_read_the_library_and_every_highlight_page_under_the_step_budget() {
        let vault = tempfile::tempdir().unwrap();
        seeded_research_index(vault.path());
        // The connection queries run on: read-only, with the step budget and the authorizer.
        let reader = open_for_queries(vault.path()).unwrap();

        let (sql, parameters) = research_statement("library");
        let library = run_query(&reader, &sql, &parameters).unwrap();
        assert_eq!(
            library.rows.len(),
            SEEDED_SOURCES + 2,
            "the Archive's is not listed"
        );
        assert!(!library.truncated);

        let (sql, first) = research_statement("highlights");
        let mut parameters = first;
        let mut read = 0;
        let mut pages = 0;
        loop {
            let page = run_query(&reader, &sql, &parameters)
                .unwrap_or_else(|error| panic!("page {pages} failed: {error}"));
            read += page.rows.len();
            pages += 1;
            let size = parameters[2].as_u64().unwrap() as usize;
            let Some(last) = page.rows.last().filter(|_| page.rows.len() == size) else {
                break;
            };
            parameters[0] = last[0].clone();
            parameters[1] = last[1].clone();
        }
        assert_eq!(
            read,
            SEEDED_SOURCES * HIGHLIGHTS_PER_SOURCE + 10,
            "only literature notes in use"
        );
        assert!(pages > 50, "{pages} pages");
    }

    #[test]
    fn research_statements_walk_the_highlights_by_their_key_not_an_offset() {
        let vault = tempfile::tempdir().unwrap();
        seeded_research_index(vault.path());
        let reader = open_for_queries(vault.path()).unwrap();
        let (sql, parameters) = research_statement("highlightsAfter");
        let plan: Vec<String> = reader
            .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
            .unwrap()
            .query_map(
                rusqlite::params_from_iter(parameters.iter().map(|value| match value {
                    serde_json::Value::Number(number) => {
                        rusqlite::types::Value::Real(number.as_f64().unwrap())
                    }
                    other => rusqlite::types::Value::Text(other.as_str().unwrap().to_string()),
                })),
                |row| row.get::<_, String>(3),
            )
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert!(
            plan.iter().any(|step| step.contains("highlights_path_idx")),
            "the highlights are read by their key index: {plan:?}"
        );
        assert!(
            !plan.iter().any(|step| step.starts_with("SCAN highlights")),
            "never a scan of all highlights: {plan:?}"
        );
    }

    #[test]
    fn research_statements_for_a_few_notes_read_only_those_notes() {
        let vault = tempfile::tempdir().unwrap();
        seeded_research_index(vault.path());
        let reader = open_for_queries(vault.path()).unwrap();
        let (sql, parameters) = research_statement("libraryOfNotes");
        let library = run_query(&reader, &sql, &parameters).unwrap();
        let paths: Vec<&str> = library
            .rows
            .iter()
            .map(|row| row[0].as_str().unwrap())
            .collect();
        assert_eq!(paths, vec!["Library/Ledger.md", "Library/Verses.md"]);
        let (sql, parameters) = research_statement("highlightsOfNotes");
        let highlights = run_query(&reader, &sql, &parameters).unwrap();
        assert_eq!(highlights.rows.len(), 10);
        assert!(highlights.rows.iter().all(|row| {
            matches!(
                row[0].as_str(),
                Some("Library/Ledger.md" | "Library/Verses.md")
            )
        }));
    }
}
