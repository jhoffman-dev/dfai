//! The embeddings cache (P32-02, ADR-0031): each block's vector, kept so a
//! block whose words have not changed is never embedded again.
//!
//! Like the index it is derived and disposable: a file of its own in the
//! vault's `.atlas-cache/` (`embeddings.sqlite`), never synced, which can be
//! deleted at any time and built again from the notes. It is a file of its
//! own rather than tables in `index.sqlite` so the index's frequent schema
//! changes do not throw away minutes of embedding, and so the queries a note
//! runs against the index never read 384 floats a block.
//!
//! This module stores and reads back. It decides nothing: how a note is cut
//! into blocks, what a block's digest is, which notes to embed or forget and
//! how vectors are compared are all TypeScript's, handed here as rows.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection, ErrorCode, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::ipc::Response;
use tauri::State;

use crate::embeddings::MODEL;
use crate::vault::VaultState;

/// Bumped whenever the tables below change shape. A file of another shape is
/// thrown away rather than migrated: it can simply be built again.
const SCHEMA_VERSION: i64 = 1;

const CACHE_DIR: &str = ".atlas-cache";
const DATABASE: &str = "embeddings.sqlite";

/// A note as the cache holds it: the digest of its text when it was last cut
/// into blocks, and its title, which a hit shows.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedNote {
    pub path: String,
    pub digest: String,
    pub title: String,
}

/// One block of a note, as TypeScript cut it.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedBlock {
    pub ordinal: i64,
    pub digest: String,
    pub anchor: Option<String>,
    pub heading: Option<String>,
    pub excerpt: String,
}

/// A block and its vector; no vector when the model would not read it, so
/// it is known and not sent again.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockToPut {
    #[serde(flatten)]
    pub block: CachedBlock,
    pub vector: Option<Vec<f32>>,
}

/// A note's blocks, in place of whatever the cache held of it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteToPut {
    #[serde(flatten)]
    pub note: CachedNote,
    pub blocks: Vec<BlockToPut>,
}

/// A block as read back, but its words: whether it has a vector, whose
/// numbers follow the header in the order the blocks are listed. The words
/// are read only for the blocks a search finds (`excerpts`), so loading a
/// vault's cache parses a few bytes a block rather than a paragraph.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedBlock {
    pub path: String,
    pub ordinal: i64,
    pub digest: String,
    pub anchor: Option<String>,
    pub heading: Option<String>,
    pub embedded: bool,
}

/// Which block of which note.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockKey {
    pub path: String,
    pub ordinal: i64,
    /// Which block it was when it was ranked: a block changed since reads as nothing.
    pub digest: String,
}

/// The first line of a load's header: everything but the blocks and the
/// vectors. `dimensions` is how many numbers each vector has, 0 when none do.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedHeader {
    pub dimensions: usize,
    pub notes: Vec<CachedNote>,
}

/// How many blocks one line of a load's header lists. The window reads a
/// line at a time and lets a frame go by between them, so a vault of 50,000
/// blocks is never one stretch of parsing.
const BLOCKS_PER_LINE: usize = 1_000;

/// Said of a cache that was found damaged and made again; the window starts
/// over from the notes when it hears this.
pub const DAMAGED: &str = "the embeddings cache was damaged and was made again";

/// What opening the cache found.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheOpened {
    /// True when the cache was made just now, so it holds nothing yet.
    pub fresh: bool,
}

/// The cache of the vault open now, behind one lock: every read and write is
/// short, and the build sends them one at a time.
#[derive(Default)]
pub struct EmbeddingCacheState {
    held: Mutex<Option<Held>>,
}

struct Held {
    root: PathBuf,
    /// As stored: the chunking rules' generation joined with the model's.
    generation: String,
    connection: Connection,
}

pub type SharedEmbeddingCache = Arc<EmbeddingCacheState>;

impl EmbeddingCacheState {
    /// Opens the cache of the vault at `root` for vectors of `generation`
    /// — the chunking rules TypeScript names, joined here with the model's
    /// pinned revision, since vectors from two models are not comparable.
    pub fn open(&self, root: &Path, generation: &str) -> Result<CacheOpened, String> {
        let mut held = self.held.lock().map_err(|_| "cache state poisoned")?;
        *held = None;
        let generation = full_generation(generation);
        let (connection, opened) = open_database(&database_path(root)?, &generation)?;
        *held = Some(Held {
            root: root.to_path_buf(),
            generation,
            connection,
        });
        Ok(opened)
    }

    /// Throws the cache away and makes it again, empty, for the same generation.
    pub fn clear(&self) -> Result<(), String> {
        let mut held = self.held.lock().map_err(|_| "cache state poisoned")?;
        let current = held.take().ok_or("the embeddings cache is not open")?;
        let Held {
            root,
            generation,
            connection,
        } = current;
        drop(connection);
        let path = database_path(&root)?;
        discard(&path);
        let (connection, _) = open_database(&path, &generation)?;
        *held = Some(Held {
            root,
            generation,
            connection,
        });
        Ok(())
    }

    /// Runs `action` on the cache, refusing it when the cache open now is
    /// another vault's than the one it was meant for.
    fn with<T>(
        &self,
        meant_for: Option<&str>,
        action: impl FnOnce(&mut Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut held = self.held.lock().map_err(|_| "cache state poisoned")?;
        let held = held.as_mut().ok_or("the embeddings cache is not open")?;
        if meant_for.is_some_and(|meant| Path::new(meant) != held.root) {
            return Err("another vault was opened before this could be cached".into());
        }
        action(&mut held.connection).map_err(|message| {
            if message.contains(DAMAGE_MARK) {
                // A cache is derived: a torn file is thrown away and made again, never trusted.
                recreate(held).err().unwrap_or_else(|| DAMAGED.to_string())
            } else {
                message
            }
        })
    }
}

/// Put in front of an error that says the file is damaged, for `with` to find.
const DAMAGE_MARK: &str = "damaged: ";

/// A failure as text; one that says the file is torn or is not a database is marked.
fn failure(error: rusqlite::Error) -> String {
    if is_damage(&error) {
        format!("{DAMAGE_MARK}{error}")
    } else {
        error.to_string()
    }
}

fn is_damage(error: &rusqlite::Error) -> bool {
    matches!(
        error.sqlite_error_code(),
        Some(ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase)
    )
}

/// Throws the held cache away and opens an empty one of the same generation.
fn recreate(held: &mut Held) -> Result<(), String> {
    let path = database_path(&held.root)?;
    let generation = held.generation.clone();
    // The torn file is closed first, so it can be removed and made again.
    held.connection = Connection::open_in_memory().map_err(failure)?;
    discard(&path);
    let (connection, _) = open_database(&path, &generation)?;
    held.connection = connection;
    Ok(())
}

fn full_generation(generation: &str) -> String {
    format!("{generation}+{}@{}", MODEL.folder, MODEL.revision)
}

fn database_path(root: &Path) -> Result<PathBuf, String> {
    let directory = root.join(CACHE_DIR);
    fs::create_dir_all(&directory).map_err(|error| format!("cannot create cache: {error}"))?;
    Ok(directory.join(DATABASE))
}

/// How long a statement waits for another connection's lock (the index's, a
/// sync tool's reader) before it fails, in milliseconds.
const BUSY_TIMEOUT_MS: u32 = 2_000;

/// Opens the cache at `path`, discarding one of another shape or generation
/// — or a file that is torn or not a database at all — and making it afresh.
fn open_database(path: &Path, generation: &str) -> Result<(Connection, CacheOpened), String> {
    match try_open_database(path, generation) {
        Err(message) if message.contains(DAMAGE_MARK) => {
            discard(path);
            try_open_database(path, generation)
        }
        opened => opened,
    }
}

fn try_open_database(path: &Path, generation: &str) -> Result<(Connection, CacheOpened), String> {
    let fresh = !matches_shape(path, generation)?;
    if fresh {
        discard(path);
    }
    let connection = Connection::open(path)
        .map_err(|error| format!("cannot open embeddings cache: {}", failure(error)))?;
    connection
        .execute_batch(&format!(
            "PRAGMA busy_timeout = {BUSY_TIMEOUT_MS};
            PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS notes (
                path TEXT PRIMARY KEY, digest TEXT NOT NULL, title TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS block_embeddings (
                path TEXT NOT NULL, ordinal INTEGER NOT NULL, digest TEXT NOT NULL,
                anchor TEXT, heading TEXT, excerpt TEXT NOT NULL, vector BLOB,
                PRIMARY KEY (path, ordinal)
            ) WITHOUT ROWID;"
        ))
        .map_err(|error| format!("cannot make embeddings cache: {}", failure(error)))?;
    if fresh {
        connection
            .execute(
                "INSERT OR REPLACE INTO meta (key, value) VALUES ('generation', ?1)",
                params![generation],
            )
            .and_then(|_| {
                connection.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION};"))
            })
            .map_err(|error| format!("cannot set embeddings cache version: {error}"))?;
    }
    Ok((connection, CacheOpened { fresh }))
}

/// Whether the file at `path` is a cache of this shape and generation. A
/// missing file, or one that is not a database, is not.
fn matches_shape(path: &Path, generation: &str) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }
    let connection = Connection::open(path)
        .map_err(|error| format!("cannot open embeddings cache: {}", failure(error)))?;
    let version: i64 = match connection.query_row("PRAGMA user_version", [], |row| row.get(0)) {
        Ok(version) => version,
        Err(rusqlite::Error::SqliteFailure(failure, _))
            if failure.code == rusqlite::ErrorCode::NotADatabase =>
        {
            return Ok(false)
        }
        Err(error) => {
            return Err(format!(
                "cannot read embeddings cache version: {}",
                failure(error)
            ))
        }
    };
    // A file of another version may not even have the meta table to ask.
    Ok(version == SCHEMA_VERSION && stored_generation(&connection)?.as_deref() == Some(generation))
}

fn stored_generation(connection: &Connection) -> Result<Option<String>, String> {
    connection
        .query_row(
            "SELECT value FROM meta WHERE key = 'generation'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| {
            format!(
                "cannot read embeddings cache generation: {}",
                failure(error)
            )
        })
}

/// Removes the cache and its journal files. A file already gone is what was wanted.
fn discard(path: &Path) {
    let _ = fs::remove_file(path);
    discard_sidecars(path);
}

/// Removes the journal files beside a cache.
fn discard_sidecars(path: &Path) {
    for suffix in ["-wal", "-shm"] {
        let mut sidecar = path.as_os_str().to_owned();
        sidecar.push(suffix);
        let _ = fs::remove_file(sidecar);
    }
}

/// Replaces each note's blocks with those given, in one transaction: a note
/// is held whole or as it was, never half way, whatever stops the write.
fn put_notes(connection: &mut Connection, notes: &[NoteToPut]) -> Result<(), String> {
    let transaction = connection.transaction().map_err(failure)?;
    for NoteToPut { note, .. } in notes {
        transaction
            .execute(
                "DELETE FROM block_embeddings WHERE path = ?1",
                params![note.path],
            )
            .map_err(failure)?;
    }
    check_vector_lengths(&transaction, notes)?;
    for NoteToPut { note, blocks } in notes {
        for BlockToPut { block, vector } in blocks {
            transaction
                .execute(
                    "INSERT INTO block_embeddings
                        (path, ordinal, digest, anchor, heading, excerpt, vector)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        note.path,
                        block.ordinal,
                        block.digest,
                        block.anchor,
                        block.heading,
                        block.excerpt,
                        vector.as_deref().map(vector_bytes),
                    ],
                )
                .map_err(failure)?;
        }
        transaction
            .execute(
                "INSERT OR REPLACE INTO notes (path, digest, title) VALUES (?1, ?2, ?3)",
                params![note.path, note.digest, note.title],
            )
            .map_err(failure)?;
    }
    transaction.commit().map_err(failure)
}

/// The cache holds vectors of one length — its model's — so a write of any
/// other is refused before it lands, and not found when the cache is read back.
/// Checked once the notes' old rows are gone from the transaction: what is left
/// is what the new vectors must sit beside.
fn check_vector_lengths(connection: &Connection, notes: &[NoteToPut]) -> Result<(), String> {
    let mut lengths = notes
        .iter()
        .flat_map(|note| &note.blocks)
        .filter_map(|block| block.vector.as_ref().map(Vec::len));
    let Some(first) = lengths.next() else {
        return Ok(());
    };
    if first == 0 {
        return Err("a vector of no numbers cannot be cached".into());
    }
    if let Some(other) = lengths.find(|length| *length != first) {
        return Err(format!(
            "vectors of {first} and {other} numbers cannot be cached together"
        ));
    }
    // Bytes, four to a number.
    let stored: Option<i64> = connection
        .query_row(
            "SELECT length(vector) FROM block_embeddings WHERE vector IS NOT NULL LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(failure)?;
    match stored {
        Some(bytes) if bytes != (first * 4) as i64 => Err(format!(
            "vectors of {first} numbers cannot be cached beside vectors of {}",
            bytes / 4
        )),
        _ => Ok(()),
    }
}

fn remove_notes(connection: &mut Connection, paths: &[String]) -> Result<(), String> {
    let transaction = connection.transaction().map_err(failure)?;
    for path in paths {
        for statement in [
            "DELETE FROM block_embeddings WHERE path = ?1",
            "DELETE FROM notes WHERE path = ?1",
        ] {
            transaction
                .execute(statement, params![path])
                .map_err(failure)?;
        }
    }
    transaction.commit().map_err(failure)
}

fn vector_bytes(vector: &[f32]) -> Vec<u8> {
    vector
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect()
}

/// Everything the cache holds, in one read: a little-endian u32 giving the
/// length of the header, the header, then the vectors of the blocks marked
/// embedded, in the header's order, as little-endian f32s — so a vault's
/// vectors cross to the window as bytes, not as text.
///
/// The header is lines of JSON: the first a `LoadedHeader`, then arrays of at
/// most `BLOCKS_PER_LINE` blocks each, so the window can read it a slice at a
/// time between frames. It is padded with spaces to a multiple of 4, so the
/// vectors begin where an f32 may: the window views them in place, not copied.
///
/// Every vector is of one length: rows of another, or not whole numbers, are
/// refused, since the window cuts the vectors evenly among the blocks.
fn load(connection: &Connection) -> Result<Vec<u8>, String> {
    let transaction = connection.unchecked_transaction().map_err(failure)?;
    let notes = read_notes(&transaction)?;
    let mut statement = transaction
        .prepare(
            "SELECT path, ordinal, digest, anchor, heading, vector
             FROM block_embeddings ORDER BY path, ordinal",
        )
        .map_err(failure)?;
    let mut vectors: Vec<u8> = Vec::new();
    let mut blocks = Vec::new();
    let mut dimensions: Option<usize> = None;
    let mut rows = statement.query([]).map_err(failure)?;
    while let Some(row) = rows.next().map_err(failure)? {
        let vector: Option<Vec<u8>> = row.get(5).map_err(failure)?;
        if let Some(bytes) = &vector {
            let length = whole_numbers(bytes)?;
            if *dimensions.get_or_insert(length) != length {
                return Err(format!(
                    "the cache holds vectors of {} and {length} numbers",
                    dimensions.unwrap_or_default()
                ));
            }
            vectors.extend_from_slice(bytes);
        }
        blocks.push(LoadedBlock {
            path: row.get(0).map_err(failure)?,
            ordinal: row.get(1).map_err(failure)?,
            digest: row.get(2).map_err(failure)?,
            anchor: row.get(3).map_err(failure)?,
            heading: row.get(4).map_err(failure)?,
            embedded: vector.is_some(),
        });
    }
    let header = header_lines(
        &LoadedHeader {
            dimensions: dimensions.unwrap_or_default(),
            notes,
        },
        &blocks,
    )?;
    let length = u32::try_from(header.len()).map_err(|_| "the cache header is too large")?;
    let mut bytes = Vec::with_capacity(4 + header.len() + vectors.len());
    bytes.extend_from_slice(&length.to_le_bytes());
    bytes.extend_from_slice(&header);
    bytes.extend_from_slice(&vectors);
    Ok(bytes)
}

/// How many numbers a stored vector has; it must be a whole, non-empty number of f32s.
fn whole_numbers(bytes: &[u8]) -> Result<usize, String> {
    if bytes.is_empty() || bytes.len() % 4 != 0 {
        return Err(format!(
            "a vector of {} bytes is not a whole number of numbers",
            bytes.len()
        ));
    }
    Ok(bytes.len() / 4)
}

/// The header as lines, padded to a multiple of 4 bytes with spaces.
fn header_lines(first: &LoadedHeader, blocks: &[LoadedBlock]) -> Result<Vec<u8>, String> {
    let mut header = serde_json::to_vec(first).map_err(|error| error.to_string())?;
    for line in blocks.chunks(BLOCKS_PER_LINE) {
        header.push(b'\n');
        serde_json::to_writer(&mut header, line).map_err(|error| error.to_string())?;
    }
    while header.len() % 4 != 0 {
        header.push(b' ');
    }
    Ok(header)
}

/// Each block's words, in the order asked; empty for a block the cache does not hold
/// as the digest given — one changed since the caller ranked it.
fn excerpts(connection: &Connection, keys: &[BlockKey]) -> Result<Vec<String>, String> {
    let mut statement = connection
        .prepare_cached(
            "SELECT excerpt FROM block_embeddings
             WHERE path = ?1 AND ordinal = ?2 AND digest = ?3",
        )
        .map_err(failure)?;
    keys.iter()
        .map(|key| {
            statement
                .query_row(params![key.path, key.ordinal, key.digest], |row| row.get(0))
                .optional()
                .map(Option::unwrap_or_default)
                .map_err(failure)
        })
        .collect()
}

fn read_notes(connection: &Connection) -> Result<Vec<CachedNote>, String> {
    let mut statement = connection
        .prepare("SELECT path, digest, title FROM notes ORDER BY path")
        .map_err(failure)?;
    let rows = statement
        .query_map([], |row| {
            Ok(CachedNote {
                path: row.get(0)?,
                digest: row.get(1)?,
                title: row.get(2)?,
            })
        })
        .map_err(failure)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(failure)
}

/// Cache work off the main thread, so the window never waits on SQLite.
async fn off_main<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| format!("the embeddings cache stopped: {error}"))?
}

#[tauri::command]
pub async fn embedding_cache_open(
    vault: State<'_, VaultState>,
    cache: State<'_, SharedEmbeddingCache>,
    generation: String,
) -> Result<CacheOpened, String> {
    let root = vault.root().ok_or_else(|| "no vault is open".to_string())?;
    let cache = Arc::clone(&cache);
    let opened = off_main(move || cache.open(&root, &generation)).await?;
    log::info!("embeddings cache opened (fresh: {})", opened.fresh);
    Ok(opened)
}

/// Throws the cache away and starts again: the point of it being a cache.
#[tauri::command]
pub async fn embedding_cache_clear(cache: State<'_, SharedEmbeddingCache>) -> Result<(), String> {
    let cache = Arc::clone(&cache);
    off_main(move || cache.clear()).await
}

#[tauri::command]
pub async fn embedding_cache_load(
    cache: State<'_, SharedEmbeddingCache>,
) -> Result<Response, String> {
    let cache = Arc::clone(&cache);
    let bytes = off_main(move || {
        match cache.with(None, |connection| load(connection)) {
            // Torn, and made again: what it holds now is nothing, which is the truth to hand back.
            Err(message) if message == DAMAGED => cache.with(None, |connection| load(connection)),
            loaded => loaded,
        }
    })
    .await?;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub async fn embedding_cache_excerpts(
    cache: State<'_, SharedEmbeddingCache>,
    keys: Vec<BlockKey>,
) -> Result<Vec<String>, String> {
    let cache = Arc::clone(&cache);
    off_main(move || cache.with(None, |connection| excerpts(connection, &keys))).await
}

/// `vault` is the vault the notes were read from: refused once another's cache is open.
#[tauri::command]
pub async fn embedding_cache_put(
    cache: State<'_, SharedEmbeddingCache>,
    vault: Option<String>,
    notes: Vec<NoteToPut>,
) -> Result<(), String> {
    let cache = Arc::clone(&cache);
    off_main(move || cache.with(vault.as_deref(), |connection| put_notes(connection, &notes))).await
}

#[tauri::command]
pub async fn embedding_cache_remove(
    cache: State<'_, SharedEmbeddingCache>,
    vault: Option<String>,
    paths: Vec<String>,
) -> Result<(), String> {
    let cache = Arc::clone(&cache);
    off_main(move || {
        cache.with(vault.as_deref(), |connection| {
            remove_notes(connection, &paths)
        })
    })
    .await
}

#[cfg(test)]
mod tests;
