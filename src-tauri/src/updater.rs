use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

#[derive(Clone, Serialize, Deserialize)]
pub struct UpdateInfo {
    pub version: String,
    pub notes: Option<String>,
    pub available: bool,
}

#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<UpdateInfo, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;

    match updater.check().await {
        Ok(Some(update)) => {
            let info = UpdateInfo {
                version: update.version.clone(),
                notes: update.body.clone(),
                available: true,
            };
            // Emit so the UI can react even if the command caller ignores the return
            let _ = app.emit("update-available", &info);
            Ok(info)
        }
        Ok(None) => Ok(UpdateInfo {
            version: app.package_info().version.to_string(),
            notes: None,
            available: false,
        }),
        Err(e) => Err(format!("Update check failed: {}", e)),
    }
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;

    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No update available".to_string())?;

    let app_clone = app.clone();
    let total_bytes = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let downloaded = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));

    let total_clone = total_bytes.clone();
    let downloaded_clone = downloaded.clone();

    update
        .download_and_install(
            move |chunk, total| {
                if let Some(t) = total {
                    total_clone.store(t, std::sync::atomic::Ordering::Relaxed);
                }
                let dl = downloaded_clone.fetch_add(chunk as u64, std::sync::atomic::Ordering::Relaxed) + chunk as u64;
                let total = total_clone.load(std::sync::atomic::Ordering::Relaxed);
                let pct = if total > 0 { (dl * 100 / total) as u8 } else { 0 };
                let _ = app_clone.emit("update-progress", serde_json::json!({ "percent": pct }));
            },
            move || {
                // Called when install is about to start — app will restart
            },
        )
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn get_app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}
