// R3 CLI + R4 监控面板 + R7 安全 后端命令

use std::sync::Arc;
use serde::Serialize;
use tauri::State;

use crate::storage::StorageState;
use super::{RedisPool, get_conn};

// ── R3 CLI：执行任意命令（非交互式）────────────────────────────────────────────

/// 危险命令清单（需二次确认，前端拦截；后端做最后防线）
const DANGEROUS_CMDS: &[&str] = &[
    "FLUSHALL", "FLUSHDB", "KEYS", "CONFIG", "SHUTDOWN", "DEBUG",
    "REPLICAOF", "SLAVEOF", "FAILOVER", "MIGRATE", "SWAPDB",
    "CLIENT", "SCRIPT", "FUNCTION", "ACL", "RESTORE", "RESET",
    "BGSAVE", "BGREWRITEAOF",
];

fn is_dangerous(cmd: &str) -> bool {
    // 取第一个 token（命令名），整词匹配危险命令清单，避免 starts_with 误拦 KEYSPACE/CLIENTX 等
    let first_token = cmd.trim()
        .split(|c: char| c.is_ascii_whitespace())
        .next()
        .unwrap_or("")
        .to_uppercase();
    DANGEROUS_CMDS.contains(&first_token.as_str())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliResult {
    pub output: String,
    pub ok: bool,
    pub is_dangerous: bool,
    pub dangerous_cmd: Option<String>,
}

fn redis_value_to_string(val: &redis::Value, depth: usize) -> String {
    let indent = "  ".repeat(depth);
    match val {
        redis::Value::Nil => "(nil)".to_string(),
        redis::Value::Int(n) => format!("(integer) {n}"),
        redis::Value::BulkString(b) => {
            let s = String::from_utf8_lossy(b);
            format!("\"{s}\"")
        }
        redis::Value::SimpleString(s) => format!("+{s}"),
        redis::Value::Okay => "+OK".to_string(),
        redis::Value::Array(arr) => {
            if arr.is_empty() { return "(empty array)".to_string(); }
            arr.iter().enumerate().map(|(i, v)| {
                format!("{indent}{}) {}", i + 1, redis_value_to_string(v, depth + 1))
            }).collect::<Vec<_>>().join("\n")
        }
        redis::Value::Map(m) => {
            m.iter().map(|(k, v)| {
                format!("{indent}{} → {}", redis_value_to_string(k, depth + 1), redis_value_to_string(v, depth + 1))
            }).collect::<Vec<_>>().join("\n")
        }
        redis::Value::Attribute { data, .. } => redis_value_to_string(data, depth),
        redis::Value::Set(s) => {
            s.iter().map(|v| redis_value_to_string(v, depth + 1)).collect::<Vec<_>>().join("\n")
        }
        redis::Value::Double(f) => format!("(double) {f}"),
        redis::Value::Boolean(b) => format!("(bool) {b}"),
        redis::Value::VerbatimString { text, .. } => format!("\"{text}\""),
        redis::Value::BigNumber(n) => format!("(bignum) {n}"),
        redis::Value::Push { data, .. } => {
            data.iter().map(|v| redis_value_to_string(v, depth + 1)).collect::<Vec<_>>().join("\n")
        }
        redis::Value::ServerError(e) => format!("(error) {e:?}"),
    }
}

/// 将命令字符串分割成参数（支持引号）
fn parse_cli_args(input: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut quote_char = ' ';
    let mut escape_next = false;

    for ch in input.chars() {
        if escape_next {
            current.push(ch);
            escape_next = false;
        } else if ch == '\\' && in_quotes {
            escape_next = true;
        } else if !in_quotes && (ch == '"' || ch == '\'') {
            in_quotes = true;
            quote_char = ch;
        } else if in_quotes && ch == quote_char {
            in_quotes = false;
        } else if !in_quotes && ch.is_whitespace() {
            if !current.is_empty() {
                args.push(current.clone());
                current.clear();
            }
        } else {
            current.push(ch);
        }
    }
    if !current.is_empty() { args.push(current); }
    args
}

#[tauri::command]
pub async fn redis_cli_exec(
    id: String,
    command: String,
    db: Option<u8>,
    confirmed: bool,
    readonly_state: State<'_, RedisReadonly>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
) -> Result<CliResult, String> {
    let args = parse_cli_args(command.trim());
    if args.is_empty() {
        return Ok(CliResult { output: String::new(), ok: true, is_dangerous: false, dangerous_cmd: None });
    }

    let cmd_name = args[0].to_uppercase();

    // 只读模式：拦截写命令
    if readonly_state.lock().await.contains(&id) && is_write_cmd(&cmd_name) {
        return Ok(CliResult {
            output: format!("(error) 只读模式已启用，命令 {cmd_name} 被拦截"),
            ok: false, is_dangerous: false, dangerous_cmd: None,
        });
    }

    // 危险命令需前端强确认
    if is_dangerous(&cmd_name) && !confirmed {
        return Ok(CliResult {
            output: format!("命令 {cmd_name} 需要二次确认方可执行"),
            ok: false, is_dangerous: true, dangerous_cmd: Some(cmd_name.clone()),
        });
    }

    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let mut redis_cmd = redis::cmd(&cmd_name);
    for arg in args.iter().skip(1) { redis_cmd.arg(arg.as_str()); }

    match redis_cmd.query_async::<redis::Value>(&mut conn).await {
        Ok(val) => Ok(CliResult { output: redis_value_to_string(&val, 0), ok: true, is_dangerous: false, dangerous_cmd: None }),
        Err(e)  => Ok(CliResult { output: format!("(error) {e}"), ok: false, is_dangerous: false, dangerous_cmd: None }),
    }
}

// ── R4 监控面板 ────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisInfoStats {
    // 版本/uptime
    pub version: String,
    pub uptime_secs: u64,
    // 内存
    pub used_memory_bytes: u64,
    pub used_memory_human: String,
    pub used_memory_peak: u64,
    pub used_memory_peak_human: String,
    pub max_memory_bytes: u64,
    pub max_memory_human: String,
    pub max_memory_policy: String,
    pub mem_frag_ratio: f64,
    // 命中率
    pub keyspace_hits: u64,
    pub keyspace_misses: u64,
    pub hit_ratio: f64,
    // 连接
    pub connected_clients: u64,
    pub blocked_clients: u64,
    // ops/sec
    pub instantaneous_ops_per_sec: u64,
    pub total_commands_processed: u64,
    // 淘汰/过期
    pub evicted_keys: u64,
    pub expired_keys: u64,
    // 持久化
    pub rdb_last_bgsave_status: String,
    pub aof_enabled: bool,
    pub aof_last_write_status: String,
    // 主从
    pub role: String,
    pub connected_slaves: u64,
    pub master_repl_offset: i64,
}

fn parse_info_u64(info: &str, key: &str) -> u64 {
    info.lines().find(|l| l.starts_with(&format!("{key}:"))).and_then(|l| {
        l.split(':').nth(1).and_then(|v| v.trim().parse().ok())
    }).unwrap_or(0)
}

fn parse_info_str<'a>(info: &'a str, key: &str) -> String {
    info.lines().find(|l| l.starts_with(&format!("{key}:")))
        .and_then(|l| l.split(':').nth(1))
        .unwrap_or("").trim().to_string()
}

fn parse_info_f64(info: &str, key: &str) -> f64 {
    info.lines().find(|l| l.starts_with(&format!("{key}:"))).and_then(|l| {
        l.split(':').nth(1).and_then(|v| v.trim().parse().ok())
    }).unwrap_or(0.0)
}

#[tauri::command]
pub async fn redis_info_stats(
    id: String,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
) -> Result<RedisInfoStats, String> {
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let info: String = redis::cmd("INFO").arg("all")
        .query_async(&mut conn).await
        .map_err(|e| format!("INFO 失败: {e}"))?;

    let hits   = parse_info_u64(&info, "keyspace_hits");
    let misses = parse_info_u64(&info, "keyspace_misses");
    let hit_ratio = if hits + misses > 0 {
        (hits as f64) / (hits + misses) as f64 * 100.0
    } else { 0.0 };

    Ok(RedisInfoStats {
        version:              parse_info_str(&info, "redis_version"),
        uptime_secs:          parse_info_u64(&info, "uptime_in_seconds"),
        used_memory_bytes:    parse_info_u64(&info, "used_memory"),
        used_memory_human:    parse_info_str(&info, "used_memory_human"),
        used_memory_peak:     parse_info_u64(&info, "used_memory_peak"),
        used_memory_peak_human: parse_info_str(&info, "used_memory_peak_human"),
        max_memory_bytes:     parse_info_u64(&info, "maxmemory"),
        max_memory_human:     parse_info_str(&info, "maxmemory_human"),
        max_memory_policy:    parse_info_str(&info, "maxmemory_policy"),
        mem_frag_ratio:       parse_info_f64(&info, "mem_fragmentation_ratio"),
        keyspace_hits:        hits,
        keyspace_misses:      misses,
        hit_ratio,
        connected_clients:         parse_info_u64(&info, "connected_clients"),
        blocked_clients:           parse_info_u64(&info, "blocked_clients"),
        instantaneous_ops_per_sec: parse_info_u64(&info, "instantaneous_ops_per_sec"),
        total_commands_processed:  parse_info_u64(&info, "total_commands_processed"),
        evicted_keys:         parse_info_u64(&info, "evicted_keys"),
        expired_keys:         parse_info_u64(&info, "expired_keys"),
        rdb_last_bgsave_status: parse_info_str(&info, "rdb_last_bgsave_status"),
        aof_enabled:          parse_info_str(&info, "aof_enabled") == "1",
        aof_last_write_status: parse_info_str(&info, "aof_last_write_status"),
        role:                 parse_info_str(&info, "role"),
        connected_slaves:     parse_info_u64(&info, "connected_slaves"),
        master_repl_offset:   parse_info_str(&info, "master_repl_offset").parse::<i64>().unwrap_or(0),
    })
}

/// R4.2 CLIENT LIST
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientInfo {
    pub id: String,
    pub addr: String,
    pub name: String,
    pub cmd: String,
    pub age: u64,
    pub idle: u64,
    pub flags: String,
    pub omem: u64, // 输出缓冲占用
    pub db: u64,
}

#[tauri::command]
pub async fn redis_client_list(
    id: String,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
) -> Result<Vec<ClientInfo>, String> {
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let raw: String = redis::cmd("CLIENT").arg("LIST")
        .query_async(&mut conn).await
        .map_err(|e| format!("CLIENT LIST 失败: {e}"))?;

    let mut clients = vec![];
    for line in raw.lines() {
        if line.is_empty() { continue; }
        let mut ci = ClientInfo { id: String::new(), addr: String::new(), name: String::new(),
            cmd: String::new(), age: 0, idle: 0, flags: String::new(), omem: 0, db: 0 };
        for kv in line.split(' ') {
            let parts: Vec<&str> = kv.splitn(2, '=').collect();
            if parts.len() != 2 { continue; }
            match parts[0] {
                "id"   => ci.id   = parts[1].to_string(),
                "addr" => ci.addr = parts[1].to_string(),
                "name" => ci.name = parts[1].to_string(),
                "cmd"  => ci.cmd  = parts[1].to_string(),
                "age"  => ci.age  = parts[1].parse().unwrap_or(0),
                "idle" => ci.idle = parts[1].parse().unwrap_or(0),
                "flags"=> ci.flags= parts[1].to_string(),
                "omem" => ci.omem = parts[1].parse().unwrap_or(0),
                "db"   => ci.db   = parts[1].parse().unwrap_or(0),
                _ => {}
            }
        }
        clients.push(ci);
    }
    Ok(clients)
}

/// R4.2 CLIENT KILL（强确认由前端保证，后端直接执行）
#[tauri::command]
pub async fn redis_client_kill(
    id: String,
    client_id: String,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
) -> Result<String, String> {
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let result: redis::Value = redis::cmd("CLIENT").arg("KILL").arg("ID").arg(&client_id)
        .query_async(&mut conn).await
        .map_err(|e| format!("CLIENT KILL 失败: {e}"))?;
    Ok(redis_value_to_string(&result, 0))
}

/// R4.5 CONFIG GET（只读）
#[tauri::command]
pub async fn redis_config_get(
    id: String,
    pattern: String,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
) -> Result<Vec<(String, String)>, String> {
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let pat = if pattern.is_empty() { "*".to_string() } else { pattern };
    let raw: Vec<String> = redis::cmd("CONFIG").arg("GET").arg(&pat)
        .query_async(&mut conn).await
        .map_err(|e| format!("CONFIG GET 失败: {e}"))?;
    let pairs: Vec<(String, String)> = raw.chunks(2)
        .filter_map(|c| if let [k, v] = c { Some((k.clone(), v.clone())) } else { None })
        .collect();
    Ok(pairs)
}

/// CONFIG SET（写操作）。受只读模式拦截；危险项的强确认由前端保证。
/// 配置项名做字符白名单校验，防止借参数注入额外 CONFIG 子命令。
#[tauri::command]
pub async fn redis_config_set(
    id: String,
    key: String,
    value: String,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
    readonly_state: State<'_, RedisReadonly>,
) -> Result<(), String> {
    if key.trim().is_empty() { return Err("配置项名不能为空".to_string()); }
    if readonly_state.lock().await.contains(&id) {
        return Err("只读模式已开启，禁止修改配置".to_string());
    }
    // CONFIG 参数名仅含字母/数字/连字符，拒绝空格等可注入额外参数的字符
    if !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("配置项名包含非法字符".to_string());
    }
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    redis::cmd("CONFIG").arg("SET").arg(&key).arg(&value)
        .query_async::<()>(&mut conn).await
        .map_err(|e| format!("CONFIG SET 失败: {e}"))
}

/// R4.3 SLOWLOG RESET
#[tauri::command]
pub async fn redis_slowlog_reset(
    id: String,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
    readonly_state: State<'_, RedisReadonly>,
) -> Result<(), String> {
    require_writable(&id, &readonly_state).await?;
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    redis::cmd("SLOWLOG").arg("RESET")
        .query_async::<()>(&mut conn).await
        .map_err(|e| format!("SLOWLOG RESET 失败: {e}"))
}

/// R4.8 手动 BGSAVE（强确认由前端保证）
#[tauri::command]
pub async fn redis_bgsave(
    id: String,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
    readonly_state: State<'_, RedisReadonly>,
) -> Result<String, String> {
    require_writable(&id, &readonly_state).await?;
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let r: String = redis::cmd("BGSAVE")
        .query_async(&mut conn).await
        .map_err(|e| format!("BGSAVE 失败: {e}"))?;
    Ok(r)
}

/// R4.8 手动 BGREWRITEAOF（强确认由前端保证）
#[tauri::command]
pub async fn redis_bgrewriteaof(
    id: String,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
    readonly_state: State<'_, RedisReadonly>,
) -> Result<String, String> {
    require_writable(&id, &readonly_state).await?;
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let r: String = redis::cmd("BGREWRITEAOF")
        .query_async(&mut conn).await
        .map_err(|e| format!("BGREWRITEAOF 失败: {e}"))?;
    Ok(r)
}

// ── R3.4 BUSY 急救（SCRIPT KILL / FUNCTION KILL）──────────────────────────────

/// 检测 Redis 是否处于 BUSY 状态（Lua 脚本/函数卡死）
#[tauri::command]
pub async fn redis_check_busy(
    id: String,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
) -> Result<bool, String> {
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    // 发一个轻量命令，如果 Redis 在执行脚本会返回 BUSY 错误
    let r: Result<redis::Value, redis::RedisError> = redis::cmd("PING").query_async(&mut conn).await;
    match r {
        Err(e) if e.to_string().contains("BUSY") => Ok(true),
        _ => Ok(false),
    }
}

/// R3.4 SCRIPT KILL（强确认由前端保证；若脚本已写数据需 SHUTDOWN NOSAVE）
#[tauri::command]
pub async fn redis_script_kill(
    id: String,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
) -> Result<String, String> {
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    match redis::cmd("SCRIPT").arg("KILL").query_async::<redis::Value>(&mut conn).await {
        Ok(v) => Ok(redis_value_to_string(&v, 0)),
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("NOTBUSY") {
                Ok("(info) 当前没有正在执行的脚本".to_string())
            } else if msg.contains("UNKILLABLE") {
                Err("脚本已写入数据，无法 KILL（只能 SHUTDOWN NOSAVE）".to_string())
            } else {
                Err(format!("SCRIPT KILL 失败: {e}"))
            }
        }
    }
}

/// R3.4 FUNCTION KILL（Redis 7.0+）
#[tauri::command]
pub async fn redis_function_kill(
    id: String,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
) -> Result<String, String> {
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    match redis::cmd("FUNCTION").arg("KILL").query_async::<redis::Value>(&mut conn).await {
        Ok(v) => Ok(redis_value_to_string(&v, 0)),
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("NOTBUSY") {
                Ok("(info) 当前没有正在执行的函数".to_string())
            } else {
                Err(format!("FUNCTION KILL 失败: {e}"))
            }
        }
    }
}

// ── R4.3 LATENCY 诊断 ─────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatencyEvent {
    pub event: String,
    pub latest_ts: i64,
    pub latest_ms: i64,
    pub max_ms: i64,
}

/// R4.3 LATENCY LATEST
#[tauri::command]
pub async fn redis_latency_latest(
    id: String,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
) -> Result<Vec<LatencyEvent>, String> {
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let raw: Vec<redis::Value> = redis::cmd("LATENCY").arg("LATEST")
        .query_async(&mut conn).await
        .map_err(|e| format!("LATENCY LATEST 失败: {e}"))?;

    let mut events = vec![];
    for item in &raw {
        if let redis::Value::Array(arr) = item {
            let event = match arr.first() {
                Some(redis::Value::BulkString(b)) => String::from_utf8_lossy(b).to_string(),
                Some(redis::Value::SimpleString(s)) => s.clone(),
                _ => continue,
            };
            let latest_ts = match arr.get(1) { Some(redis::Value::Int(v)) => *v, _ => 0 };
            let latest_ms = match arr.get(2) { Some(redis::Value::Int(v)) => *v, _ => 0 };
            let max_ms    = match arr.get(3) { Some(redis::Value::Int(v)) => *v, _ => 0 };
            events.push(LatencyEvent { event, latest_ts, latest_ms, max_ms });
        }
    }
    Ok(events)
}

/// R4.3 LATENCY DOCTOR
#[tauri::command]
pub async fn redis_latency_doctor(
    id: String,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
) -> Result<String, String> {
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    redis::cmd("LATENCY").arg("DOCTOR")
        .query_async::<String>(&mut conn).await
        .map_err(|e| format!("LATENCY DOCTOR 失败: {e}"))
}

// ── R4.4 内存分析 ─────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryPrefixStat {
    pub prefix: String,
    pub count: u64,
    pub total_bytes: i64,
    pub avg_bytes: i64,
    pub no_ttl_count: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryAnalysisResult {
    pub by_prefix: Vec<MemoryPrefixStat>,
    pub memory_stats: Vec<(String, String)>, // MEMORY STATS key-value pairs
    pub ttl_distribution: Vec<(String, u64)>, // 桶标签 → 数量
    pub no_ttl_total: u64,
    pub scanned: u64,
}

/// R4.4 内存分析（按前缀聚合 + TTL 分布 + MEMORY STATS）
/// 扫描至多 max_keys 个 key（默认 5000），避免长时阻塞
#[tauri::command]
pub async fn redis_memory_analysis(
    id: String,
    db: Option<u8>,
    max_keys: Option<u64>,
    separator: Option<String>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
) -> Result<MemoryAnalysisResult, String> {
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let sep = separator.as_deref().unwrap_or(":").to_string();
    let limit = max_keys.unwrap_or(5000).min(50000);

    // 获取 MEMORY STATS（返回 flat array 或 map，统一处理）
    let mem_stats_raw: Result<redis::Value, redis::RedisError> = redis::cmd("MEMORY").arg("STATS").query_async(&mut conn).await;
    let mut memory_stats = vec![];
    if let Ok(mem_val) = mem_stats_raw {
        match mem_val {
            redis::Value::Array(arr) => {
                for pair in arr.chunks(2) {
                    if let [k, v] = pair {
                        let key = redis_value_to_string(k, 0).trim_matches('"').to_string();
                        let val = redis_value_to_string(v, 0);
                        memory_stats.push((key, val));
                    }
                }
            }
            redis::Value::Map(m) => {
                for (k, v) in m {
                    let key = redis_value_to_string(&k, 0).trim_matches('"').to_string();
                    let val = redis_value_to_string(&v, 0);
                    memory_stats.push((key, val));
                }
            }
            _ => {}
        }
    }

    // SCAN + MEMORY USAGE + TTL 流水线
    use std::collections::HashMap;
    let mut prefix_map: HashMap<String, MemoryPrefixStat> = HashMap::new();
    let mut ttl_buckets: HashMap<String, u64> = HashMap::new();
    let mut no_ttl_total: u64 = 0;
    let mut scanned: u64 = 0;
    let mut cursor: u64 = 0;

    loop {
        let (next, keys): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor).arg("COUNT").arg(200)
            .query_async(&mut conn).await
            .map_err(|e| format!("SCAN 失败: {e}"))?;

        for key in &keys {
            let mem: i64 = redis::cmd("MEMORY").arg("USAGE").arg(key).arg("SAMPLES").arg(0)
                .query_async(&mut conn).await.unwrap_or(0);
            let ttl: i64 = redis::cmd("TTL").arg(key).query_async(&mut conn).await.unwrap_or(-1);

            // 前缀提取（取第一段）
            let prefix = if let Some(pos) = key.find(sep.as_str()) {
                key[..pos].to_string()
            } else {
                "(no-prefix)".to_string()
            };

            let entry = prefix_map.entry(prefix).or_insert(MemoryPrefixStat {
                prefix: String::new(), count: 0, total_bytes: 0, avg_bytes: 0, no_ttl_count: 0,
            });
            entry.count += 1;
            entry.total_bytes += mem;
            if ttl == -1 { entry.no_ttl_count += 1; no_ttl_total += 1; }

            // TTL 分桶
            let bucket = if ttl == -1 { "永久".to_string() }
                else if ttl <= 60 { "≤1m".to_string() }
                else if ttl <= 3600 { "1m-1h".to_string() }
                else if ttl <= 86400 { "1h-1d".to_string() }
                else { ">1d".to_string() };
            *ttl_buckets.entry(bucket).or_insert(0) += 1;
        }
        scanned += keys.len() as u64;
        cursor = next;
        if cursor == 0 || scanned >= limit { break; }
    }

    // 计算均值，填 prefix 字段，排序
    let mut by_prefix: Vec<MemoryPrefixStat> = prefix_map.into_iter().map(|(k, mut v)| {
        v.prefix = k;
        v.avg_bytes = if v.count > 0 { v.total_bytes / v.count as i64 } else { 0 };
        v
    }).collect();
    by_prefix.sort_by(|a, b| b.total_bytes.cmp(&a.total_bytes));
    by_prefix.truncate(50);

    let bucket_order = ["≤1m", "1m-1h", "1h-1d", ">1d", "永久"];
    let ttl_distribution: Vec<(String, u64)> = bucket_order.iter()
        .filter_map(|b| ttl_buckets.get(*b).map(|n| (b.to_string(), *n)))
        .collect();

    Ok(MemoryAnalysisResult { by_prefix, memory_stats, ttl_distribution, no_ttl_total, scanned })
}

// ── R4.6 热/冷 key 分析 ───────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyTempInfo {
    pub key: String,
    pub kind: String,
    pub freq_or_idle: i64, // LFU 时为 freq，否则为 idletime(s)
}

/// R4.6 热 key 分析（LFU 策略下 OBJECT FREQ 采样）
#[tauri::command]
pub async fn redis_hotkey_scan(
    id: String,
    db: Option<u8>,
    top_n: Option<usize>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
) -> Result<Vec<KeyTempInfo>, String> {
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let n = top_n.unwrap_or(20).min(200);
    let mut results: Vec<KeyTempInfo> = vec![];
    let mut cursor: u64 = 0;
    let mut scanned: usize = 0;
    const MAX_SCAN: usize = 50_000;

    loop {
        let (next, keys): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor).arg("COUNT").arg(200)
            .query_async(&mut conn).await
            .map_err(|e| format!("SCAN 失败: {e}"))?;

        scanned += keys.len();
        for key in &keys {
            let freq: Result<i64, _> = redis::cmd("OBJECT").arg("FREQ").arg(key).query_async(&mut conn).await;
            let kind: String = redis::cmd("TYPE").arg(key).query_async(&mut conn).await
                .unwrap_or_else(|_| "unknown".into());
            if let Ok(f) = freq {
                results.push(KeyTempInfo { key: key.clone(), kind, freq_or_idle: f });
            }
        }
        cursor = next;
        if cursor == 0 || results.len() >= n * 5 || scanned >= MAX_SCAN { break; }
    }

    results.sort_by(|a, b| b.freq_or_idle.cmp(&a.freq_or_idle));
    Ok(results.into_iter().take(n).collect())
}

/// R4.6 冷 key 分析（OBJECT IDLETIME 找长时间未访问的 key）
#[tauri::command]
pub async fn redis_coldkey_scan(
    id: String,
    db: Option<u8>,
    top_n: Option<usize>,
    min_idle_secs: Option<i64>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
) -> Result<Vec<KeyTempInfo>, String> {
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let n = top_n.unwrap_or(20).min(200);
    let min_idle = min_idle_secs.unwrap_or(3600);
    let mut results: Vec<KeyTempInfo> = vec![];
    let mut cursor: u64 = 0;
    let mut scanned: usize = 0;
    const MAX_SCAN: usize = 50_000;

    loop {
        let (next, keys): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor).arg("COUNT").arg(200)
            .query_async(&mut conn).await
            .map_err(|e| format!("SCAN 失败: {e}"))?;

        scanned += keys.len();
        for key in &keys {
            let idle: Result<i64, _> = redis::cmd("OBJECT").arg("IDLETIME").arg(key).query_async(&mut conn).await;
            if let Ok(i) = idle {
                if i >= min_idle {
                    let kind: String = redis::cmd("TYPE").arg(key).query_async(&mut conn).await
                        .unwrap_or_else(|_| "unknown".into());
                    results.push(KeyTempInfo { key: key.clone(), kind, freq_or_idle: i });
                }
            }
        }
        cursor = next;
        if cursor == 0 || results.len() >= n * 5 || scanned >= MAX_SCAN { break; }
    }

    results.sort_by(|a, b| b.freq_or_idle.cmp(&a.freq_or_idle));
    Ok(results.into_iter().take(n).collect())
}

// ── R4.7 主从复制面板 ─────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplicaInfo {
    pub ip: String,
    pub port: u16,
    pub state: String,
    pub offset: i64,
    pub lag: i64,       // bytes behind master
    pub lag_readable: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplicationInfo {
    pub role: String,
    pub connected_slaves: u64,
    pub master_repl_offset: i64,
    pub repl_backlog_size: i64,
    pub master_host: String,  // 仅 slave 时有值
    pub master_port: u16,
    pub master_link_status: String,
    pub master_last_io_seconds: i64,
    pub replicas: Vec<ReplicaInfo>,
}

/// R4.7 解析 INFO replication 为结构化数据
#[tauri::command]
pub async fn redis_replication_info(
    id: String,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
) -> Result<ReplicationInfo, String> {
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let info: String = redis::cmd("INFO").arg("replication")
        .query_async(&mut conn).await
        .map_err(|e| format!("INFO replication 失败: {e}"))?;

    let role               = parse_info_str(&info, "role");
    let connected_slaves   = parse_info_u64(&info, "connected_slaves");
    let master_repl_offset = parse_info_str(&info, "master_repl_offset").parse::<i64>().unwrap_or(0);
    let repl_backlog_size  = parse_info_str(&info, "repl_backlog_size").parse::<i64>().unwrap_or(0);
    let master_host        = parse_info_str(&info, "master_host");
    let master_port        = parse_info_str(&info, "master_port").parse::<u16>().unwrap_or(0);
    let master_link_status = parse_info_str(&info, "master_link_status");
    let master_last_io_seconds = parse_info_str(&info, "master_last_io_seconds_ago")
        .parse::<i64>().unwrap_or(0);

    // slave0:ip=127.0.0.1,port=6380,state=online,offset=123,lag=0
    let mut replicas = vec![];
    for line in info.lines() {
        if !line.starts_with("slave") { continue; }
        let kv: Vec<&str> = line.splitn(2, ':').collect();
        if kv.len() != 2 { continue; }
        let mut ip = String::new(); let mut port = 0u16;
        let mut state = String::new(); let mut offset = 0i64; let mut lag = 0i64;
        for part in kv[1].split(',') {
            let pv: Vec<&str> = part.splitn(2, '=').collect();
            if pv.len() != 2 { continue; }
            match pv[0] {
                "ip"     => ip    = pv[1].to_string(),
                "port"   => port  = pv[1].parse().unwrap_or(0),
                "state"  => state = pv[1].to_string(),
                "offset" => offset= pv[1].parse().unwrap_or(0),
                "lag"    => lag   = pv[1].parse().unwrap_or(0),
                _ => {}
            }
        }
        let behind = master_repl_offset - offset;
        let lag_readable = if behind == 0 { "同步".to_string() }
            else if behind < 1024 { format!("{behind}B") }
            else if behind < 1024 * 1024 { format!("{:.1}KB", behind as f64 / 1024.0) }
            else { format!("{:.2}MB", behind as f64 / 1024.0 / 1024.0) };
        let _ = lag;
        replicas.push(ReplicaInfo { ip, port, state, offset, lag: behind, lag_readable });
    }

    Ok(ReplicationInfo {
        role, connected_slaves, master_repl_offset, repl_backlog_size,
        master_host, master_port, master_link_status, master_last_io_seconds, replicas,
    })
}

// ── R7.1 只读模式 ─────────────────────────────────────────────────────────────

/// WRITE_CMDS：这些命令在只读模式下应被拦截
const WRITE_CMDS: &[&str] = &[
    "SET", "SETNX", "SETEX", "PSETEX", "MSET", "MSETNX", "GETSET", "GETDEL", "GETEX",
    "APPEND", "INCR", "DECR", "INCRBY", "DECRBY", "INCRBYFLOAT",
    "SETBIT", "SETRANGE", "BITOP", "BITFIELD",
    "DEL", "UNLINK", "EXPIRE", "PEXPIRE", "EXPIREAT", "PEXPIREAT", "PERSIST", "RENAME", "RENAMENX",
    "COPY", "MOVE", "RESTORE", "SWAPDB",
    "LPUSH", "RPUSH", "LPUSHX", "RPUSHX", "LPOP", "RPOP", "LSET", "LREM", "LTRIM", "LINSERT",
    "RPOPLPUSH", "LMOVE", "BLPOP", "BRPOP", "BLMOVE", "BRPOPLPUSH", "LMPOP", "BLMPOP",
    "SADD", "SREM", "SMOVE", "SPOP", "SINTERSTORE", "SUNIONSTORE", "SDIFFSTORE",
    "ZADD", "ZREM", "ZINCRBY", "ZPOPMIN", "ZPOPMAX", "ZMPOP", "BZPOPMIN", "BZPOPMAX",
    "ZDIFFSTORE", "ZINTERSTORE", "ZUNIONSTORE", "ZRANGESTORE",
    "ZREMRANGEBYRANK", "ZREMRANGEBYSCORE", "ZREMRANGEBYLEX",
    "HSET", "HSETNX", "HMSET", "HDEL", "HINCRBY", "HINCRBYFLOAT",
    "XADD", "XDEL", "XTRIM", "XGROUP", "XACK", "XCLAIM", "XAUTOCLAIM", "XSETID",
    "GEOADD", "GEOSEARCHSTORE",
    "PFADD", "PFMERGE",
    "FLUSHDB", "FLUSHALL", "BGSAVE", "BGREWRITEAOF",
    "PUBLISH", "SUBSCRIBE", "PSUBSCRIBE",
    // 脚本/函数/迁移/调试：可间接写数据，只读模式一律拦截
    "EVAL", "EVALSHA", "FCALL", "FUNCTION", "MIGRATE", "DEBUG", "SORT",
    // 服务端状态/配置/权限/拓扑变更：只读模式经 CLI 也必须拦（其读子命令在专属面板另有入口）
    "CONFIG", "CLIENT", "ACL", "SHUTDOWN", "REPLICAOF", "SLAVEOF", "FAILOVER",
    "CLUSTER", "MODULE", "SCRIPT", "RESET",
];

pub fn is_write_cmd(cmd: &str) -> bool {
    let upper = cmd.to_uppercase();
    WRITE_CMDS.iter().any(|w| upper == *w)
}

pub type RedisReadonly = Arc<tokio::sync::Mutex<std::collections::HashSet<String>>>;

/// 只读护栏：连接处于只读模式时拒绝写操作。所有改数据/改服务端状态的命令开头都应调用它。
pub async fn require_writable(id: &str, readonly_state: &RedisReadonly) -> Result<(), String> {
    if readonly_state.lock().await.contains(id) {
        return Err("该连接为只读模式，已禁止写操作".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn redis_set_readonly(
    id: String,
    readonly: bool,
    readonly_state: State<'_, RedisReadonly>,
) -> Result<(), String> {
    let mut guard = readonly_state.lock().await;
    if readonly { guard.insert(id); } else { guard.remove(&id); }
    Ok(())
}

#[tauri::command]
pub async fn redis_is_readonly(
    id: String,
    readonly_state: State<'_, RedisReadonly>,
) -> Result<bool, String> {
    Ok(readonly_state.lock().await.contains(&id))
}

// ── R8.1 一键巡检报告 ─────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectItem {
    pub category: String,
    pub name: String,
    pub status: String,     // "ok" | "warn" | "error"
    pub value: String,
    pub suggestion: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectReport {
    pub items: Vec<InspectItem>,
    pub score: u8,            // 0-100
    pub version: String,
    pub role: String,
    pub uptime_secs: u64,
    pub used_memory_human: String,
    pub max_memory_human: String,
    pub total_keys: u64,
    pub markdown: String,
}

#[tauri::command]
pub async fn redis_inspect_report(
    id: String,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
) -> Result<InspectReport, String> {
    let mut conn = get_conn(&id, db, &pool, &storage).await?;

    let info: String = redis::cmd("INFO").arg("all")
        .query_async(&mut conn).await
        .map_err(|e| format!("INFO 失败: {e}"))?;

    let mut items: Vec<InspectItem> = vec![];
    let mut deductions: u8 = 0;

    // ── 内存 ────────────────────────────────────────────────────────────────────
    let used = parse_info_u64(&info, "used_memory");
    let max  = parse_info_u64(&info, "maxmemory");
    let policy = parse_info_str(&info, "maxmemory_policy");
    let used_human = parse_info_str(&info, "used_memory_human");
    let max_human  = parse_info_str(&info, "maxmemory_human");
    let frag = parse_info_f64(&info, "mem_fragmentation_ratio");

    if max == 0 {
        items.push(InspectItem {
            category: "内存".into(), name: "maxmemory".into(),
            status: "warn".into(), value: "未设置".into(),
            suggestion: "建议设置 maxmemory，否则 OOM 风险高".into(),
        });
        deductions += 15;
    } else {
        let pct = used as f64 / max as f64 * 100.0;
        let status = if pct >= 90.0 { deductions += 20; "error" }
            else if pct >= 75.0 { deductions += 8; "warn" } else { "ok" };
        items.push(InspectItem {
            category: "内存".into(), name: "内存使用率".into(),
            status: status.into(), value: format!("{pct:.1}% ({used_human} / {max_human})"),
            suggestion: if pct >= 90.0 { "内存接近上限，存在淘汰/OOM 风险".into() } else { String::new() },
        });
    }

    if policy == "noeviction" && max > 0 {
        let pct = used as f64 / max as f64 * 100.0;
        if pct >= 80.0 {
            items.push(InspectItem {
                category: "内存".into(), name: "noeviction 策略".into(),
                status: "error".into(), value: format!("策略: {policy}，使用率: {pct:.1}%"),
                suggestion: "noeviction + 高内存使用率 = 新写入将直接报错".into(),
            });
            deductions += 15;
        }
    }

    if frag > 1.5 {
        let status = if frag > 2.0 { deductions += 10; "error" } else { deductions += 5; "warn" };
        items.push(InspectItem {
            category: "内存".into(), name: "碎片率".into(),
            status: status.into(), value: format!("{frag:.2}"),
            suggestion: "内存碎片率过高，考虑开启 activedefrag 或重启整理".into(),
        });
    } else {
        items.push(InspectItem {
            category: "内存".into(), name: "碎片率".into(),
            status: "ok".into(), value: format!("{frag:.2}"), suggestion: String::new(),
        });
    }

    // ── 命中率 ──────────────────────────────────────────────────────────────────
    let hits   = parse_info_u64(&info, "keyspace_hits");
    let misses = parse_info_u64(&info, "keyspace_misses");
    if hits + misses > 0 {
        let hr = hits as f64 / (hits + misses) as f64 * 100.0;
        let status = if hr < 80.0 { deductions += 10; "warn" } else { "ok" };
        items.push(InspectItem {
            category: "命中率".into(), name: "keyspace 命中率".into(),
            status: status.into(), value: format!("{hr:.1}%"),
            suggestion: if hr < 80.0 { "命中率偏低，检查热点 key 是否已淘汰或容量不足".into() } else { String::new() },
        });
    }

    // ── 持久化 ──────────────────────────────────────────────────────────────────
    let rdb_status  = parse_info_str(&info, "rdb_last_bgsave_status");
    let aof_enabled = parse_info_str(&info, "aof_enabled") == "1";
    let aof_status  = parse_info_str(&info, "aof_last_write_status");
    let rdb_changes = parse_info_u64(&info, "rdb_changes_since_last_save");
    let rdb_last_save = parse_info_u64(&info, "rdb_last_save_time");

    if rdb_status != "ok" && !rdb_status.is_empty() {
        items.push(InspectItem {
            category: "持久化".into(), name: "RDB BGSAVE 状态".into(),
            status: "error".into(), value: rdb_status.clone(),
            suggestion: "上次 BGSAVE 失败，检查磁盘空间与权限".into(),
        });
        deductions += 10;
    } else {
        items.push(InspectItem {
            category: "持久化".into(), name: "RDB 状态".into(),
            status: "ok".into(), value: rdb_status, suggestion: String::new(),
        });
    }

    if !aof_enabled {
        items.push(InspectItem {
            category: "持久化".into(), name: "AOF 状态".into(),
            status: "warn".into(), value: "已关闭".into(),
            suggestion: "AOF 关闭时，仅依赖 RDB，故障恢复窗口可能达数分钟".into(),
        });
        deductions += 5;
    } else if aof_status != "ok" && !aof_status.is_empty() {
        items.push(InspectItem {
            category: "持久化".into(), name: "AOF 写状态".into(),
            status: "error".into(), value: aof_status,
            suggestion: "AOF 写入异常，检查磁盘空间与 I/O".into(),
        });
        deductions += 10;
    }

    let now_secs = {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
    };
    if rdb_last_save > 0 && now_secs > rdb_last_save {
        let hours_since = (now_secs - rdb_last_save) / 3600;
        if hours_since > 24 {
            items.push(InspectItem {
                category: "持久化".into(), name: "RDB 上次保存时间".into(),
                status: "warn".into(), value: format!("{hours_since}h 前"),
                suggestion: format!("已有 {rdb_changes} 条变更未持久化，建议手动 BGSAVE"),
            });
            deductions += 5;
        }
    }

    // ── 复制 ────────────────────────────────────────────────────────────────────
    let role = parse_info_str(&info, "role");
    let master_link = parse_info_str(&info, "master_link_status");
    if role == "slave" && master_link == "down" {
        items.push(InspectItem {
            category: "复制".into(), name: "主从链路".into(),
            status: "error".into(), value: "断开".into(),
            suggestion: "从库与主库断开，检查网络与主库状态".into(),
        });
        deductions += 15;
    } else if role == "slave" {
        items.push(InspectItem {
            category: "复制".into(), name: "主从链路".into(),
            status: "ok".into(), value: "已连接".into(), suggestion: String::new(),
        });
    }

    // ── 连接数 ──────────────────────────────────────────────────────────────────
    let clients = parse_info_u64(&info, "connected_clients");
    let blocked = parse_info_u64(&info, "blocked_clients");
    if blocked > 10 {
        items.push(InspectItem {
            category: "连接".into(), name: "阻塞客户端".into(),
            status: "warn".into(), value: format!("{blocked}"),
            suggestion: "较多客户端被阻塞（BLPOP/BRPOP 等），检查消费方是否正常".into(),
        });
        deductions += 5;
    }
    items.push(InspectItem {
        category: "连接".into(), name: "已连接客户端".into(),
        status: "ok".into(), value: format!("{clients}"), suggestion: String::new(),
    });

    // ── CONFIG 关键风险项 ───────────────────────────────────────────────────────
    let slowlog_threshold: String = redis::cmd("CONFIG").arg("GET").arg("slowlog-log-slower-than")
        .query_async::<Vec<String>>(&mut conn).await
        .unwrap_or_default().into_iter().nth(1).unwrap_or_default();
    if slowlog_threshold.parse::<i64>().unwrap_or(-1) < 0 {
        items.push(InspectItem {
            category: "配置".into(), name: "慢日志阈值".into(),
            status: "warn".into(), value: "未启用".into(),
            suggestion: "建议设置 slowlog-log-slower-than 为 1000（微秒），便于诊断慢查询".into(),
        });
        deductions += 3;
    }

    // 总分
    let score = 100u8.saturating_sub(deductions);
    let version       = parse_info_str(&info, "redis_version");
    let uptime_secs   = parse_info_u64(&info, "uptime_in_seconds");
    let total_keys    = parse_info_u64(&info, "db0"); // 粗略计

    // 生成 Markdown
    let mut md = format!("# Redis 巡检报告\n\n");
    md.push_str(&format!("- **版本**: {version}\n"));
    md.push_str(&format!("- **角色**: {role}\n"));
    md.push_str(&format!("- **综合评分**: {score}/100\n\n"));
    md.push_str("## 检查项明细\n\n");
    md.push_str("| 分类 | 检查项 | 状态 | 当前值 | 建议 |\n");
    md.push_str("|---|---|---|---|---|\n");
    for item in &items {
        let status_icon = match item.status.as_str() { "ok" => "✅", "warn" => "⚠️", _ => "❌" };
        md.push_str(&format!("| {} | {} | {} | {} | {} |\n",
            item.category, item.name, status_icon, item.value, item.suggestion));
    }

    Ok(InspectReport {
        items, score, version, role, uptime_secs,
        used_memory_human: used_human, max_memory_human: max_human,
        total_keys, markdown: md,
    })
}

// ── R8.2 配置风险扫描 ─────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigRisk {
    pub key: String,
    pub current_value: String,
    pub risk_level: String,  // "warn" | "error"
    pub description: String,
    pub suggestion: String,
}

#[tauri::command]
pub async fn redis_config_risks(
    id: String,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
) -> Result<Vec<ConfigRisk>, String> {
    let mut conn = get_conn(&id, db, &pool, &storage).await?;

    let cfg_raw: Vec<String> = redis::cmd("CONFIG").arg("GET").arg("*")
        .query_async(&mut conn).await
        .map_err(|e| format!("CONFIG GET 失败: {e}"))?;

    let mut cfg = std::collections::HashMap::new();
    for chunk in cfg_raw.chunks(2) {
        if let [k, v] = chunk { cfg.insert(k.clone(), v.clone()); }
    }

    let info: String = redis::cmd("INFO").arg("server")
        .query_async(&mut conn).await
        .map_err(|e| format!("INFO 失败: {e}"))?;
    let mode = parse_info_str(&info, "redis_mode");
    let bind_addrs = cfg.get("bind").cloned().unwrap_or_default();
    let protected  = cfg.get("protected-mode").cloned().unwrap_or_default();
    let requirepass= cfg.get("requirepass").cloned().unwrap_or_default();
    let maxmemory  = cfg.get("maxmemory").cloned().unwrap_or_default();
    let maxpolicy  = cfg.get("maxmemory-policy").cloned().unwrap_or_default();
    let appendonly = cfg.get("appendonly").cloned().unwrap_or_default();
    let save_sched = cfg.get("save").cloned().unwrap_or_default();
    let slowlog_th = cfg.get("slowlog-log-slower-than").cloned().unwrap_or_default();
    let _ = mode;

    let mut risks: Vec<ConfigRisk> = vec![];

    // maxmemory 未设
    if maxmemory == "0" || maxmemory.is_empty() {
        risks.push(ConfigRisk {
            key: "maxmemory".into(),
            current_value: "0 (无限制)".into(),
            risk_level: "warn".into(),
            description: "未设置内存上限，高负载下可能导致 OOM Killer 终止进程".into(),
            suggestion: "根据实例可用内存设置 maxmemory，并选择合适的淘汰策略".into(),
        });
    }

    // noeviction + 有内存上限
    if maxpolicy == "noeviction" && maxmemory != "0" {
        risks.push(ConfigRisk {
            key: "maxmemory-policy".into(),
            current_value: maxpolicy.clone(),
            risk_level: "warn".into(),
            description: "noeviction 策略：内存满后新写入直接报错".into(),
            suggestion: "如需自动淘汰，改为 allkeys-lru 或 volatile-lru".into(),
        });
    }

    // 无 AOF 无 RDB save
    if appendonly == "no" && (save_sched.is_empty() || save_sched == "\"\"") {
        risks.push(ConfigRisk {
            key: "持久化".into(),
            current_value: "appendonly=no, save=空".into(),
            risk_level: "error".into(),
            description: "AOF 和 RDB 均未启用，重启后数据全部丢失".into(),
            suggestion: "至少启用 RDB（设置 save 规则）或 AOF（appendonly yes）".into(),
        });
    }

    // protected-mode off + 无密码 + bind 全网卡
    let bind_all = bind_addrs.contains("0.0.0.0") || bind_addrs.is_empty();
    if protected == "no" && requirepass.is_empty() && bind_all {
        risks.push(ConfigRisk {
            key: "网络安全".into(),
            current_value: format!("protected-mode={protected}, bind={bind_addrs}, requirepass=空"),
            risk_level: "error".into(),
            description: "Redis 暴露在公网且无密码，极易被攻击".into(),
            suggestion: "设置强密码（requirepass）或启用 protected-mode，并限制 bind 地址".into(),
        });
    }

    // slowlog 阈值未配
    if slowlog_th.parse::<i64>().unwrap_or(-1) < 0 {
        risks.push(ConfigRisk {
            key: "slowlog-log-slower-than".into(),
            current_value: slowlog_th.clone(),
            risk_level: "warn".into(),
            description: "慢日志未启用，无法定位慢查询".into(),
            suggestion: "设置 slowlog-log-slower-than 为 1000（微秒）".into(),
        });
    }

    Ok(risks)
}

// ── R8.4 ACL 用户管理 ─────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AclUser {
    pub username: String,
    pub flags: Vec<String>,
    pub passwords: Vec<String>,
    pub commands: String,
    pub keys: String,
    pub channels: String,
    pub selectors: Vec<String>,
}

fn parse_acl_list_entry(entry: &str) -> AclUser {
    // Format: user <name> on/off #hash ~pattern &channel +cmds
    let parts: Vec<&str> = entry.split_whitespace().collect();
    let username = parts.get(1).unwrap_or(&"").to_string();
    let mut flags = vec![];
    let mut passwords = vec![];
    let mut commands = String::new();
    let mut keys = String::new();
    let mut channels = String::new();
    let mut selectors = vec![];

    for &p in parts.iter().skip(2) {
        if p == "on" || p == "off" || p == "nopass" || p == "reset" || p == "resetkeys" || p == "resetchannels" {
            flags.push(p.to_string());
        } else if p.starts_with('#') || p.starts_with('>') {
            passwords.push(p.to_string());
        } else if p.starts_with('~') {
            if !keys.is_empty() { keys.push(' '); }
            keys.push_str(p);
        } else if p.starts_with('&') {
            if !channels.is_empty() { channels.push(' '); }
            channels.push_str(p);
        } else if p.starts_with('(') {
            selectors.push(p.to_string());
        } else if p.starts_with('+') || p.starts_with('-') || p == "allcommands" || p == "nocommands" || p == "allkeys" || p == "resetkeys" {
            if !commands.is_empty() { commands.push(' '); }
            commands.push_str(p);
        }
    }
    AclUser { username, flags, passwords, commands, keys, channels, selectors }
}

/// R8.4 ACL LIST
#[tauri::command]
pub async fn redis_acl_list(
    id: String,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
) -> Result<Vec<AclUser>, String> {
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let raw: Vec<String> = redis::cmd("ACL").arg("LIST")
        .query_async(&mut conn).await
        .map_err(|e| format!("ACL LIST 失败: {e}"))?;
    Ok(raw.iter().map(|s| parse_acl_list_entry(s)).collect())
}

/// R8.4 ACL WHOAMI
#[tauri::command]
pub async fn redis_acl_whoami(
    id: String,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
) -> Result<String, String> {
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    redis::cmd("ACL").arg("WHOAMI")
        .query_async::<String>(&mut conn).await
        .map_err(|e| format!("ACL WHOAMI 失败: {e}"))
}

/// R8.4 ACL CAT（命令类别列表）
#[tauri::command]
pub async fn redis_acl_cat(
    id: String,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
) -> Result<Vec<String>, String> {
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    redis::cmd("ACL").arg("CAT")
        .query_async::<Vec<String>>(&mut conn).await
        .map_err(|e| format!("ACL CAT 失败: {e}"))
}

/// R8.4 ACL SETUSER（强确认由前端保证）
#[tauri::command]
pub async fn redis_acl_setuser(
    id: String,
    username: String,
    rules: Vec<String>,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
    readonly_state: State<'_, RedisReadonly>,
) -> Result<String, String> {
    require_writable(&id, &readonly_state).await?;
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let mut cmd = redis::cmd("ACL");
    cmd.arg("SETUSER").arg(&username);
    for rule in &rules { cmd.arg(rule.as_str()); }
    match cmd.query_async::<redis::Value>(&mut conn).await {
        Ok(v) => Ok(redis_value_to_string(&v, 0)),
        Err(e) => Err(format!("ACL SETUSER 失败: {e}")),
    }
}

/// R8.4 ACL DELUSER（强确认由前端保证）
#[tauri::command]
pub async fn redis_acl_deluser(
    id: String,
    username: String,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
    readonly_state: State<'_, RedisReadonly>,
) -> Result<String, String> {
    require_writable(&id, &readonly_state).await?;
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    match redis::cmd("ACL").arg("DELUSER").arg(&username)
        .query_async::<redis::Value>(&mut conn).await {
        Ok(v) => Ok(redis_value_to_string(&v, 0)),
        Err(e) => Err(format!("ACL DELUSER 失败: {e}")),
    }
}

// ── 可选增强 R4.5: 两实例 CONFIG 对比 ─────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisConfigDiff {
    pub key: String,
    pub value_a: Option<String>,  // None 表示该实例无此配置项
    pub value_b: Option<String>,
}

/// R4.5+: 对比两个 Redis 实例的 CONFIG GET *，只返回有差异的项（含一方缺失）
/// 密码类配置（requirepass/masterauth 等）脱敏为 *** 后再展示
#[tauri::command]
pub async fn redis_config_compare(
    id_a: String,
    db_a: Option<u8>,
    id_b: String,
    db_b: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
) -> Result<Vec<RedisConfigDiff>, String> {
    use std::collections::BTreeMap;

    let mut conn_a = get_conn(&id_a, db_a, &pool, &storage).await?;
    let flat_a: Vec<String> = redis::cmd("CONFIG").arg("GET").arg("*")
        .query_async(&mut conn_a).await
        .map_err(|e| format!("读取实例 A 配置失败: {e}"))?;
    let mut conn_b = get_conn(&id_b, db_b, &pool, &storage).await?;
    let flat_b: Vec<String> = redis::cmd("CONFIG").arg("GET").arg("*")
        .query_async(&mut conn_b).await
        .map_err(|e| format!("读取实例 B 配置失败: {e}"))?;

    // CONFIG GET * 返回扁平的 [k1,v1,k2,v2,...]
    let to_map = |flat: Vec<String>| -> BTreeMap<String, String> {
        let mut m = BTreeMap::new();
        let mut it = flat.into_iter();
        while let (Some(k), Some(v)) = (it.next(), it.next()) {
            m.insert(k, v);
        }
        m
    };
    let ma = to_map(flat_a);
    let mb = to_map(flat_b);

    let sensitive = |k: &str| k.contains("pass") || k.contains("auth");
    let mask = |k: &str, v: &str| if sensitive(k) { "***".to_string() } else { v.to_string() };

    let mut out = Vec::new();
    for (k, va) in &ma {
        match mb.get(k) {
            Some(vb) if vb != va => out.push(RedisConfigDiff {
                key: k.clone(),
                value_a: Some(mask(k, va)),
                value_b: Some(mask(k, vb)),
            }),
            None => out.push(RedisConfigDiff {
                key: k.clone(), value_a: Some(mask(k, va)), value_b: None,
            }),
            _ => {}
        }
    }
    for (k, vb) in &mb {
        if !ma.contains_key(k) {
            out.push(RedisConfigDiff {
                key: k.clone(), value_a: None, value_b: Some(mask(k, vb)),
            });
        }
    }
    out.sort_by(|x, y| x.key.cmp(&y.key));
    Ok(out)
}

// ── 可选增强 R5: 键空间通知调试器 ─────────────────────────────────────────────

/// R5+: 获取当前 notify-keyspace-events 配置值
#[tauri::command]
pub async fn redis_keyspace_notify_get(
    id: String,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
) -> Result<String, String> {
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let result: Vec<String> = redis::cmd("CONFIG")
        .arg("GET").arg("notify-keyspace-events")
        .query_async(&mut conn).await
        .map_err(|e| format!("获取键空间通知配置失败: {e}"))?;
    // CONFIG GET 返回 [key, value] 列表
    Ok(result.get(1).cloned().unwrap_or_default())
}

/// R5+: 设置 notify-keyspace-events（空字符串=禁用；"KEA"=全部启用）
/// 影响全局配置，强确认由前端保证
#[tauri::command]
pub async fn redis_keyspace_notify_set(
    id: String,
    value: String,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
    readonly_state: State<'_, RedisReadonly>,
) -> Result<String, String> {
    require_writable(&id, &readonly_state).await?;
    // 字符校验：Redis notify-keyspace-events 官方合法标志集
    // K=keyspace E=keyevent g=generic $=string l=list s=set h=hash z=zset
    // x=expired e=evicted n=new-key(7.0+) t=stream d=module m=key-miss A=g$lshzxet 别名
    let allowed = "KEg$lshzxetdmnA";
    if !value.chars().all(|c| allowed.contains(c)) {
        return Err(format!("非法的事件标志: {value}（允许字符: {allowed}）"));
    }
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let result: String = redis::cmd("CONFIG")
        .arg("SET").arg("notify-keyspace-events").arg(&value)
        .query_async(&mut conn).await
        .map_err(|e| format!("设置键空间通知失败: {e}"))?;
    Ok(result)
}

// ── 可选增强 R4.4: 内存碎片治理 ──────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisDefragInfo {
    pub activedefrag_enabled: bool,
    pub mem_allocator_frag_ratio: f64,
    pub mem_allocator_frag_bytes: i64,
    pub active_defrag_running: bool,
    pub active_defrag_hits: i64,
    pub active_defrag_misses: i64,
    pub active_defrag_key_hits: i64,
    pub active_defrag_key_misses: i64,
    pub purge_result: String,
}

/// R4.4+: MEMORY PURGE（归还未使用内存给 OS）+ activedefrag 状态
#[tauri::command]
pub async fn redis_memory_purge(
    id: String,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
    readonly_state: State<'_, RedisReadonly>,
) -> Result<RedisDefragInfo, String> {
    require_writable(&id, &readonly_state).await?;
    let mut conn = get_conn(&id, db, &pool, &storage).await?;

    // MEMORY PURGE（可能在某些版本不支持，graceful）
    let purge_result: String = match redis::cmd("MEMORY").arg("PURGE")
        .query_async::<redis::Value>(&mut conn).await
    {
        Ok(v) => redis_value_to_string(&v, 0),
        Err(e) => format!("PURGE 不支持: {e}"),
    };

    // INFO memory 中的碎片信息
    let info: String = redis::cmd("INFO").arg("memory")
        .query_async(&mut conn).await
        .unwrap_or_default();

    let parse_f64 = |key: &str| -> f64 {
        info.lines()
            .find(|l| l.starts_with(&format!("{key}:")))
            .and_then(|l| l.split(':').nth(1))
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(0.0)
    };
    let parse_i64 = |key: &str| -> i64 {
        info.lines()
            .find(|l| l.starts_with(&format!("{key}:")))
            .and_then(|l| l.split(':').nth(1))
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(0)
    };
    let parse_bool = |key: &str| -> bool {
        info.lines()
            .find(|l| l.starts_with(&format!("{key}:")))
            .and_then(|l| l.split(':').nth(1))
            .map(|v| v.trim() == "yes" || v.trim() == "1")
            .unwrap_or(false)
    };

    // activedefrag 是否启用在 CONFIG GET 里
    let defrag_cfg: Vec<String> = redis::cmd("CONFIG")
        .arg("GET").arg("activedefrag")
        .query_async(&mut conn).await
        .unwrap_or_default();
    let activedefrag_enabled = defrag_cfg.get(1).map(|v| v == "yes" || v == "1").unwrap_or(false);

    Ok(RedisDefragInfo {
        activedefrag_enabled,
        mem_allocator_frag_ratio: parse_f64("mem_allocator_frag_ratio"),
        mem_allocator_frag_bytes: parse_i64("mem_allocator_frag_bytes"),
        active_defrag_running:    parse_bool("active_defrag_running"),
        active_defrag_hits:       parse_i64("active_defrag_hits"),
        active_defrag_misses:     parse_i64("active_defrag_misses"),
        active_defrag_key_hits:   parse_i64("active_defrag_key_hits"),
        active_defrag_key_misses: parse_i64("active_defrag_key_misses"),
        purge_result,
    })
}

// ── 可选增强 R2: MODULE LIST（RedisJSON/RedisSearch/RedisGraph 探测）─────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisModuleInfo {
    pub name: String,
    pub version: i64,
}

/// R2+: MODULE LIST 探测已加载模块（RedisJSON/RediSearch/RedisGraph 等）
#[tauri::command]
pub async fn redis_module_list(
    id: String,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
) -> Result<Vec<RedisModuleInfo>, String> {
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    match redis::cmd("MODULE").arg("LIST")
        .query_async::<redis::Value>(&mut conn).await
    {
        Ok(redis::Value::Array(modules)) => {
            let mut result = Vec::new();
            for module in modules {
                if let redis::Value::Array(fields) = module {
                    let mut name = String::new();
                    let mut version: i64 = 0;
                    let mut i = 0;
                    while i + 1 < fields.len() {
                        if let redis::Value::BulkString(k) = &fields[i] {
                            let key = String::from_utf8_lossy(k).to_lowercase();
                            match key.as_str() {
                                "name" => {
                                    if let redis::Value::BulkString(v) = &fields[i + 1] {
                                        name = String::from_utf8_lossy(v).to_string();
                                    }
                                }
                                "ver" => {
                                    match &fields[i + 1] {
                                        redis::Value::Int(v) => version = *v,
                                        redis::Value::BulkString(b) =>
                                            version = String::from_utf8_lossy(b).parse().unwrap_or(0),
                                        _ => {}
                                    }
                                }
                                _ => {}
                            }
                        }
                        i += 2;
                    }
                    if !name.is_empty() {
                        result.push(RedisModuleInfo { name, version });
                    }
                }
            }
            Ok(result)
        }
        Ok(_) => Ok(vec![]),
        Err(e) => {
            // 仅当 MODULE 命令本身不被识别时降级；不可用宽泛的 "ERR" 吞掉权限/参数等真实错误
            let msg = e.to_string();
            if msg.contains("unknown command") {
                return Ok(vec![]);
            }
            Err(format!("MODULE LIST 失败: {e}"))
        }
    }
}
