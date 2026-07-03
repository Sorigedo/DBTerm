// MO2: GridFS 大文件管理（浏览 / 上传 / 下载 / 删除）
use bson::{doc, oid::ObjectId, Bson};
use futures::{AsyncWriteExt, AsyncReadExt, TryStreamExt};
use serde::Serialize;
use tauri::State;

use super::{MongoPool, load_conn, get_client};
use crate::storage::StorageState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridFsFile {
    pub id: String,
    pub filename: String,
    pub length: i64,
    pub chunk_size: i64,
    pub upload_date: String,
}

/// 解析文件 id（ObjectId 字符串）为 Bson
fn parse_id(s: &str) -> Result<Bson, String> {
    ObjectId::parse_str(s)
        .map(Bson::ObjectId)
        .map_err(|_| format!("非法的文件 ID: {s}"))
}

/// MO2: 列出 GridFS 文件（默认 bucket "fs"）
#[tauri::command]
pub async fn mongo_gridfs_list(
    id: String,
    db: String,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<Vec<GridFsFile>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;
    let bucket = client.database(&db).gridfs_bucket(None);

    let mut cursor = bucket.find(doc! {}).await.map_err(|e| format!("列出 GridFS 文件失败: {e}"))?;
    let mut files = Vec::new();
    while let Some(f) = cursor.try_next().await.map_err(|e| format!("读取文件元数据失败: {e}"))? {
        files.push(GridFsFile {
            id: match &f.id { Bson::ObjectId(o) => o.to_hex(), other => other.to_string() },
            filename: f.filename.unwrap_or_default(),
            length: f.length as i64,
            chunk_size: f.chunk_size_bytes as i64,
            upload_date: f.upload_date.try_to_rfc3339_string().unwrap_or_default(),
        });
    }
    Ok(files)
}

/// MO2: 上传本地文件到 GridFS，返回文件 ID
#[tauri::command]
pub async fn mongo_gridfs_upload(
    id: String,
    db: String,
    local_path: String,
    filename: String,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<String, String> {
    let (config, password) = load_conn(&id, &storage)?;
    if config.read_only == Some(true) { return Err("当前连接为只读模式，写操作已被禁止".to_string()); }
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;
    let bucket = client.database(&db).gridfs_bucket(None);

    let bytes = std::fs::read(&local_path).map_err(|e| format!("读取本地文件失败: {e}"))?;
    let name = if filename.trim().is_empty() {
        std::path::Path::new(&local_path).file_name()
            .map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "upload.bin".to_string())
    } else { filename };
    if name.len() > 255 {
        return Err(format!("文件名过长（最多 255 字符，当前 {} 字符）", name.len()));
    }
    if name.chars().any(|c| c == '\0' || c == '/' || c == '\\') {
        return Err("文件名包含非法字符（不允许 NUL、/ 或 \\）".to_string());
    }

    let mut stream = bucket.open_upload_stream(&name).await
        .map_err(|e| format!("打开上传流失败: {e}"))?;
    stream.write_all(&bytes).await.map_err(|e| format!("写入失败: {e}"))?;
    stream.close().await.map_err(|e| format!("关闭上传流失败: {e}"))?;

    let fid = match stream.id() { Bson::ObjectId(o) => o.to_hex(), other => other.to_string() };
    Ok(fid)
}

/// MO2: 从 GridFS 下载文件到本地路径
#[tauri::command]
pub async fn mongo_gridfs_download(
    id: String,
    db: String,
    file_id: String,
    dest_path: String,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<u64, String> {
    // 路径安全校验：复用统一的 validate_path（绝对路径、禁 ..、禁隐藏、禁 NUL/设备命名空间）
    super::super::db_extra::validate_path(&dest_path)?;
    let (config, password) = load_conn(&id, &storage)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;
    let bucket = client.database(&db).gridfs_bucket(None);
    let fid = parse_id(&file_id)?;

    let mut stream = bucket.open_download_stream(fid).await
        .map_err(|e| format!("打开下载流失败: {e}"))?;
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).await.map_err(|e| format!("读取失败: {e}"))?;
    std::fs::write(&dest_path, &buf).map_err(|e| format!("写入本地文件失败: {e}"))?;
    Ok(buf.len() as u64)
}

/// MO2: 删除 GridFS 文件（强确认由前端保证）
#[tauri::command]
pub async fn mongo_gridfs_delete(
    id: String,
    db: String,
    file_id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<(), String> {
    let (config, password) = load_conn(&id, &storage)?;
    if config.read_only == Some(true) { return Err("当前连接为只读模式，写操作已被禁止".to_string()); }
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;
    let bucket = client.database(&db).gridfs_bucket(None);
    let fid = parse_id(&file_id)?;
    bucket.delete(fid).await.map_err(|e| format!("删除文件失败: {e}"))?;
    Ok(())
}
