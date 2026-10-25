mod activity;
mod api;
mod embedding_cache;
// Public for the embedding spike (`examples/embedding_spike.rs`) and its
// integration test, which run the real model outside the app.
#[doc(hidden)]
pub mod embeddings;
// Public for its integration test, which makes real PDFs on the main thread.
#[doc(hidden)]
pub mod export;
mod git_process;
mod global_capture;
mod google;
mod granola;
mod http;
mod index;
mod kindle;
mod model_http;
mod model_process;
mod navigation;
mod opener;
mod rename_migration;
mod secrets;
mod sleep_clock;
mod sqlite_source;
// Public for its integration test, which pictures a real page on the main thread.
#[doc(hidden)]
pub mod page_snapshot;
mod vault;
mod vault_entries;
mod vault_file_list;
mod vault_files;
mod watcher;

/// Reports a failure the webview caught before the app could handle it itself.
/// Without this a script error leaves a blank window and no trace of why.
#[tauri::command]
fn report_error(message: String) {
    log::error!("webview: {message}");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Before the builder: Tauri makes the app's folders and the webview its
    // storage as it starts, and the copy must find the new ones missing.
    let migrated = rename_migration::on_launch();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(global_capture::plugin())
        .plugin(navigation::guard())
        .manage(vault::VaultState::default())
        .manage(index::SharedIndex::default())
        .manage(watcher::WatcherState::default())
        .manage(api::ApiState::default())
        .manage(secrets::SecretState::default())
        .manage(sqlite_source::SqliteGrants::default())
        .manage(export::ExportGrants::default())
        .manage(model_process::ModelProcesses::default())
        .manage(git_process::GitHost::default())
        .manage(embeddings::EmbeddingState::default())
        .manage(embedding_cache::SharedEmbeddingCache::default())
        .manage(google::GoogleState::default())
        .manage(granola::GranolaState::default())
        .manage(global_capture::GlobalCaptureState::default())
        .invoke_handler(tauri::generate_handler![
            report_error,
            activity::activity_append,
            activity::activity_read,
            activity::activity_replace,
            http::http_get,
            embeddings::embed,
            embedding_cache::embedding_cache_open,
            embedding_cache::embedding_cache_clear,
            embedding_cache::embedding_cache_load,
            embedding_cache::embedding_cache_excerpts,
            embedding_cache::embedding_cache_put,
            embedding_cache::embedding_cache_remove,
            model_http::model_http_post,
            model_process::model_process_start,
            model_process::model_process_cancel,
            git_process::git_run,
            git_process::git_run_in,
            git_process::git_pick_clone_folder,
            git_process::git_folder_on_disk,
            git_process::gh_repo_create,
            git_process::this_mac_name,
            sleep_clock::host_asleep_ms,
            git_process::git_sync_file_read,
            git_process::git_sync_file_write,
            git_process::gh_repo_list,
            global_capture::global_capture_status,
            global_capture::global_capture_set,
            secrets::secret_list,
            secrets::secret_set,
            secrets::secret_bind,
            secrets::secret_delete,
            google::google_status,
            google::google_connect,
            google::google_connect_cancel,
            google::google_disconnect,
            google::google_calendar_request,
            google::google_drive_request,
            granola::granola_status,
            granola::granola_set_key,
            granola::granola_forget_key,
            granola::granola_request,
            kindle::kindle_connect,
            kindle::kindle_disconnect,
            kindle::kindle_fetch_notebook,
            sqlite_source::sqlite_source_query,
            sqlite_source::pick_sqlite_file,
            vault::pick_vault,
            vault::open_vault,
            vault::current_vault,
            vault::list_directory,
            vault::list_notes,
            vault_file_list::list_vault_files,
            index::index_open,
            index::index_clear,
            index::index_manifest,
            index::index_put,
            index::index_remove,
            index::index_search,
            index::index_backlinks,
            index::index_notes_of_type,
            index::index_rebuild_views,
            index::index_query,
            index::index_stats,
            watcher::watch_vault,
            vault::read_text_file,
            vault::read_notes,
            vault::read_binary_file,
            vault::write_text_file,
            vault_files::write_binary_file,
            opener::open_url,
            page_snapshot::snapshot_page,
            export::export_choose_destination,
            export::export_write_file,
            export::export_finish,
            export::export_render_pdf,
            vault::create_note,
            vault_entries::create_folder,
            vault_entries::move_entry,
            vault_entries::trash_entry,
            api::api_status,
            api::api_set_enabled,
            api::api_rotate_token,
            api::api_token,
            api::api_respond,
            api::api_router_ready,
        ])
        .on_page_load(api::forget_router_on_page_load)
        .setup(move |app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Debug)
                        // Replace the defaults rather than adding to them: the
                        // default set already includes the log directory, and
                        // adding it again writes every record to the file twice.
                        .clear_targets()
                        .target(tauri_plugin_log::Target::new(
                            tauri_plugin_log::TargetKind::Stdout,
                        ))
                        .target(tauri_plugin_log::Target::new(
                            tauri_plugin_log::TargetKind::LogDir { file_name: None },
                        ))
                        .build(),
                )?;
            }
            for line in &migrated {
                log::info!("migration from Atlas: {line}");
            }
            // Off until releases are signed (#481, RELEASING.md): it needs the
            // public key in tauri.conf.json, and refuses to start without one.
            #[cfg(feature = "updater")]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            api::restore(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
