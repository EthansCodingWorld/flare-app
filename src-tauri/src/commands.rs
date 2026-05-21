use sqlx::SqlitePool;
use tauri::{Emitter, State};
use uuid::Uuid;
use chrono::Utc;

use crate::models::{Clip, ClipRow};

pub struct DbState(pub SqlitePool);

async fn get_tags(pool: &SqlitePool, clip_id: &str) -> Vec<String> {
    sqlx::query_scalar::<_, String>("SELECT tag FROM tags WHERE clip_id = ? ORDER BY tag")
        .bind(clip_id)
        .fetch_all(pool)
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub async fn get_clips(
    db: State<'_, DbState>,
    limit: i64,
    offset: i64,
    search: Option<String>,
    sort: Option<String>,
) -> Result<Vec<Clip>, String> {
    let pool = &db.0;

    let order = match sort.as_deref() {
        Some("oldest") => "created_at ASC",
        Some("duration") => "duration DESC NULLS LAST",
        _ => "created_at DESC",
    };

    let rows = if let Some(q) = &search {
        let pattern = format!("%{}%", q);
        sqlx::query_as!(
            ClipRow,
            r#"SELECT id, filename, path, created_at, added_at, duration, size_bytes, thumbnail
               FROM clips WHERE filename LIKE ?
               ORDER BY created_at DESC LIMIT ? OFFSET ?"#,
            pattern, limit, offset
        )
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?
    } else {
        sqlx::query_as!(
            ClipRow,
            r#"SELECT id, filename, path, created_at, added_at, duration, size_bytes, thumbnail
               FROM clips ORDER BY created_at DESC LIMIT ? OFFSET ?"#,
            limit, offset
        )
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?
    };

    let mut clips = Vec::with_capacity(rows.len());
    for row in rows {
        let tags = get_tags(pool, &row.id).await;
        clips.push(row.into_clip(tags));
    }

    Ok(clips)
}

#[tauri::command]
pub async fn get_clip(db: State<'_, DbState>, id: String) -> Result<Clip, String> {
    let pool = &db.0;

    let row = sqlx::query_as!(
        ClipRow,
        "SELECT id, filename, path, created_at, added_at, duration, size_bytes, thumbnail
         FROM clips WHERE id = ?",
        id
    )
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "Clip not found".to_string())?;

    let tags = get_tags(pool, &row.id).await;
    Ok(row.into_clip(tags))
}

#[tauri::command]
pub async fn get_clips_count(db: State<'_, DbState>) -> Result<i64, String> {
    let pool = &db.0;
    let count = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM clips")
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(count)
}

#[tauri::command]
pub async fn add_tags(
    db: State<'_, DbState>,
    clip_id: String,
    tags: Vec<String>,
) -> Result<(), String> {
    let pool = &db.0;
    for tag in &tags {
        let tag_id = Uuid::new_v4().to_string();
        sqlx::query!(
            "INSERT OR IGNORE INTO tags (id, clip_id, tag) VALUES (?, ?, ?)",
            tag_id, clip_id, tag
        )
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn remove_tag(
    db: State<'_, DbState>,
    clip_id: String,
    tag: String,
) -> Result<(), String> {
    let pool = &db.0;
    sqlx::query!("DELETE FROM tags WHERE clip_id = ? AND tag = ?", clip_id, tag)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn set_watch_folder(
    db: State<'_, DbState>,
    app: tauri::AppHandle,
    folder_path: String,
) -> Result<(), String> {
    let pool = &db.0;

    sqlx::query!(
        "INSERT OR REPLACE INTO config (key, value) VALUES ('watch_folder', ?)",
        folder_path
    )
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;

    app.emit("watch-folder-changed", &folder_path)
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn get_watch_folder(db: State<'_, DbState>) -> Result<Option<String>, String> {
    let pool = &db.0;
    let val = sqlx::query_scalar::<_, String>(
        "SELECT value FROM config WHERE key = 'watch_folder'"
    )
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(val)
}

#[tauri::command]
pub async fn set_discord_config(
    db: State<'_, DbState>,
    bot_url: String,
    channel_id: String,
    secret: Option<String>,
) -> Result<(), String> {
    let pool = &db.0;
    let secret_val = secret.unwrap_or_default();
    for (key, val) in [
        ("discord_bot_url", &bot_url),
        ("discord_channel_id", &channel_id),
        ("discord_secret", &secret_val),
    ] {
        sqlx::query!(
            "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)",
            key, val
        )
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn share_clip_to_discord(
    db: State<'_, DbState>,
    clip_id: String,
    message: Option<String>,
) -> Result<(), String> {
    let pool = &db.0;

    let clip = sqlx::query_as!(
        ClipRow,
        "SELECT id, filename, path, created_at, added_at, duration, size_bytes, thumbnail
         FROM clips WHERE id = ?",
        clip_id
    )
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "Clip not found".to_string())?;

    let bot_url = sqlx::query_scalar::<_, String>(
        "SELECT value FROM config WHERE key = 'discord_bot_url'"
    )
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "Discord bot URL not configured".to_string())?;

    let channel_id = sqlx::query_scalar::<_, String>(
        "SELECT value FROM config WHERE key = 'discord_channel_id'"
    )
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "Discord channel not configured".to_string())?;

    let secret = sqlx::query_scalar::<_, String>(
        "SELECT value FROM config WHERE key = 'discord_secret'"
    )
    .fetch_optional(pool)
    .await
    .unwrap_or_default()
    .unwrap_or_default();

    let tags = get_tags(pool, &clip.id).await;

    let payload = serde_json::json!({
        "clip_id": clip.id,
        "filename": clip.filename,
        "path": clip.path,
        "duration": clip.duration,
        "size_bytes": clip.size_bytes,
        "tags": tags,
        "channel_id": channel_id,
        "message": message,
    });

    let mut req = reqwest::Client::new()
        .post(format!("{}/clips/share", bot_url))
        .json(&payload);

    if !secret.is_empty() {
        req = req.header("X-Bridge-Secret", &secret);
    }

    req.send()
        .await
        .map_err(|e| format!("Failed to reach Discord bot: {}", e))?
        .error_for_status()
        .map_err(|e| format!("Discord bot error: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn delete_clip(db: State<'_, DbState>, clip_id: String) -> Result<(), String> {
    let pool = &db.0;
    sqlx::query!("DELETE FROM clips WHERE id = ?", clip_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}
