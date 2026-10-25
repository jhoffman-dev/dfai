use super::*;

const GENERATION: &str = "chunks-1";

fn note(path: &str, digest: &str) -> CachedNote {
    CachedNote {
        path: path.into(),
        digest: digest.into(),
        title: format!("Title of {path}"),
    }
}

fn block(ordinal: i64, digest: &str, vector: Option<Vec<f32>>) -> BlockToPut {
    BlockToPut {
        block: CachedBlock {
            ordinal,
            digest: digest.into(),
            anchor: (ordinal == 0).then(|| "k3x9a1".to_string()),
            heading: Some("Payroll".into()),
            excerpt: format!("Block {ordinal}"),
        },
        vector,
    }
}

fn put(path: &str, digest: &str, blocks: Vec<BlockToPut>) -> NoteToPut {
    NoteToPut {
        note: note(path, digest),
        blocks,
    }
}

/// The load's bytes, split back into its header (the first line's notes and
/// dimensions, with the blocks of every line after it) and its vectors.
fn read_back(bytes: &[u8]) -> (serde_json::Value, Vec<f32>) {
    let length = u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize;
    assert_eq!(length % 4, 0, "the vectors must begin where an f32 may");
    let text = std::str::from_utf8(&bytes[4..4 + length]).unwrap();
    let mut lines = text.split('\n');
    let mut header: serde_json::Value = serde_json::from_str(lines.next().unwrap()).unwrap();
    let blocks: Vec<serde_json::Value> = lines
        .flat_map(|line| serde_json::from_str::<Vec<serde_json::Value>>(line).unwrap())
        .collect();
    header["blocks"] = serde_json::Value::Array(blocks);
    let vectors = bytes[4 + length..]
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes(chunk.try_into().unwrap()))
        .collect();
    (header, vectors)
}

fn opened(root: &Path) -> EmbeddingCacheState {
    let state = EmbeddingCacheState::default();
    assert!(state.open(root, GENERATION).unwrap().fresh);
    state
}

fn loaded(state: &EmbeddingCacheState) -> (serde_json::Value, Vec<f32>) {
    read_back(&state.with(None, |connection| load(connection)).unwrap())
}

#[test]
fn puts_and_loads_a_note_s_blocks_with_their_vectors_in_order() {
    let vault = tempfile::tempdir().unwrap();
    let state = opened(vault.path());
    state
        .with(None, |connection| {
            put_notes(
                connection,
                &[
                    put("b.md", "nb", vec![block(0, "d2", Some(vec![0.5, -0.5]))]),
                    put(
                        "a.md",
                        "na",
                        vec![
                            block(1, "d1", Some(vec![0.0, 1.0])),
                            block(0, "d0", Some(vec![1.0, 0.0])),
                        ],
                    ),
                ],
            )
        })
        .unwrap();
    let (header, vectors) = loaded(&state);
    assert_eq!(
        header["notes"][0],
        serde_json::json!({"path": "a.md", "digest": "na", "title": "Title of a.md"})
    );
    let order: Vec<(String, i64)> = header["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            (
                row["path"].as_str().unwrap().into(),
                row["ordinal"].as_i64().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        order,
        vec![("a.md".into(), 0), ("a.md".into(), 1), ("b.md".into(), 0)]
    );
    assert_eq!(header["blocks"][0]["anchor"], "k3x9a1");
    assert_eq!(header["blocks"][1]["anchor"], serde_json::Value::Null);
    assert_eq!(header["blocks"][0]["heading"], "Payroll");
    assert_eq!(header["blocks"][0]["embedded"], true);
    assert_eq!(vectors, vec![1.0, 0.0, 0.0, 1.0, 0.5, -0.5]);
}

#[test]
fn reads_back_the_words_of_the_blocks_asked_for_in_order_and_none_for_a_block_it_lacks() {
    let vault = tempfile::tempdir().unwrap();
    let state = opened(vault.path());
    state
        .with(None, |connection| {
            put_notes(
                connection,
                &[put(
                    "a.md",
                    "1",
                    vec![block(0, "d0", None), block(1, "d1", None)],
                )],
            )
        })
        .unwrap();
    let keys = [("a.md", 1, "d1"), ("gone.md", 0, "d0"), ("a.md", 0, "d0")].map(
        |(path, ordinal, digest)| BlockKey {
            path: path.into(),
            ordinal,
            digest: digest.into(),
        },
    );
    let words = state
        .with(None, |connection| excerpts(connection, &keys))
        .unwrap();
    assert_eq!(
        words,
        vec!["Block 1".to_string(), String::new(), "Block 0".to_string()]
    );
}

#[test]
fn the_load_carries_no_block_s_words() {
    let vault = tempfile::tempdir().unwrap();
    let state = opened(vault.path());
    state
        .with(None, |connection| {
            put_notes(connection, &[put("a.md", "1", vec![block(0, "d0", None)])])
        })
        .unwrap();
    assert!(loaded(&state).0["blocks"][0].get("excerpt").is_none());
}

#[test]
fn a_block_the_model_would_not_read_is_kept_without_a_vector() {
    let vault = tempfile::tempdir().unwrap();
    let state = opened(vault.path());
    state
        .with(None, |connection| {
            put_notes(
                connection,
                &[put(
                    "a.md",
                    "na",
                    vec![block(0, "d0", None), block(1, "d1", Some(vec![1.0]))],
                )],
            )
        })
        .unwrap();
    let (header, vectors) = loaded(&state);
    assert_eq!(header["blocks"][0]["embedded"], false);
    assert_eq!(header["blocks"][1]["embedded"], true);
    assert_eq!(vectors, vec![1.0]);
}

#[test]
fn putting_a_note_again_replaces_every_block_it_had() {
    let vault = tempfile::tempdir().unwrap();
    let state = opened(vault.path());
    let blocks = |count: i64| {
        (0..count)
            .map(|at| block(at, "d", Some(vec![1.0])))
            .collect()
    };
    state
        .with(None, |connection| {
            put_notes(connection, &[put("a.md", "1", blocks(3))])
        })
        .unwrap();
    state
        .with(None, |connection| {
            put_notes(connection, &[put("a.md", "2", blocks(1))])
        })
        .unwrap();
    let (header, _) = loaded(&state);
    assert_eq!(header["blocks"].as_array().unwrap().len(), 1);
    assert_eq!(header["notes"][0]["digest"], "2");
}

#[test]
fn removing_a_note_takes_its_blocks_and_its_row() {
    let vault = tempfile::tempdir().unwrap();
    let state = opened(vault.path());
    state
        .with(None, |connection| {
            put_notes(
                connection,
                &[
                    put("a.md", "1", vec![block(0, "d", Some(vec![1.0]))]),
                    put("b.md", "1", vec![]),
                ],
            )
        })
        .unwrap();
    state
        .with(None, |connection| {
            remove_notes(connection, &["a.md".into()])
        })
        .unwrap();
    let (header, vectors) = loaded(&state);
    assert_eq!(header["notes"].as_array().unwrap().len(), 1);
    assert_eq!(header["blocks"], serde_json::json!([]));
    assert!(vectors.is_empty());
}

#[test]
fn a_write_that_fails_part_way_leaves_every_note_as_it_was() {
    let vault = tempfile::tempdir().unwrap();
    let state = opened(vault.path());
    state
        .with(None, |connection| {
            put_notes(
                connection,
                &[put("a.md", "1", vec![block(0, "old", Some(vec![1.0]))])],
            )
        })
        .unwrap();
    // Two blocks at one ordinal break the key on the second note: the first must not land either.
    let failed = state.with(None, |connection| {
        put_notes(
            connection,
            &[
                put("a.md", "2", vec![block(0, "new", Some(vec![2.0]))]),
                put("b.md", "1", vec![block(0, "x", None), block(0, "y", None)]),
            ],
        )
    });
    assert!(failed.is_err());
    let (header, vectors) = loaded(&state);
    assert_eq!(header["notes"].as_array().unwrap().len(), 1);
    assert_eq!(header["notes"][0]["digest"], "1");
    assert_eq!(vectors, vec![1.0]);
}

#[test]
fn a_cache_reopened_after_a_quit_holds_what_was_written_and_is_not_fresh() {
    let vault = tempfile::tempdir().unwrap();
    {
        let state = opened(vault.path());
        state
            .with(None, |connection| {
                put_notes(
                    connection,
                    &[put("a.md", "1", vec![block(0, "d", Some(vec![0.25]))])],
                )
            })
            .unwrap();
    }
    let state = EmbeddingCacheState::default();
    assert!(!state.open(vault.path(), GENERATION).unwrap().fresh);
    let (header, vectors) = loaded(&state);
    assert_eq!(header["notes"][0]["path"], "a.md");
    assert_eq!(vectors, vec![0.25]);
}

#[test]
fn another_generation_throws_the_cache_away() {
    let vault = tempfile::tempdir().unwrap();
    {
        let state = opened(vault.path());
        state
            .with(None, |connection| {
                put_notes(connection, &[put("a.md", "1", vec![])])
            })
            .unwrap();
    }
    let state = EmbeddingCacheState::default();
    assert!(state.open(vault.path(), "chunks-2").unwrap().fresh);
    let (header, _) = loaded(&state);
    assert_eq!(header["notes"], serde_json::json!([]));
}

#[test]
fn the_generation_names_the_model_so_a_new_model_rebuilds() {
    assert_eq!(
        full_generation("chunks-1"),
        format!("chunks-1+snowflake-arctic-embed-xs@{}", MODEL.revision)
    );
}

#[test]
fn a_file_that_is_not_a_database_is_made_again_rather_than_failing() {
    let vault = tempfile::tempdir().unwrap();
    let path = database_path(vault.path()).unwrap();
    fs::write(&path, b"not a database, cut short").unwrap();
    let state = EmbeddingCacheState::default();
    assert!(state.open(vault.path(), GENERATION).unwrap().fresh);
    assert_eq!(loaded(&state).0["notes"], serde_json::json!([]));
}

#[test]
fn an_older_shape_is_thrown_away() {
    let vault = tempfile::tempdir().unwrap();
    let path = database_path(vault.path()).unwrap();
    Connection::open(&path)
        .unwrap()
        .execute_batch("CREATE TABLE old (x); PRAGMA user_version = 0;")
        .unwrap();
    let state = EmbeddingCacheState::default();
    assert!(state.open(vault.path(), GENERATION).unwrap().fresh);
}

#[test]
fn clearing_empties_the_cache_and_keeps_its_generation() {
    let vault = tempfile::tempdir().unwrap();
    let state = opened(vault.path());
    state
        .with(None, |connection| {
            put_notes(connection, &[put("a.md", "1", vec![])])
        })
        .unwrap();
    state.clear().unwrap();
    assert_eq!(loaded(&state).0["notes"], serde_json::json!([]));
    drop(state);
    // Cleared, it is still this generation's: opened again it is not fresh.
    assert!(
        !EmbeddingCacheState::default()
            .open(vault.path(), GENERATION)
            .unwrap()
            .fresh
    );
}

#[test]
fn a_write_meant_for_another_vault_is_refused() {
    let vault = tempfile::tempdir().unwrap();
    let state = opened(vault.path());
    let refused = state.with(Some("/somewhere/else"), |connection| {
        put_notes(connection, &[put("a.md", "1", vec![])])
    });
    assert_eq!(
        refused.unwrap_err(),
        "another vault was opened before this could be cached"
    );
    let root = vault.path().to_str().unwrap();
    assert!(state
        .with(Some(root), |connection| put_notes(connection, &[]))
        .is_ok());
}

#[test]
fn nothing_is_read_or_written_before_the_cache_is_opened() {
    let state = EmbeddingCacheState::default();
    assert!(state.with(None, |connection| load(connection)).is_err());
    assert!(state.clear().is_err());
}

#[test]
fn the_cache_lives_in_the_vault_s_cache_folder_beside_the_index() {
    let vault = tempfile::tempdir().unwrap();
    let _state = opened(vault.path());
    assert!(vault
        .path()
        .join(".atlas-cache")
        .join("embeddings.sqlite")
        .exists());
}

// Regression tests: a damaged cache is discarded and built again, never trusted.

#[test]
fn a_damaged_database_is_made_again_rather_than_failing_every_launch() {
    let vault = tempfile::tempdir().unwrap();
    {
        let state = opened(vault.path());
        state
            .with(None, |connection| {
                put_notes(
                    connection,
                    &[put("a.md", "1", vec![block(0, "d", Some(vec![0.25]))])],
                )
            })
            .unwrap();
    }
    // A sync tool or a crash tore the file: its 100-byte header is whole, every page after is not.
    let path = database_path(vault.path()).unwrap();
    let mut bytes = fs::read(&path).unwrap();
    for byte in bytes.iter_mut().skip(100) {
        *byte = 0xA5;
    }
    fs::write(&path, &bytes).unwrap();
    let state = EmbeddingCacheState::default();
    let opened = state.open(vault.path(), GENERATION);
    assert!(opened.is_ok(), "open failed: {opened:?}");
    assert!(opened.unwrap().fresh);
    assert_eq!(loaded(&state).0["notes"], serde_json::json!([]));
}

#[test]
fn a_load_never_hands_back_vectors_of_different_lengths_as_if_one() {
    let vault = tempfile::tempdir().unwrap();
    let state = opened(vault.path());
    // Written under the cache's own checks this cannot happen: a damaged file is what holds it.
    state
        .with(None, |connection| {
            connection
                .execute_batch(
                    "INSERT INTO notes VALUES ('a.md', '1', 'A');
                     INSERT INTO block_embeddings VALUES
                        ('a.md', 0, 'd0', NULL, NULL, 'x', X'0000803F'),
                        ('a.md', 1, 'd1', NULL, NULL, 'y', X'00000000000000000000803F');",
                )
                .map_err(|error| error.to_string())
        })
        .unwrap();
    // Read as the window reads it, 4 floats over 2 vectors are two of 2: [1, 0] and [0, 1], neither stored.
    let result = state.with(None, |connection| load(connection));
    assert!(
        result.is_err(),
        "the load handed back vectors that cannot be split back into what was stored"
    );
}

#[test]
fn a_put_of_vectors_of_different_lengths_is_refused_whole() {
    let vault = tempfile::tempdir().unwrap();
    let state = opened(vault.path());
    let mixed = state.with(None, |connection| {
        put_notes(
            connection,
            &[put(
                "a.md",
                "1",
                vec![
                    block(0, "d0", Some(vec![1.0])),
                    block(1, "d1", Some(vec![0.0, 0.0, 1.0])),
                ],
            )],
        )
    });
    assert!(mixed.unwrap_err().contains("cannot be cached together"));
    assert_eq!(loaded(&state).0["notes"], serde_json::json!([]));
}

#[test]
fn a_put_beside_vectors_of_another_length_is_refused_unless_it_replaces_them() {
    let vault = tempfile::tempdir().unwrap();
    let state = opened(vault.path());
    let one = |path: &str, numbers: Vec<f32>| put(path, "1", vec![block(0, "d", Some(numbers))]);
    state
        .with(None, |connection| {
            put_notes(connection, &[one("a.md", vec![1.0, 0.0])])
        })
        .unwrap();
    let beside = state.with(None, |connection| {
        put_notes(connection, &[one("b.md", vec![1.0, 0.0, 0.0])])
    });
    assert!(beside.unwrap_err().contains("beside vectors of 2"));
    // The note holding the only others is replaced by this write: nothing is left to disagree.
    state
        .with(None, |connection| {
            put_notes(connection, &[one("a.md", vec![1.0, 0.0, 0.0])])
        })
        .unwrap();
    assert_eq!(loaded(&state).0["dimensions"], 3);
}

#[test]
fn a_vector_that_is_not_whole_numbers_is_not_loaded() {
    let vault = tempfile::tempdir().unwrap();
    let state = opened(vault.path());
    state
        .with(None, |connection| {
            connection
                .execute_batch(
                    "INSERT INTO notes VALUES ('a.md', '1', 'A');
                     INSERT INTO block_embeddings VALUES
                        ('a.md', 0, 'd0', NULL, NULL, 'x', X'0000803F00');",
                )
                .map_err(|error| error.to_string())
        })
        .unwrap();
    assert!(state.with(None, |connection| load(connection)).is_err());
}

#[test]
fn the_header_is_padded_so_the_vectors_begin_on_a_multiple_of_four() {
    let vault = tempfile::tempdir().unwrap();
    let state = opened(vault.path());
    for (at, path) in ["a.md", "bb.md", "ccc.md", "dddd.md", "eeeee.md"]
        .iter()
        .enumerate()
    {
        state
            .with(None, |connection| {
                put_notes(
                    connection,
                    &[put(
                        path,
                        "1",
                        vec![block(0, &"d".repeat(at + 1), Some(vec![1.0]))],
                    )],
                )
            })
            .unwrap();
        let bytes = state.with(None, |connection| load(connection)).unwrap();
        let length = u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize;
        assert_eq!((4 + length) % 4, 0);
    }
}

#[test]
fn a_header_lists_a_thousand_blocks_to_a_line() {
    let vault = tempfile::tempdir().unwrap();
    let state = opened(vault.path());
    let blocks = (0..2_500).map(|at| block(at, "d", None)).collect();
    state
        .with(None, |connection| {
            put_notes(connection, &[put("a.md", "1", blocks)])
        })
        .unwrap();
    let bytes = state.with(None, |connection| load(connection)).unwrap();
    let length = u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize;
    let lines = std::str::from_utf8(&bytes[4..4 + length])
        .unwrap()
        .split('\n')
        .count();
    assert_eq!(lines, 1 + 3);
    assert_eq!(loaded(&state).0["blocks"].as_array().unwrap().len(), 2_500);
}

#[test]
fn a_hit_never_reads_the_words_of_another_block_in_its_place() {
    let vault = tempfile::tempdir().unwrap();
    let state = opened(vault.path());
    let put_one = |digest: &str, excerpt: &str| {
        let mut one = block(0, digest, None);
        one.block.excerpt = excerpt.into();
        put("a.md", digest, vec![one])
    };
    state
        .with(None, |connection| {
            put_notes(connection, &[put_one("old", "Payday moves.")])
        })
        .unwrap();
    // The block ranked as "old" at ordinal 0 is now another block: an edit above it shifted it.
    state
        .with(None, |connection| {
            put_notes(connection, &[put_one("new", "The car was sold.")])
        })
        .unwrap();
    let key = |digest: &str| BlockKey {
        path: "a.md".into(),
        ordinal: 0,
        digest: digest.into(),
    };
    let words = state
        .with(None, |connection| {
            excerpts(connection, &[key("old"), key("new")])
        })
        .unwrap();
    assert_eq!(words, vec![String::new(), "The car was sold.".to_string()]);
}

#[test]
fn a_torn_file_is_what_sqlite_calls_damage() {
    let vault = tempfile::tempdir().unwrap();
    let path = database_path(vault.path()).unwrap();
    {
        let state = opened(vault.path());
        state
            .with(None, |connection| {
                put_notes(
                    connection,
                    &[put("a.md", "1", vec![block(0, "d", Some(vec![1.0]))])],
                )
            })
            .unwrap();
    }
    let mut bytes = fs::read(&path).unwrap();
    for byte in bytes.iter_mut().skip(100) {
        *byte = 0xA5;
    }
    fs::write(&path, &bytes).unwrap();
    discard_sidecars(&path);
    let torn = Connection::open(&path).unwrap();
    let error = load(&torn).unwrap_err();
    assert!(
        error.starts_with(DAMAGE_MARK),
        "not marked as damage: {error}"
    );
}

#[test]
fn damage_met_after_opening_makes_the_cache_again_and_says_so() {
    let vault = tempfile::tempdir().unwrap();
    let state = opened(vault.path());
    state
        .with(None, |connection| {
            put_notes(
                connection,
                &[put("a.md", "1", vec![block(0, "d", Some(vec![1.0]))])],
            )
        })
        .unwrap();
    let met: Result<(), String> = state.with(None, |_| Err(format!("{DAMAGE_MARK}torn page")));
    assert_eq!(met.unwrap_err(), DAMAGED);
    // Made again: empty, of the same generation, and usable.
    assert_eq!(loaded(&state).0["notes"], serde_json::json!([]));
    state
        .with(None, |connection| {
            put_notes(connection, &[put("b.md", "1", vec![])])
        })
        .unwrap();
    drop(state);
    assert!(
        !EmbeddingCacheState::default()
            .open(vault.path(), GENERATION)
            .unwrap()
            .fresh
    );
}

#[test]
fn a_write_waits_for_another_connection_s_lock_rather_than_failing_at_once() {
    let vault = tempfile::tempdir().unwrap();
    let state = opened(vault.path());
    let path = database_path(vault.path()).unwrap();
    let other = Connection::open(&path).unwrap();
    other.execute_batch("BEGIN IMMEDIATE;").unwrap();
    let release = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        other.execute_batch("COMMIT;").unwrap();
    });
    let written = state.with(None, |connection| {
        put_notes(connection, &[put("a.md", "1", vec![])])
    });
    release.join().unwrap();
    assert!(written.is_ok(), "the write gave up: {written:?}");
}

/// The bytes a load gives, kept in a file the window's tests read too, so the
/// two ends cannot drift: `EMBEDDING_CACHE_FIXTURE=update cargo test` rewrites it.
#[test]
fn the_load_bytes_are_the_fixture_the_window_reads() {
    let vault = tempfile::tempdir().unwrap();
    let state = opened(vault.path());
    state
        .with(None, |connection| {
            put_notes(
                connection,
                &[
                    put(
                        "Meetings/Standup.md",
                        "na",
                        vec![
                            block(0, "d0", Some(vec![1.0, 0.0, 0.5])),
                            block(1, "d1", None),
                            block(2, "d2", Some(vec![0.0, 1.0, -0.5])),
                        ],
                    ),
                    put(
                        "Home/Garden é.md",
                        "nb",
                        vec![block(0, "d3", Some(vec![0.25, 0.25, 0.5]))],
                    ),
                ],
            )
        })
        .unwrap();
    let bytes = state.with(None, |connection| load(connection)).unwrap();
    let fixture =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/embedding-cache-load.bin");
    if std::env::var("EMBEDDING_CACHE_FIXTURE").as_deref() == Ok("update") {
        fs::create_dir_all(fixture.parent().unwrap()).unwrap();
        fs::write(&fixture, &bytes).unwrap();
    }
    assert_eq!(
        fs::read(&fixture).unwrap(),
        bytes,
        "the load changed shape: rewrite the fixture and the window's reader with it"
    );
}
