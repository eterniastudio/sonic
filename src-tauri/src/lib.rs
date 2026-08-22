mod acquisition;
mod audio_analysis;
mod commands;
mod error;
mod filesystem;
mod jobs;
mod media_retry;
mod metadata;
mod models;
mod presets;
mod preview;
mod sidecar;
mod stem_separator;
mod storage;
mod tools;

use jobs::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let state = AppState::initialize(app.handle()).map_err(|error| {
                std::io::Error::other(format!(
                    "Sonic could not initialize its local state: {}",
                    error.public_message()
                ))
            })?;
            app.manage(state.clone());
            state.dispatch(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap,
            commands::inspect_source,
            commands::list_export_presets,
            commands::preview_filename,
            preview::prepare_preview,
            preview::release_preview,
            commands::enqueue_exports,
            commands::list_jobs,
            commands::get_job,
            commands::update_queued_job,
            commands::cancel_job,
            commands::retry_job,
            commands::remove_job,
            commands::reorder_queue,
            commands::set_queue_paused,
            commands::list_library,
            commands::get_library_item,
            commands::reexport_library_item,
            commands::remove_library_item,
            commands::get_settings,
            commands::update_settings,
            commands::get_diagnostics,
            commands::export_diagnostics,
            commands::check_dependencies,
            commands::get_default_output_dir,
            commands::prepare_media_engine,
            commands::stem_engine_status,
            commands::prepare_stem_engine,
            commands::separate_library_item_stems,
            commands::inspect_video,
            commands::start_download,
            commands::cancel_download,
            // v0.3 Library Intelligence
            commands::create_library_root,
            commands::list_library_roots,
            commands::update_library_root,
            commands::delete_library_root,
            commands::relink_library_root,
            commands::create_tag,
            commands::list_tags,
            commands::update_tag,
            commands::delete_tag,
            commands::assign_tag_to_item,
            commands::remove_tag_from_item,
            commands::get_item_tags,
            commands::create_collection,
            commands::list_collections,
            commands::update_collection,
            commands::delete_collection,
            commands::add_items_to_collection,
            commands::remove_items_from_collection,
            commands::list_collection_items,
            commands::bulk_tag_items,
            commands::bulk_update_items,
            commands::bulk_delete_items,
            commands::find_duplicates_by_sha256,
            commands::find_duplicates_by_source_fingerprint,
            commands::scan_sidecar_folder
        ])
        .build(tauri::generate_context!())
        .expect("error while building Sonic");

    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            app.state::<AppState>().shutdown();
        }
    });
}
