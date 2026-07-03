// R1 Key 浏览器操作：重命名、复制、key 详情、大集合渐进式删除

use serde::Serialize;
use tauri::{Emitter, State};

use crate::storage::StorageState;
use super::{RedisPool, get_conn, load_config_password, default_db, CAP_COPY, CAP_UNLINK, CAP_MEMORY_USAGE};

/// R1.3 key 详细信息（TYPE / OBJECT ENCODING / MEMORY USAGE / TTL）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyDetail {
    pub key: String,
    pub kind: String,
    pub encoding: String,
    pub ttl: i64,
    pub memory_bytes: i64,
    pub length: i64,
}

#[tauri::command]
pub async fn redis_key_detail(
    id: String,
    key: String,
    db: Option<u8>,
    caps: Option<u64>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
) -> Result<KeyDetail, String> {
    let mut conn = get_conn(&id, db, &pool, &storage).await?;

    let kind: String = redis::cmd("TYPE").arg(&key).query_async(&mut conn).await
        .map_err(|e| format!("TYPE 失败: {e}"))?;
    let ttl: i64 = redis::cmd("TTL").arg(&key).query_async(&mut conn).await.unwrap_or(-1);
    let encoding: String = redis::cmd("OBJECT").arg("ENCODING").arg(&key).query_async(&mut conn)
        .await.unwrap_or_else(|_| "unknown".into());

    // caps=None 时保守默认：不调用 MEMORY USAGE（旧版 Redis 不支持）
    let memory_bytes: i64 = if caps.map_or(false, |c| c & CAP_MEMORY_USAGE != 0) {
        redis::cmd("MEMORY").arg("USAGE").arg(&key).arg("SAMPLES").arg(0)
            .query_async(&mut conn).await.unwrap_or(0)
    } else { 0 };

    let length: i64 = match kind.as_str() {
        "list"  => redis::cmd("LLEN").arg(&key).query_async(&mut conn).await.unwrap_or(0),
        "set"   => redis::cmd("SCARD").arg(&key).query_async(&mut conn).await.unwrap_or(0),
        "zset"  => redis::cmd("ZCARD").arg(&key).query_async(&mut conn).await.unwrap_or(0),
        "hash"  => redis::cmd("HLEN").arg(&key).query_async(&mut conn).await.unwrap_or(0),
        "string"=> redis::cmd("STRLEN").arg(&key).query_async(&mut conn).await.unwrap_or(0),
        "stream"=> redis::cmd("XLEN").arg(&key).query_async(&mut conn).await.unwrap_or(0),
        _ => 0,
    };

    Ok(KeyDetail { key, kind, encoding, ttl, memory_bytes, length })
}

/// R1.3 RENAME（NX 防覆盖）
#[tauri::command]
pub async fn redis_rename_key(
    id: String,
    old_key: String,
    new_key: String,
    nx: bool, // true = RENAMENX（目标已存在时失败）
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
    readonly_state: State<'_, super::server::RedisReadonly>,
) -> Result<bool, String> {
    super::server::require_writable(&id, &readonly_state).await?;
    if new_key.is_empty() { return Err("新 key 名称不能为空".to_string()); }
    if old_key == new_key  { return Ok(true); }
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    if nx {
        let r: i64 = redis::cmd("RENAMENX").arg(&old_key).arg(&new_key)
            .query_async(&mut conn).await
            .map_err(|e| format!("RENAMENX 失败: {e}"))?;
        Ok(r == 1) // 0 表示目标已存在，重命名失败
    } else {
        redis::cmd("RENAME").arg(&old_key).arg(&new_key)
            .query_async::<()>(&mut conn).await
            .map_err(|e| format!("RENAME 失败: {e}"))?;
        Ok(true)
    }
}

/// R1.3 COPY（6.2+ 用 COPY 含跨 DB；旧版降级 DUMP/RESTORE）
#[tauri::command]
pub async fn redis_copy_key(
    id: String,
    src_key: String,
    dst_key: String,
    dst_db: Option<u8>,    // 目标 DB（跨 DB 复制，None = 同 DB）
    replace: bool,          // true = 目标存在时覆盖
    db: Option<u8>,
    caps: Option<u64>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
    readonly_state: State<'_, super::server::RedisReadonly>,
) -> Result<bool, String> {
    super::server::require_writable(&id, &readonly_state).await?;
    let src_db_idx = {
        let (config, _) = load_config_password(&id, &storage)?;
        db.unwrap_or_else(|| default_db(&config))
    };
    let dst_db_idx = dst_db.unwrap_or(src_db_idx);
    let mut conn = get_conn(&id, Some(src_db_idx), &pool, &storage).await?;

    let has_copy = caps.map_or(false, |c| c & CAP_COPY != 0);

    if has_copy {
        let mut cmd = redis::cmd("COPY");
        cmd.arg(&src_key).arg(&dst_key);
        if dst_db_idx != src_db_idx {
            cmd.arg("DB").arg(dst_db_idx);
        }
        if replace { cmd.arg("REPLACE"); }
        let r: i64 = cmd.query_async(&mut conn).await
            .map_err(|e| format!("COPY 失败: {e}"))?;
        Ok(r == 1)
    } else {
        // 降级：DUMP + RESTORE（同 DB）
        if dst_db_idx != src_db_idx {
            return Err("当前 Redis 版本不支持跨 DB 复制，请升级到 6.2+".to_string());
        }
        let dump: Option<Vec<u8>> = redis::cmd("DUMP").arg(&src_key).query_async(&mut conn).await
            .map_err(|e| format!("DUMP 失败: {e}"))?;
        let dump_bytes = dump.ok_or("key 不存在")?;
        let ttl: i64 = redis::cmd("TTL").arg(&src_key).query_async(&mut conn).await.unwrap_or(0);
        let ttl_ms: i64 = if ttl > 0 { ttl * 1000 } else { 0 };
        let mut restore_cmd = redis::cmd("RESTORE");
        restore_cmd.arg(&dst_key).arg(ttl_ms).arg(dump_bytes.as_slice());
        if replace { restore_cmd.arg("REPLACE"); }
        let r: Result<(), redis::RedisError> = restore_cmd.query_async(&mut conn).await;
        match r {
            Ok(_) => Ok(true),
            Err(e) if e.to_string().contains("BUSYKEY") => Ok(false), // 目标已存在
            Err(e) => Err(format!("RESTORE 失败: {e}")),
        }
    }
}

/// R1.3 大集合渐进式删除（超大 hash/set/zset/list 安全删除，不阻塞 Redis 主线程）
/// 每批 100 个元素，全部删完后再 UNLINK/DEL key 本身
#[tauri::command]
pub async fn redis_delete_large(
    id: String,
    key: String,
    db: Option<u8>,
    caps: Option<u64>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
    readonly_state: State<'_, super::server::RedisReadonly>,
    app: tauri::AppHandle,
) -> Result<u64, String> {
    super::server::require_writable(&id, &readonly_state).await?;
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let use_unlink = caps.map_or(true, |c| c & CAP_UNLINK != 0);

    let kind: String = redis::cmd("TYPE").arg(&key).query_async(&mut conn).await
        .map_err(|e| format!("TYPE 失败: {e}"))?;

    let mut total_deleted: u64 = 0;
    const BATCH: usize = 100;
    const MAX_SCAN_ITERS: u32 = 500_000; // 防止超大集合 / 持续写入导致 SCAN 永不收敛

    match kind.as_str() {
        "hash" => {
            let mut cursor: u64 = 0;
            let mut iters: u32 = 0;
            loop {
                if iters >= MAX_SCAN_ITERS {
                    return Err(format!("HSCAN 超过最大迭代次数 {MAX_SCAN_ITERS}，已中止"));
                }
                iters += 1;
                // 读为字节：字段名/值可能是二进制，且要原样传回 HDEL 才能精确匹配删除
                let (next, fields): (u64, Vec<Vec<u8>>) = redis::cmd("HSCAN")
                    .arg(&key).arg(cursor).arg("COUNT").arg(BATCH)
                    .query_async(&mut conn).await
                    .map_err(|e| format!("HSCAN 失败: {e}"))?;
                let field_names: Vec<&[u8]> = fields.iter().enumerate()
                    .filter(|(i, _)| i % 2 == 0).map(|(_, f)| f.as_slice()).collect();
                if !field_names.is_empty() {
                    let mut cmd = redis::cmd("HDEL");
                    cmd.arg(&key);
                    for f in &field_names { cmd.arg(*f); }
                    let n: u64 = cmd.query_async(&mut conn).await.unwrap_or(0);
                    total_deleted += n;
                    let _ = app.emit("redis_del_progress", serde_json::json!({ "id": &id, "key": &key, "deleted": total_deleted }));
                }
                cursor = next;
                if cursor == 0 { break; }
            }
        }
        "set" => {
            let mut cursor: u64 = 0;
            let mut iters: u32 = 0;
            loop {
                if iters >= MAX_SCAN_ITERS {
                    return Err(format!("SSCAN 超过最大迭代次数 {MAX_SCAN_ITERS}，已中止"));
                }
                iters += 1;
                let (next, members): (u64, Vec<Vec<u8>>) = redis::cmd("SSCAN")
                    .arg(&key).arg(cursor).arg("COUNT").arg(BATCH)
                    .query_async(&mut conn).await
                    .map_err(|e| format!("SSCAN 失败: {e}"))?;
                if !members.is_empty() {
                    let mut cmd = redis::cmd("SREM");
                    cmd.arg(&key);
                    for m in &members { cmd.arg(m.as_slice()); }
                    let n: u64 = cmd.query_async(&mut conn).await.unwrap_or(0);
                    total_deleted += n;
                    let _ = app.emit("redis_del_progress", serde_json::json!({ "id": &id, "key": &key, "deleted": total_deleted }));
                }
                cursor = next;
                if cursor == 0 { break; }
            }
        }
        "zset" => {
            loop {
                let removed: u64 = redis::cmd("ZREMRANGEBYRANK")
                    .arg(&key).arg(0).arg(BATCH as i64 - 1)
                    .query_async(&mut conn).await.unwrap_or(0);
                total_deleted += removed;
                let _ = app.emit("redis_del_progress", serde_json::json!({ "id": &id, "key": &key, "deleted": total_deleted }));
                if removed == 0 { break; }
            }
        }
        "list" => {
            loop {
                let items: Vec<Vec<u8>> = redis::cmd("LRANGE")
                    .arg(&key).arg(0).arg(BATCH as i64 - 1)
                    .query_async(&mut conn).await.unwrap_or_default();
                if items.is_empty() { break; }
                redis::cmd("LTRIM").arg(&key).arg(BATCH as i64).arg(-1)
                    .query_async::<()>(&mut conn).await.ok();
                total_deleted += items.len() as u64;
                let _ = app.emit("redis_del_progress", serde_json::json!({ "id": &id, "key": &key, "deleted": total_deleted }));
                let remaining: i64 = redis::cmd("LLEN").arg(&key).query_async(&mut conn).await.unwrap_or(0);
                if remaining == 0 { break; }
            }
        }
        _ => {} // string / stream：直接 UNLINK/DEL 无需渐进
    }

    // 最后删 key 本身
    if use_unlink {
        redis::cmd("UNLINK").arg(&key).query_async::<()>(&mut conn).await.ok();
    } else {
        redis::cmd("DEL").arg(&key).query_async::<()>(&mut conn).await.ok();
    }

    Ok(total_deleted)
}
