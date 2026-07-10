// R6 数据导入导出 / 跨实例复制
// 隔离规则：独立文件，不引用 SQL 侧代码

use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};

use crate::storage::StorageState;
use super::{RedisPool, get_conn, load_config_password, default_db, open_fresh_conn, bytes_to_text};

// ── R6.1 按 pattern 导出 key 为 JSON ─────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedKey {
    pub key: String,
    pub kind: String,
    pub ttl: i64,
    pub value: serde_json::Value,
}

/// R6.1: 导出匹配 pattern 的 key 到 JSON 文件
/// 以 tauri event 'redis_export_progress' 汇报进度
#[tauri::command]
pub async fn redis_export_keys(
    id: String,
    pattern: String,
    db: Option<u8>,
    path: String,
    task_id: Option<String>,
    app: tauri::AppHandle,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
) -> Result<u64, String> {
    if path.is_empty() { return Err("导出路径不能为空".to_string()); }
    // 路径安全校验：必须绝对路径，禁止隐藏目录
    {
        let p = std::path::Path::new(&path);
        if !p.is_absolute() { return Err("导出路径必须是绝对路径".to_string()); }
        if p.components().any(|c| matches!(c, std::path::Component::Normal(s) if s.to_string_lossy().starts_with('.'))) {
            return Err("导出路径不允许包含隐藏目录".to_string());
        }
    }
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let pat = if pattern.is_empty() { "*".to_string() } else { pattern };

    let mut exported = vec![];
    let mut cursor: u64 = 0;
    let mut count = 0u64;

    loop {
        let (next, keys): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor).arg("MATCH").arg(&pat).arg("COUNT").arg(200)
            .query_async(&mut conn).await
            .map_err(|e| format!("SCAN 失败: {e}"))?;

        for key in &keys {
            let kind: String = redis::cmd("TYPE").arg(key).query_async(&mut conn).await
                .unwrap_or_else(|_| "unknown".into());
            let ttl: i64 = redis::cmd("TTL").arg(key).query_async(&mut conn).await.unwrap_or(-1);
            let value = read_key_value(&mut conn, key, &kind).await;
            exported.push(ExportedKey { key: key.clone(), kind, ttl, value });
            count += 1;
        }
        cursor = next;
        let payload = serde_json::json!({ "count": count });
        let _ = app.emit("redis_export_progress", payload.clone());
        if let Some(ref task_id) = task_id {
            let event = format!("redis_export_progress_{task_id}");
            let _ = app.emit(&event, payload);
        }
        if cursor == 0 { break; }
    }

    let json = serde_json::to_string_pretty(&exported)
        .map_err(|e| format!("序列化失败: {e}"))?;
    std::fs::write(&path, &json)
        .map_err(|e| format!("写文件失败: {e}"))?;

    Ok(count)
}

async fn read_key_value(conn: &mut redis::aio::MultiplexedConnection, key: &str, kind: &str) -> serde_json::Value {
    use serde_json::json;
    match kind {
        "string" => {
            // 读为字节再 lossy：二进制值否则会被 unwrap_or 静默丢成空串
            let v: Option<Vec<u8>> = redis::cmd("GET").arg(key).query_async(conn).await.unwrap_or(None);
            json!(v.map(|b| bytes_to_text(&b)).unwrap_or_default())
        }
        "list" => {
            // LRANGE 限制 10,000 元素，防止超大 List OOM
            const LIST_LIMIT: i64 = 10_000;
            let raw: Vec<Vec<u8>> = redis::cmd("LRANGE").arg(key).arg(0).arg(LIST_LIMIT - 1)
                .query_async(conn).await.unwrap_or_default();
            let truncated = raw.len() as i64 >= LIST_LIMIT;
            let v: Vec<String> = raw.iter().map(|b| bytes_to_text(b)).collect();
            if truncated { json!({ "values": v, "truncated": true }) } else { json!(v) }
        }
        "set" => {
            const SET_LIMIT: usize = 10_000;
            let mut all = vec![];
            let mut cur: u64 = 0;
            loop {
                let (next, batch): (u64, Vec<Vec<u8>>) = redis::cmd("SSCAN")
                    .arg(key).arg(cur).arg("COUNT").arg(200)
                    .query_async(conn).await.unwrap_or((0, vec![]));
                all.extend(batch.iter().map(|b| bytes_to_text(b)));
                cur = next;
                if cur == 0 || all.len() >= SET_LIMIT { break; }
            }
            let truncated = all.len() >= SET_LIMIT;
            if truncated { json!({ "values": all, "truncated": true }) } else { json!(all) }
        }
        "zset" => {
            const ZSET_LIMIT: isize = 10_000;
            let raw: Vec<(Vec<u8>, f64)> = redis::cmd("ZRANGE").arg(key).arg(0).arg(ZSET_LIMIT - 1).arg("WITHSCORES")
                .query_async(conn).await.unwrap_or_default();
            let truncated = raw.len() as isize >= ZSET_LIMIT;
            let arr: Vec<_> = raw.into_iter().map(|(m, s)| json!({ "member": bytes_to_text(&m), "score": s })).collect();
            if truncated { json!({ "values": arr, "truncated": true }) } else { json!(arr) }
        }
        "hash" => {
            const HASH_LIMIT: usize = 10_000;
            let mut map = serde_json::Map::new();
            let mut cur: u64 = 0;
            loop {
                let (next, flat): (u64, Vec<Vec<u8>>) = redis::cmd("HSCAN")
                    .arg(key).arg(cur).arg("COUNT").arg(200)
                    .query_async(conn).await.unwrap_or((0, vec![]));
                for pair in flat.chunks(2) {
                    if let [f, v] = pair { map.insert(bytes_to_text(f), serde_json::Value::String(bytes_to_text(v))); }
                }
                cur = next;
                if cur == 0 || map.len() >= HASH_LIMIT { break; }
            }
            serde_json::Value::Object(map)
        }
        _ => serde_json::Value::Null,
    }
}

// ── R6.2 JSON 导入 ────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportKey {
    pub key: String,
    pub kind: String,
    pub ttl: i64,
    pub value: serde_json::Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub imported: u64,
    pub skipped: u64,
    pub errors: Vec<String>,
}

/// R6.2: 从 JSON 文件导入 key（支持跳过/覆盖冲突策略）
#[tauri::command]
pub async fn redis_import_keys(
    id: String,
    db: Option<u8>,
    path: String,
    overwrite: bool, // false = 跳过已存在的 key（NX 防覆盖）
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
    readonly_state: State<'_, super::server::RedisReadonly>,
) -> Result<ImportResult, String> {
    super::server::require_writable(&id, &readonly_state).await?;
    if path.is_empty() { return Err("导入路径不能为空".to_string()); }
    // 路径安全校验：必须绝对路径，禁止隐藏目录
    {
        let p = std::path::Path::new(&path);
        if !p.is_absolute() { return Err("导入路径必须是绝对路径".to_string()); }
        if p.components().any(|c| matches!(c, std::path::Component::Normal(s) if s.to_string_lossy().starts_with('.'))) {
            return Err("导入路径不允许包含隐藏目录".to_string());
        }
    }
    let json = std::fs::read_to_string(&path)
        .map_err(|e| format!("读文件失败: {e}"))?;
    let keys: Vec<ImportKey> = serde_json::from_str(&json)
        .map_err(|e| format!("JSON 解析失败: {e}"))?;

    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let mut imported = 0u64;
    let mut skipped = 0u64;
    let mut errors = vec![];

    for item in &keys {
        if item.key.is_empty() { continue; }

        if !overwrite {
            let exists: i64 = redis::cmd("EXISTS").arg(&item.key).query_async(&mut conn).await.unwrap_or(0);
            if exists > 0 { skipped += 1; continue; }
        }

        let result = write_key_value(&mut conn, &item.key, &item.kind, &item.value).await;
        match result {
            Ok(_) => {
                if item.ttl > 0 {
                    redis::cmd("EXPIRE").arg(&item.key).arg(item.ttl)
                        .query_async::<()>(&mut conn).await.ok();
                }
                imported += 1;
            }
            Err(e) => errors.push(format!("{}: {e}", item.key)),
        }
    }

    Ok(ImportResult { imported, skipped, errors })
}

async fn write_key_value(
    conn: &mut redis::aio::MultiplexedConnection,
    key: &str,
    kind: &str,
    value: &serde_json::Value,
) -> Result<(), String> {
    match kind {
        "string" => {
            let v = value.as_str().map(|s| s.to_string())
                .unwrap_or_else(|| value.to_string());
            redis::cmd("SET").arg(key).arg(&v).query_async::<()>(conn).await
                .map_err(|e| format!("SET 失败: {e}"))
        }
        "list" => {
            if let Some(arr) = value.as_array() {
                if arr.is_empty() { return Ok(()); }
                let mut cmd = redis::cmd("RPUSH");
                cmd.arg(key);
                for v in arr { cmd.arg(v.as_str().unwrap_or(&v.to_string())); }
                cmd.query_async::<()>(conn).await.map_err(|e| format!("RPUSH 失败: {e}"))
            } else { Ok(()) }
        }
        "set" => {
            if let Some(arr) = value.as_array() {
                if arr.is_empty() { return Ok(()); }
                let mut cmd = redis::cmd("SADD");
                cmd.arg(key);
                for v in arr { cmd.arg(v.as_str().unwrap_or(&v.to_string())); }
                cmd.query_async::<()>(conn).await.map_err(|e| format!("SADD 失败: {e}"))
            } else { Ok(()) }
        }
        "zset" => {
            if let Some(arr) = value.as_array() {
                if arr.is_empty() { return Ok(()); }
                let mut cmd = redis::cmd("ZADD");
                cmd.arg(key);
                for v in arr {
                    let member = v.get("member").and_then(|m| m.as_str()).unwrap_or("");
                    let score = v.get("score").and_then(|s| s.as_f64()).unwrap_or(0.0);
                    cmd.arg(score).arg(member);
                }
                cmd.query_async::<()>(conn).await.map_err(|e| format!("ZADD 失败: {e}"))
            } else { Ok(()) }
        }
        "hash" => {
            if let Some(obj) = value.as_object() {
                if obj.is_empty() { return Ok(()); }
                let mut cmd = redis::cmd("HSET");
                cmd.arg(key);
                for (f, v) in obj { cmd.arg(f).arg(v.as_str().unwrap_or(&v.to_string())); }
                cmd.query_async::<()>(conn).await.map_err(|e| format!("HSET 失败: {e}"))
            } else { Ok(()) }
        }
        _ => Err(format!("不支持导入类型: {kind}")),
    }
}

// ── R6.3 跨连接复制 ───────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrossCopyResult {
    pub copied: u64,
    pub skipped: u64,
    pub errors: Vec<String>,
}

/// R6.3: 把 src 实例的 key 复制到 dst 实例（DUMP/RESTORE 方案，强确认由前端保证）
#[tauri::command]
pub async fn redis_cross_copy(
    src_id: String,
    dst_id: String,
    keys: Vec<String>,     // 要复制的 key 列表（前端已预览并确认）
    src_db: Option<u8>,
    dst_db: Option<u8>,
    overwrite: bool,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
    readonly_state: State<'_, super::server::RedisReadonly>,
) -> Result<CrossCopyResult, String> {
    // 跨实例复制写入的是目标连接，按 dst_id 校验只读
    super::server::require_writable(&dst_id, &readonly_state).await?;
    if keys.is_empty() { return Ok(CrossCopyResult { copied: 0, skipped: 0, errors: vec![] }); }
    if src_id == dst_id && src_db == dst_db {
        return Err("源和目标相同，请选择不同的连接或 DB".to_string());
    }

    let mut src_conn = get_conn(&src_id, src_db, &pool, &storage).await?;

    let (dst_config, dst_pass) = load_config_password(&dst_id, &storage)?;
    let dst_db_idx = dst_db.unwrap_or_else(|| default_db(&dst_config));
    let dst_entry = open_fresh_conn(&dst_config, dst_pass.as_deref(), dst_db_idx).await?;
    let mut dst_conn = dst_entry.conn;

    let mut copied = 0u64;
    let mut skipped = 0u64;
    let mut errors = vec![];

    for key in &keys {
        // 检查目标是否已存在
        if !overwrite {
            let exists: i64 = redis::cmd("EXISTS").arg(key).query_async(&mut dst_conn).await.unwrap_or(0);
            if exists > 0 { skipped += 1; continue; }
        }

        // DUMP from source
        let dump: Option<Vec<u8>> = match redis::cmd("DUMP").arg(key).query_async(&mut src_conn).await {
            Ok(v) => v,
            Err(e) => { errors.push(format!("{key}: DUMP 失败 {e}")); continue; }
        };
        let dump_bytes = match dump {
            Some(b) => b,
            None => { errors.push(format!("{key}: key 不存在")); continue; }
        };

        let ttl: i64 = redis::cmd("TTL").arg(key).query_async(&mut src_conn).await.unwrap_or(0);
        let ttl_ms: i64 = if ttl > 0 { ttl * 1000 } else { 0 };

        // RESTORE to destination
        let mut restore_cmd = redis::cmd("RESTORE");
        restore_cmd.arg(key).arg(ttl_ms).arg(dump_bytes.as_slice());
        if overwrite { restore_cmd.arg("REPLACE"); }

        match restore_cmd.query_async::<()>(&mut dst_conn).await {
            Ok(_) => copied += 1,
            Err(e) if e.to_string().contains("BUSYKEY") => { skipped += 1; }
            Err(e) => errors.push(format!("{key}: RESTORE 失败 {e}")),
        }
    }

    Ok(CrossCopyResult { copied, skipped, errors })
}

// ── R6.4 批量操作预览 ─────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchPreview {
    pub count: u64,
    pub samples: Vec<String>,
}

/// R6.4: 预览 pattern 匹配的 key（不执行删除）
#[tauri::command]
pub async fn redis_batch_preview(
    id: String,
    pattern: String,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
) -> Result<BatchPreview, String> {
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let pat = if pattern.is_empty() { "*".to_string() } else { pattern };
    let mut count = 0u64;
    let mut samples = vec![];
    let mut cursor: u64 = 0;

    loop {
        let (next, keys): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor).arg("MATCH").arg(&pat).arg("COUNT").arg(200)
            .query_async(&mut conn).await
            .map_err(|e| format!("SCAN 失败: {e}"))?;
        count += keys.len() as u64;
        if samples.len() < 10 { samples.extend(keys.into_iter().take(10 - samples.len())); }
        cursor = next;
        if cursor == 0 { break; }
    }

    Ok(BatchPreview { count, samples })
}
