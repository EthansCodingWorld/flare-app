#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod db;
mod models;
mod updater;
mod watcher;

use commands::DbState;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Listener, Manager};
use tauri_plugin_updater::UpdaterExt;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            commands::get_clips,
            commands::get_clip,
            commands::get_clips_count,
            commands::add_tags,
            commands::remove_tag,
            commands::delete_clip,
            commands::set_watch_folder,
            commands::get_watch_folder,
            commands::set_discord_config,
            commands::share_clip_to_discord,
            updater::check_for_update,
            updater::install_update,
            updater::get_app_version,
        ])
        .setup(|app| {
            let app_handle = app.handle().clone();
            let rt = tokio::runtime::Runtime::new().unwrap();

            rt.block_on(async {
                if let Err(e) = initialize(&app_handle).await {
                    eprintln!("Init error: {}", e);
                }
            });

            // Listen for watch-folder-changed to restart watcher
            let app_handle_2 = app.handle().clone();
            app.listen("watch-folder-changed", move |event| {
                if let Some(path) = event.payload().strip_prefix('"').and_then(|s| s.strip_suffix('"')) {
                    let path = path.to_string();
                    let app_clone = app_handle_2.clone();
                    tokio::spawn(async move {
                        let pool = app_clone.state::<DbState>().0.clone();
                        let _ = watcher::start_watcher(path, Arc::new(pool), app_clone).await;
                    });
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

async fn initialize(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let app_dir = app.path().app_data_dir()?;
    tokio::fs::create_dir_all(&app_dir).await?;

    let db_path = app_dir.join("clips.db");
    let pool = db::init_db(&db_path).await?;
    let pool = Arc::new(pool);

    app.manage(DbState((*pool).clone()));

    // Start watcher if a folder was previously saved
    let watch_folder = sqlx::query_scalar::<_, String>(
        "SELECT value FROM config WHERE key = 'watch_folder'"
    )
    .fetch_optional(&*pool)
    .await
    .ok()
    .flatten();

    if let Some(folder) = watch_folder {
        let pool_clone = pool.clone();
        let app_clone = app.clone();
        tokio::spawn(async move {
            let _ = watcher::start_watcher(folder, pool_clone, app_clone).await;
        });
    }

    // Silent background update check — emits "update-available" if found
    let app_clone = app.clone();
    tokio::spawn(async move {
        // Delay so the window is ready to receive the event
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        if let Ok(updater) = app_clone.updater() {
            if let Ok(Some(update)) = updater.check().await {
                let _ = app_clone.emit("update-available", serde_json::json!({
                    "version": update.version,
                    "notes": update.body,
                    "available": true,
                }));
            }
        }
    });

    Ok(())
}
