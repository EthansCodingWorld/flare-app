use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Clip {
    pub id: String,
    pub filename: String,
    pub path: String,
    pub created_at: String,
    pub added_at: String,
    pub duration: Option<f32>,
    pub size_bytes: Option<i64>,
    pub thumbnail: Option<String>,
    pub tags: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct ClipRow {
    pub id: String,
    pub filename: String,
    pub path: String,
    pub created_at: String,
    pub added_at: String,
    pub duration: Option<f32>,
    pub size_bytes: Option<i64>,
    pub thumbnail: Option<String>,
}

impl ClipRow {
    pub fn into_clip(self, tags: Vec<String>) -> Clip {
        Clip {
            id: self.id,
            filename: self.filename,
            path: self.path,
            created_at: self.created_at,
            added_at: self.added_at,
            duration: self.duration,
            size_bytes: self.size_bytes,
            thumbnail: self.thumbnail,
            tags,
        }
    }
}
