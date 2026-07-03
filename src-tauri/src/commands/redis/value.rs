// R2 全类型值编辑器后端命令
// 覆盖：hash / list / set / zset / stream 的分页读取 + 写操作

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::storage::StorageState;
use super::{RedisPool, get_conn, bytes_to_text, bytes_to_display};

// ── Hash (R2.2) ────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HashScanResult {
    pub fields: Vec<HashField>,
    pub cursor: u64,
    pub has_more: bool,
    pub total: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HashField {
    pub field: String,
    pub value: String,
    /// 值为非 UTF-8 二进制时为 true，value 此时是十六进制预览
    #[serde(default)]
    pub binary: bool,
}

#[tauri::command]
pub async fn redis_hash_scan(
    id: String,
    key: String,
    cursor: u64,
    search: Option<String>,
    count: Option<usize>,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
) -> Result<HashScanResult, String> {
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let cnt = count.unwrap_or(100).clamp(10, 500);
    let pat = search.filter(|s| !s.is_empty()).unwrap_or_else(|| "*".to_string());

    // 读为字节：hash 的字段值可能是二进制（pickle/protobuf 等），用 String 会整条失败
    let (next, flat): (u64, Vec<Vec<u8>>) = redis::cmd("HSCAN")
        .arg(&key).arg(cursor).arg("MATCH").arg(&pat).arg("COUNT").arg(cnt)
        .query_async(&mut conn).await
        .map_err(|e| format!("HSCAN 失败: {e}"))?;

    let total: usize = redis::cmd("HLEN").arg(&key).query_async(&mut conn).await.unwrap_or(0);

    let mut fields = Vec::new();
    for pair in flat.chunks(2) {
        if let [f, v] = pair {
            let (value, binary) = bytes_to_display(v);
            fields.push(HashField { field: bytes_to_text(f), value, binary });
        }
    }

    Ok(HashScanResult { fields, cursor: next, has_more: next != 0, total })
}

#[tauri::command]
pub async fn redis_hash_set(
    id: String,
    key: String,
    field: String,
    value: String,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
    readonly_state: State<'_, super::server::RedisReadonly>,
) -> Result<(), String> {
    super::server::require_writable(&id, &readonly_state).await?;
    if field.is_empty() { return Err("字段名不能为空".to_string()); }
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    redis::cmd("HSET").arg(&key).arg(&field).arg(&value)
        .query_async::<()>(&mut conn).await
        .map_err(|e| format!("HSET 失败: {e}"))
}

#[tauri::command]
pub async fn redis_hash_del(
    id: String,
    key: String,
    fields: Vec<String>,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
    readonly_state: State<'_, super::server::RedisReadonly>,
) -> Result<u64, String> {
    super::server::require_writable(&id, &readonly_state).await?;
    if fields.is_empty() { return Ok(0); }
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let mut cmd = redis::cmd("HDEL");
    cmd.arg(&key);
    for f in &fields { cmd.arg(f); }
    cmd.query_async::<u64>(&mut conn).await.map_err(|e| format!("HDEL 失败: {e}"))
}

// ── List (R2.3) ────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListPage {
    pub items: Vec<String>,
    pub total: i64,
    pub offset: i64,
}

#[tauri::command]
pub async fn redis_list_range(
    id: String,
    key: String,
    offset: i64,
    count: i64,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
) -> Result<ListPage, String> {
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let total: i64 = redis::cmd("LLEN").arg(&key).query_async(&mut conn).await.unwrap_or(0);
    let end = (offset + count - 1).min(total - 1);
    let items: Vec<String> = if total > 0 {
        let raw: Vec<Vec<u8>> = redis::cmd("LRANGE").arg(&key).arg(offset).arg(end)
            .query_async(&mut conn).await.map_err(|e| format!("LRANGE 失败: {e}"))?;
        raw.iter().map(|b| bytes_to_text(b)).collect()
    } else { vec![] };
    Ok(ListPage { items, total, offset })
}

#[tauri::command]
pub async fn redis_list_push(
    id: String,
    key: String,
    value: String,
    head: bool, // true = LPUSH, false = RPUSH
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
    readonly_state: State<'_, super::server::RedisReadonly>,
) -> Result<i64, String> {
    super::server::require_writable(&id, &readonly_state).await?;
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let cmd_name = if head { "LPUSH" } else { "RPUSH" };
    redis::cmd(cmd_name).arg(&key).arg(&value)
        .query_async::<i64>(&mut conn).await
        .map_err(|e| format!("{cmd_name} 失败: {e}"))
}

#[tauri::command]
pub async fn redis_list_set(
    id: String,
    key: String,
    index: i64,
    value: String,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
    readonly_state: State<'_, super::server::RedisReadonly>,
) -> Result<(), String> {
    super::server::require_writable(&id, &readonly_state).await?;
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    redis::cmd("LSET").arg(&key).arg(index).arg(&value)
        .query_async::<()>(&mut conn).await
        .map_err(|e| format!("LSET 失败: {e}"))
}

#[tauri::command]
pub async fn redis_list_remove(
    id: String,
    key: String,
    value: String,
    count: i64, // 0 = 全部，>0 从头，<0 从尾
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
    readonly_state: State<'_, super::server::RedisReadonly>,
) -> Result<i64, String> {
    super::server::require_writable(&id, &readonly_state).await?;
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    redis::cmd("LREM").arg(&key).arg(count).arg(&value)
        .query_async::<i64>(&mut conn).await
        .map_err(|e| format!("LREM 失败: {e}"))
}

// ── Set (R2.4) ─────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetScanResult {
    pub members: Vec<String>,
    pub cursor: u64,
    pub has_more: bool,
    pub total: usize,
}

#[tauri::command]
pub async fn redis_set_scan(
    id: String,
    key: String,
    cursor: u64,
    search: Option<String>,
    count: Option<usize>,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
) -> Result<SetScanResult, String> {
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let cnt = count.unwrap_or(100).clamp(10, 500);
    let pat = search.filter(|s| !s.is_empty()).unwrap_or_else(|| "*".to_string());

    let (next, raw): (u64, Vec<Vec<u8>>) = redis::cmd("SSCAN")
        .arg(&key).arg(cursor).arg("MATCH").arg(&pat).arg("COUNT").arg(cnt)
        .query_async(&mut conn).await
        .map_err(|e| format!("SSCAN 失败: {e}"))?;
    let members: Vec<String> = raw.iter().map(|b| bytes_to_text(b)).collect();

    let total: usize = redis::cmd("SCARD").arg(&key).query_async(&mut conn).await.unwrap_or(0);
    Ok(SetScanResult { members, cursor: next, has_more: next != 0, total })
}

#[tauri::command]
pub async fn redis_set_add(
    id: String,
    key: String,
    members: Vec<String>,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
    readonly_state: State<'_, super::server::RedisReadonly>,
) -> Result<i64, String> {
    super::server::require_writable(&id, &readonly_state).await?;
    if members.is_empty() { return Ok(0); }
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let mut cmd = redis::cmd("SADD");
    cmd.arg(&key);
    for m in &members { cmd.arg(m); }
    cmd.query_async::<i64>(&mut conn).await.map_err(|e| format!("SADD 失败: {e}"))
}

#[tauri::command]
pub async fn redis_set_remove(
    id: String,
    key: String,
    members: Vec<String>,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
    readonly_state: State<'_, super::server::RedisReadonly>,
) -> Result<i64, String> {
    super::server::require_writable(&id, &readonly_state).await?;
    if members.is_empty() { return Ok(0); }
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let mut cmd = redis::cmd("SREM");
    cmd.arg(&key);
    for m in &members { cmd.arg(m); }
    cmd.query_async::<i64>(&mut conn).await.map_err(|e| format!("SREM 失败: {e}"))
}

// ── ZSet (R2.5) ────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZSetMember {
    pub member: String,
    pub score: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZSetPage {
    pub members: Vec<ZSetMember>,
    pub total: i64,
    pub offset: i64,
}

#[tauri::command]
pub async fn redis_zset_range(
    id: String,
    key: String,
    offset: i64,
    count: i64,
    reverse: bool, // true = ZREVRANGE（按 score 降序）
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
) -> Result<ZSetPage, String> {
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let total: i64 = redis::cmd("ZCARD").arg(&key).query_async(&mut conn).await.unwrap_or(0);
    let end = (offset + count - 1).min(total - 1);
    let cmd_name = if reverse { "ZREVRANGE" } else { "ZRANGE" };
    let raw: Vec<(Vec<u8>, f64)> = redis::cmd(cmd_name)
        .arg(&key).arg(offset).arg(end).arg("WITHSCORES")
        .query_async(&mut conn).await.map_err(|e| format!("{cmd_name} 失败: {e}"))?;
    let members = raw.into_iter().map(|(m, s)| ZSetMember { member: bytes_to_text(&m), score: s }).collect();
    Ok(ZSetPage { members, total, offset })
}

#[tauri::command]
pub async fn redis_zset_add(
    id: String,
    key: String,
    member: String,
    score: f64,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
    readonly_state: State<'_, super::server::RedisReadonly>,
) -> Result<i64, String> {
    super::server::require_writable(&id, &readonly_state).await?;
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    redis::cmd("ZADD").arg(&key).arg(score).arg(&member)
        .query_async::<i64>(&mut conn).await
        .map_err(|e| format!("ZADD 失败: {e}"))
}

#[tauri::command]
pub async fn redis_zset_remove(
    id: String,
    key: String,
    members: Vec<String>,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
    readonly_state: State<'_, super::server::RedisReadonly>,
) -> Result<i64, String> {
    super::server::require_writable(&id, &readonly_state).await?;
    if members.is_empty() { return Ok(0); }
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let mut cmd = redis::cmd("ZREM");
    cmd.arg(&key);
    for m in &members { cmd.arg(m); }
    cmd.query_async::<i64>(&mut conn).await.map_err(|e| format!("ZREM 失败: {e}"))
}

// ── Stream (R2.6) ──────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamEntry {
    pub id: String,
    pub fields: Vec<(String, String)>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamPage {
    pub entries: Vec<StreamEntry>,
    pub total: i64,
}

fn parse_stream_entry(val: &redis::Value) -> Option<StreamEntry> {
    if let redis::Value::Array(arr) = val {
        let id = match arr.first()? {
            redis::Value::BulkString(b) => String::from_utf8_lossy(b).to_string(),
            redis::Value::SimpleString(s) => s.clone(),
            _ => return None,
        };
        let fields = if let Some(redis::Value::Array(fv)) = arr.get(1) {
            fv.chunks(2).filter_map(|c| {
                let k = match c.first()? {
                    redis::Value::BulkString(b) => String::from_utf8_lossy(b).to_string(),
                    redis::Value::SimpleString(s) => s.clone(),
                    _ => return None,
                };
                let v = match c.get(1)? {
                    redis::Value::BulkString(b) => String::from_utf8_lossy(b).to_string(),
                    redis::Value::SimpleString(s) => s.clone(),
                    _ => String::new(),
                };
                Some((k, v))
            }).collect()
        } else { vec![] };
        Some(StreamEntry { id, fields })
    } else { None }
}

#[tauri::command]
pub async fn redis_stream_range(
    id: String,
    key: String,
    start: Option<String>, // None = "-"
    end: Option<String>,   // None = "+"
    count: Option<i64>,
    reverse: bool,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
) -> Result<StreamPage, String> {
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let total: i64 = redis::cmd("XLEN").arg(&key).query_async(&mut conn).await.unwrap_or(0);
    let s = start.as_deref().unwrap_or(if reverse { "+" } else { "-" });
    let e = end.as_deref().unwrap_or(if reverse { "-" } else { "+" });
    let cnt = count.unwrap_or(100).clamp(1, 500);

    let cmd_name = if reverse { "XREVRANGE" } else { "XRANGE" };
    let raw: Vec<redis::Value> = redis::cmd(cmd_name)
        .arg(&key).arg(s).arg(e).arg("COUNT").arg(cnt)
        .query_async(&mut conn).await
        .map_err(|e| format!("{cmd_name} 失败: {e}"))?;

    let entries = raw.iter().filter_map(parse_stream_entry).collect();
    Ok(StreamPage { entries, total })
}

#[tauri::command]
pub async fn redis_stream_add(
    id: String,
    key: String,
    fields: Vec<(String, String)>,
    stream_id: Option<String>, // None = "*" (自动生成)
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
    readonly_state: State<'_, super::server::RedisReadonly>,
) -> Result<String, String> {
    super::server::require_writable(&id, &readonly_state).await?;
    if fields.is_empty() { return Err("至少需要一个字段".to_string()); }
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let sid = stream_id.as_deref().unwrap_or("*");
    let mut cmd = redis::cmd("XADD");
    cmd.arg(&key).arg(sid);
    for (f, v) in &fields { cmd.arg(f).arg(v); }
    let new_id: String = cmd.query_async(&mut conn).await
        .map_err(|e| format!("XADD 失败: {e}"))?;
    Ok(new_id)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamGroupInfo {
    pub name: String,
    pub consumers: i64,
    pub pending: i64,
    pub last_delivered_id: String,
}

#[tauri::command]
pub async fn redis_stream_groups(
    id: String,
    key: String,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
) -> Result<Vec<StreamGroupInfo>, String> {
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let raw: Vec<redis::Value> = redis::cmd("XINFO").arg("GROUPS").arg(&key)
        .query_async(&mut conn).await
        .map_err(|e| format!("XINFO GROUPS 失败: {e}"))?;

    fn get_str(map: &[redis::Value], key: &str) -> String {
        for i in (0..map.len().saturating_sub(1)).step_by(2) {
            if let redis::Value::BulkString(k) = &map[i] {
                if String::from_utf8_lossy(k) == key {
                    return match &map[i + 1] {
                        redis::Value::BulkString(v) => String::from_utf8_lossy(v).to_string(),
                        redis::Value::SimpleString(s) => s.clone(),
                        redis::Value::Int(n) => n.to_string(),
                        _ => String::new(),
                    };
                }
            }
        }
        String::new()
    }

    let mut groups = vec![];
    for item in &raw {
        if let redis::Value::Array(arr) = item {
            groups.push(StreamGroupInfo {
                name: get_str(arr, "name"),
                consumers: get_str(arr, "consumers").parse().unwrap_or(0),
                pending: get_str(arr, "pending").parse().unwrap_or(0),
                last_delivered_id: get_str(arr, "last-delivered-id"),
            });
        }
    }
    Ok(groups)
}

// ── R2.7 新建任意类型 key ─────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewKeyPayload {
    pub key: String,
    pub kind: String,         // "string" | "hash" | "list" | "set" | "zset" | "stream"
    pub ttl_secs: Option<i64>,
    // string
    pub string_value: Option<String>,
    // hash
    pub hash_fields: Option<Vec<(String, String)>>,
    // list
    pub list_items: Option<Vec<String>>,
    // set
    pub set_members: Option<Vec<String>>,
    // zset: [(member, score)]
    pub zset_members: Option<Vec<(String, f64)>>,
    // stream: field list for first entry
    pub stream_fields: Option<Vec<(String, String)>>,
}

#[tauri::command]
pub async fn redis_create_key(
    id: String,
    payload: NewKeyPayload,
    nx: bool, // true = 防止覆盖（key 已存在则报错）
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
    readonly_state: State<'_, super::server::RedisReadonly>,
) -> Result<(), String> {
    super::server::require_writable(&id, &readonly_state).await?;
    if payload.key.is_empty() { return Err("key 不能为空".to_string()); }
    let mut conn = get_conn(&id, db, &pool, &storage).await?;

    // NX 防覆盖检查
    if nx {
        let kind: String = redis::cmd("TYPE").arg(&payload.key).query_async(&mut conn).await
            .map_err(|e| format!("TYPE 失败: {e}"))?;
        if kind != "none" {
            return Err(format!("key `{}` 已存在（类型: {kind}），请换一个名称", payload.key));
        }
    }

    match payload.kind.as_str() {
        "string" => {
            let val = payload.string_value.as_deref().unwrap_or("");
            let mut cmd = redis::cmd("SET");
            cmd.arg(&payload.key).arg(val);
            if let Some(t) = payload.ttl_secs.filter(|t| *t > 0) {
                cmd.arg("EX").arg(t);
            }
            cmd.query_async::<()>(&mut conn).await.map_err(|e| format!("SET 失败: {e}"))?;
        }
        "hash" => {
            if let Some(fields) = &payload.hash_fields {
                if fields.is_empty() { return Err("至少需要一个字段".to_string()); }
                let mut cmd = redis::cmd("HSET");
                cmd.arg(&payload.key);
                for (f, v) in fields { cmd.arg(f).arg(v); }
                cmd.query_async::<()>(&mut conn).await.map_err(|e| format!("HSET 失败: {e}"))?;
            }
        }
        "list" => {
            if let Some(items) = &payload.list_items {
                if items.is_empty() { return Err("至少需要一个元素".to_string()); }
                let mut cmd = redis::cmd("RPUSH");
                cmd.arg(&payload.key);
                for item in items { cmd.arg(item); }
                cmd.query_async::<()>(&mut conn).await.map_err(|e| format!("RPUSH 失败: {e}"))?;
            }
        }
        "set" => {
            if let Some(members) = &payload.set_members {
                if members.is_empty() { return Err("至少需要一个成员".to_string()); }
                let mut cmd = redis::cmd("SADD");
                cmd.arg(&payload.key);
                for m in members { cmd.arg(m); }
                cmd.query_async::<()>(&mut conn).await.map_err(|e| format!("SADD 失败: {e}"))?;
            }
        }
        "zset" => {
            if let Some(members) = &payload.zset_members {
                if members.is_empty() { return Err("至少需要一个成员".to_string()); }
                let mut cmd = redis::cmd("ZADD");
                cmd.arg(&payload.key);
                for (m, s) in members { cmd.arg(s).arg(m); }
                cmd.query_async::<()>(&mut conn).await.map_err(|e| format!("ZADD 失败: {e}"))?;
            }
        }
        "stream" => {
            let fields = payload.stream_fields.unwrap_or_else(|| vec![("field".into(), "value".into())]);
            let mut cmd = redis::cmd("XADD");
            cmd.arg(&payload.key).arg("*");
            for (f, v) in &fields { cmd.arg(f).arg(v); }
            cmd.query_async::<()>(&mut conn).await.map_err(|e| format!("XADD 失败: {e}"))?;
        }
        t => return Err(format!("不支持的类型: {t}")),
    }

    // 对 hash/list/set/zset/stream 补设 TTL
    if let Some(t) = payload.ttl_secs.filter(|t| *t > 0) {
        if payload.kind != "string" {
            redis::cmd("EXPIRE").arg(&payload.key).arg(t)
                .query_async::<()>(&mut conn).await.ok();
        }
    }

    Ok(())
}
