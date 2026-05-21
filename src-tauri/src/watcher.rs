use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher, Config};
use sqlx::SqlitePool;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::AppHandle;
use tokio::sync::mpsc;
use uuid::Uuid;
use chrono::Utc;

const VIDEO_EXTS: &[&str] = &["mp4", "mov", "mkv", "flv", "avi", "webm"];

pub async fn start_watcher(
    watch_path: String,
    pool: Arc<SqlitePool>,
    app: AppHandle,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let (tx, mut rx) = mpsc::channel::<notify::Result<Event>>(100);

    let mut watcher = RecommendedWatcher::new(
        move |res| {
            let _ = tx.blocking_send(res);
        },
        Config::default().with_poll_interval(Duration::from_secs(2)),
    )?;

    watcher.watch(Path::new(&watch_path), RecursiveMode::Recursive)?;

    // Scan existing clips on startup
    scan_existing(&watch_path, &pool, &app).await;

    while let Some(result) = rx.recv().await {
        match result {
            Ok(event) => {
                if matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
                    for path in event.paths {
                        if is_video(&path) {
                            // Small delay — OBS may still be writing the file
                            tokio::time::sleep(Duration::from_secs(2)).await;
                            if let Err(e) = process_clip(&path, &pool, &app).await {
                                eprintln!("Error processing clip {:?}: {}", path, e);
                            }
                        }
                    }
                }
            }
            Err(e) => eprintln!("Watch error: {:?}", e),
        }
    }

    // Keep watcher alive
    drop(watcher);
    Ok(())
}

fn is_video(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| VIDEO_EXTS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

async fn scan_existing(folder: &str, pool: &SqlitePool, app: &AppHandle) {
    let entries = match std::fs::read_dir(folder) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && is_video(&path) {
            let exists = sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM clips WHERE path = ?"
            )
            .bind(path.to_string_lossy().as_ref())
            .fetch_one(pool)
            .await
            .unwrap_or(0);

            if exists == 0 {
                let _ = process_clip(&path, pool, app).await;
            }
        }
    }
}

async fn process_clip(
    path: &PathBuf,
    pool: &SqlitePool,
    app: &AppHandle,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Skip if already in DB
    let exists = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM clips WHERE path = ?")
        .bind(path.to_string_lossy().as_ref())
        .fetch_one(pool)
        .await
        .unwrap_or(0);

    if exists > 0 {
        return Ok(());
    }

    let filename = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let size_bytes = std::fs::metadata(path).ok().map(|m| m.len() as i64);
    let duration = get_duration(path).await;
    let thumbnail = generate_thumbnail(path).await.ok();

    let created_at = get_file_time(path);
    let now = Utc::now().to_rfc3339();
    let id = Uuid::new_v4().to_string();
    let path_str = path.to_string_lossy().to_string();

    sqlx::query!(
        "INSERT OR IGNORE INTO clips (id, filename, path, created_at, added_at, duration, size_bytes, thumbnail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        id, filename, path_str, created_at, now, duration, size_bytes, thumbnail
    )
    .execute(pool)
    .await?;

    let _ = app.emit("clip-detected", serde_json::json!({
        "id": id,
        "filename": filename,
        "path": path_str,
        "duration": duration,
        "thumbnail": thumbnail,
    }));

    Ok(())
}

async fn get_duration(path: &PathBuf) -> Option<f32> {
    let output = tokio::process::Command::new("ffprobe")
        .args([
            "-v", "quiet",
            "-print_format", "json",
            "-show_format",
            path.to_str()?,
        ])
        .output()
        .await
        .ok()?;

    let json: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    json["format"]["duration"]
        .as_str()?
        .parse::<f32>()
        .ok()
}

async fn generate_thumbnail(path: &PathBuf) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let thumb_dir = std::env::temp_dir().join("flare_thumbs");
    tokio::fs::create_dir_all(&thumb_dir).await?;

    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let thumb_path = thumb_dir.join(format!("{}.jpg", stem));

    let status = tokio::process::Command::new("ffmpeg")
        .args([
            "-y",
            "-ss", "00:00:01",
            "-i", path.to_str().ok_or("bad path")?,
            "-vframes", "1",
            "-q:v", "5",
            "-vf", "scale=320:-1",
            thumb_path.to_str().ok_or("bad thumb path")?,
        ])
        .status()
        .await?;

    if status.success() {
        Ok(thumb_path.to_string_lossy().to_string())
    } else {
        Err("ffmpeg thumbnail failed".into())
    }
}

fn get_file_time(path: &PathBuf) -> String {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.created().ok())
        .and_then(|t| {
            t.duration_since(std::time::UNIX_EPOCH).ok().map(|d| {
                chrono::DateTime::from_timestamp(d.as_secs() as i64, 0)
                    .unwrap_or_else(|| Utc::now())
                    .to_rfc3339()
            })
        })
        .unwrap_or_else(|| Utc::now().to_rfc3339())
}
