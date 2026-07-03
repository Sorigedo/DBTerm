// R4.3 慢日志本地持久化
//
// SLOWLOG 是 Redis 内存环形缓冲，重启或被新慢命令挤出后即丢失。
// 本模块提供「按需快照」：把当前 SLOWLOG GET 的内容并入本地 JSON，按 id 去重累积，
// 这样即便 Redis 侧缓冲滚动，历史慢日志也能在本地长期留存。
//
// 隔离：本文件只依赖 super::{get_conn, RedisPool}、storage、标准库，
// 不引用 SQL 侧任何代码。采用与 keychain.rs 一致的 OnceLock 路径 + 原子写盘。

use std::{
    fs,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};

use serde::{Deserialize, Serialize};
use tauri::State;

use super::RedisPool;
use crate::storage::StorageState;

static SLOWLOG_DIR: OnceLock<PathBuf> = OnceLock::new();
static SLOWLOG_LOCK: Mutex<()> = Mutex::new(());

/// 单连接最多保留的历史条数（按 id 降序保留最新）。
const MAX_KEEP: usize = 5000;

/// 由 lib.rs setup 调用，初始化持久化目录（app_data_dir/redis_slowlog）。
pub fn init(app_data_dir: &PathBuf) {
    let _ = SLOWLOG_DIR.set(app_data_dir.join("redis_slowlog"));
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PersistedSlow {
    pub id: i64,
    pub timestamp: i64,
    pub duration_us: i64,
    pub command: String,
}

/// 抹掉慢日志命令中的敏感参数（密码/口令），避免明文落盘或回显前端。
/// 覆盖：AUTH（全部参数）、CONFIG SET requirepass/masterauth、ACL SETUSER 的 >pw/<pw/#hash、
/// 以及任意命令中 AUTH/AUTH2 关键字后的用户名+密码（HELLO / MIGRATE 等）。
pub fn redact_slowlog_cmd(parts: &[String]) -> String {
    if parts.is_empty() { return String::new(); }
    let verb = parts[0].to_uppercase();
    if verb == "AUTH" {
        let mut o = vec![parts[0].clone()];
        o.extend(parts[1..].iter().map(|_| "***".to_string()));
        return o.join(" ");
    }
    let mut out: Vec<String> = Vec::with_capacity(parts.len());
    let mut redact_next = 0usize;
    for (i, p) in parts.iter().enumerate() {
        if redact_next > 0 { out.push("***".into()); redact_next -= 1; continue; }
        let prev = if i > 0 { parts[i - 1].to_uppercase() } else { String::new() };
        if verb == "ACL" && (p.starts_with('>') || p.starts_with('<') || p.starts_with('#')) {
            out.push("***".into()); continue;
        }
        if prev == "REQUIREPASS" || prev == "MASTERAUTH" { out.push("***".into()); continue; }
        if p.eq_ignore_ascii_case("auth") || p.eq_ignore_ascii_case("auth2") {
            out.push(p.clone());
            redact_next = 2; // AUTH 后的 用户名 + 密码 都抹掉（多抹一个 token 也安全）
            continue;
        }
        out.push(p.clone());
    }
    out.join(" ")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotResult {
    /// 本次从 Redis 读取的条数
    pub fetched: i64,
    /// 本次新增（去重后）的条数
    pub added: i64,
    /// 本地累计保留总数
    pub total: i64,
}

/// 把连接 id 转为安全文件名（仅保留字母数字与 - _，其余替换为 _）。
fn sanitize(id: &str) -> String {
    let s: String = id.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    if s.is_empty() { "conn".to_string() } else { s }
}

fn file_path(id: &str) -> Result<PathBuf, String> {
    let dir = SLOWLOG_DIR.get().cloned().ok_or_else(|| "慢日志存储未初始化".to_string())?;
    Ok(dir.join(format!("{}.json", sanitize(id))))
}

fn load_file(path: &PathBuf) -> Vec<PersistedSlow> {
    match fs::read_to_string(path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

fn save_file(path: &PathBuf, entries: &[PersistedSlow]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建慢日志目录失败: {e}"))?;
    }
    let json = serde_json::to_string_pretty(entries)
        .map_err(|e| format!("序列化慢日志失败: {e}"))?;
    // 原子写：先写 .tmp 再 rename，避免写中途崩溃损坏文件（与 storage.rs 同策略）
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &json).map_err(|e| format!("写入慢日志临时文件失败: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("慢日志文件重命名失败: {e}"))
}

/// R4.3: 快照当前 SLOWLOG 并并入本地历史（按 id 去重累积）。
#[tauri::command]
pub async fn redis_slowlog_snapshot(
    id: String,
    count: Option<i64>,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
) -> Result<SnapshotResult, String> {
    // 1) 从 Redis 读取当前 slowlog（默认尽量多读 128 条）
    let mut conn = super::get_conn(&id, db, &pool, &storage).await?;
    let n = count.unwrap_or(128);
    let raw: Vec<redis::Value> = redis::cmd("SLOWLOG").arg("GET").arg(n)
        .query_async(&mut conn).await
        .map_err(|e| format!("SLOWLOG GET 失败: {e}"))?;

    let mut fresh: Vec<PersistedSlow> = Vec::new();
    for item in raw {
        if let redis::Value::Array(arr) = item {
            let eid = match arr.first() { Some(redis::Value::Int(v)) => *v, _ => 0 };
            let ts = match arr.get(1) { Some(redis::Value::Int(v)) => *v, _ => 0 };
            let dur = match arr.get(2) { Some(redis::Value::Int(v)) => *v, _ => 0 };
            let cmd = match arr.get(3) {
                Some(redis::Value::Array(parts)) => {
                    let toks: Vec<String> = parts.iter().map(|p| match p {
                        redis::Value::BulkString(b) => String::from_utf8_lossy(b).to_string(),
                        redis::Value::SimpleString(s) => s.clone(),
                        _ => String::new(),
                    }).collect();
                    redact_slowlog_cmd(&toks)  // 落盘前抹掉 AUTH/ACL/CONFIG 密码等敏感参数
                }
                _ => String::new(),
            };
            fresh.push(PersistedSlow { id: eid, timestamp: ts, duration_us: dur, command: cmd });
        }
    }
    let fetched = fresh.len() as i64;

    // 2) 合并到本地文件（加锁，防并发写）
    let _lock = SLOWLOG_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let path = file_path(&id)?;
    let mut existing = load_file(&path);
    let known: std::collections::HashSet<i64> = existing.iter().map(|e| e.id).collect();

    let mut added = 0i64;
    for e in fresh {
        if !known.contains(&e.id) {
            existing.push(e);
            added += 1;
        }
    }
    // 按 id 降序（新的在前），裁剪到上限
    existing.sort_by(|a, b| b.id.cmp(&a.id));
    existing.truncate(MAX_KEEP);
    let total = existing.len() as i64;
    save_file(&path, &existing)?;

    Ok(SnapshotResult { fetched, added, total })
}

/// R4.3: 读取本地持久化的慢日志历史（按 id 降序）。
#[tauri::command]
pub async fn redis_slowlog_history(id: String) -> Result<Vec<PersistedSlow>, String> {
    let _lock = SLOWLOG_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let path = file_path(&id)?;
    Ok(load_file(&path))
}

/// R4.3: 清空本地持久化的慢日志历史。
#[tauri::command]
pub async fn redis_slowlog_history_clear(id: String) -> Result<(), String> {
    let _lock = SLOWLOG_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let path = file_path(&id)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("删除慢日志文件失败: {e}"))?;
    }
    Ok(())
}
