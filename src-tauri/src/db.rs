use sqlx::{sqlite::SqlitePoolOptions, SqlitePool};
use std::path::Path;

pub async fn init_db(db_path: &Path) -> Result<SqlitePool, sqlx::Error> {
    let db_url = format!("sqlite://{}?mode=rwc", db_path.display());

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect(&db_url)
        .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS clips (
            id          TEXT PRIMARY KEY,
            filename    TEXT NOT NULL,
            path        TEXT NOT NULL UNIQUE,
            created_at  TEXT NOT NULL,
            added_at    TEXT NOT NULL,
            duration    REAL,
            size_bytes  INTEGER,
            thumbnail   TEXT
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS tags (
            id       TEXT PRIMARY KEY,
            clip_id  TEXT NOT NULL,
            tag      TEXT NOT NULL,
            FOREIGN KEY (clip_id) REFERENCES clips(id) ON DELETE CASCADE,
            UNIQUE(clip_id, tag)
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS config (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_clips_created ON clips(created_at DESC)",
    )
    .execute(&pool)
    .await?;

    Ok(pool)
}
