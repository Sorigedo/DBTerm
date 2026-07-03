// Redis 功能模块 — R0 连接层 + R1 Key 浏览 + R2 全类型编辑
//
// 隔离原则：本文件只导入 redis / db_tunnel / keychain / storage / models，
// 绝不引用 commands::query / commands::db_tx / commands::db_export 等 SQL 侧代码。

pub mod keys;
pub mod value;
pub mod server;
pub mod pubsub;
pub mod transfer;
pub mod slowlog_store;

use std::{collections::HashMap, sync::Arc};
use redis::aio::MultiplexedConnection;
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::sync::Mutex;

use crate::{models::ConnConfig, storage::StorageState};

// ── 连接池类型 ─────────────────────────────────────────────────────────────────

/// (conn_id, db_index) → (连接, SSH 隧道守卫)
/// 隧道 Arc 必须和连接同生命周期，否则 drop 时隧道关闭导致连接失效。
pub type RedisPool = Arc<Mutex<HashMap<(String, u8), RedisEntry>>>;

pub struct RedisEntry {
    pub conn: MultiplexedConnection,
    /// 持有 SSH 隧道，保证连接期间隧道不被关闭
    pub _tunnel: Option<Arc<crate::db_tunnel::DbTunnel>>,
}

/// Redis 连接额外配置（序列化进 ConnConfig.extra_json，与前端 DbExtra 对应）
#[derive(Deserialize, Default)]
#[allow(dead_code)]
pub struct RedisConnCfg {
    // SSH 隧道
    #[serde(rename = "sshTunnel",   default)] ssh_tunnel:    bool,
    #[serde(rename = "sshHost",     default)] ssh_host:      String,
    #[serde(rename = "sshPort",     default)] ssh_port:      u16,
    #[serde(rename = "sshUser",     default)] ssh_user:      String,
    #[serde(rename = "sshAuthType", default)] ssh_auth_type: String,
    #[serde(rename = "sshPassword", default)] ssh_password:  String,
    #[serde(rename = "sshKeyPath",  default)] ssh_key_path:  String,
    /// key 前缀树分隔符，默认 ":"
    #[serde(rename = "keySeparator", default)] key_separator: String,
    // TLS（复用 libpq sslMode 四级模型；与 MySQL/PG 一致）
    // disabled=明文 redis:// | require=加密不验证 | verify-ca/verify-full=验证（redis 无中间档，verify-ca 等同 verify-full）
    #[serde(rename = "sslMode", default)] ssl_mode: String,
    #[serde(rename = "sslCa",   default)] ssl_ca:   String,  // 自定义 CA 证书路径（PEM）
    #[serde(rename = "sslCert", default)] ssl_cert: String,  // mTLS 客户端证书路径（PEM）
    #[serde(rename = "sslKey",  default)] ssl_key:  String,  // mTLS 客户端私钥路径（PEM）
}

impl RedisConnCfg {
    pub fn from_config(c: &ConnConfig) -> Self {
        c.extra_json.as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default()
    }
    #[allow(dead_code)]
    pub fn separator(&self) -> &str {
        if self.key_separator.is_empty() { ":" } else { &self.key_separator }
    }
}

// ── 版本能力位图 ───────────────────────────────────────────────────────────────

pub const CAP_SCAN:          u64 = 1 << 8; // Redis ≥ 2.8（SCAN/HSCAN/SSCAN/ZSCAN）
pub const CAP_MEMORY_USAGE:  u64 = 1 << 0; // Redis ≥ 4.0
pub const CAP_UNLINK:        u64 = 1 << 1; // Redis ≥ 4.0
pub const CAP_ACL:           u64 = 1 << 2; // Redis ≥ 6.0
pub const CAP_SCAN_TYPE:     u64 = 1 << 3; // Redis ≥ 6.0 (SCAN TYPE 过滤)
pub const CAP_COPY:          u64 = 1 << 4; // Redis ≥ 6.2
pub const CAP_XAUTOCLAIM:    u64 = 1 << 5; // Redis ≥ 6.2
pub const CAP_ERROR_STATS:   u64 = 1 << 6; // Redis ≥ 6.2
pub const CAP_LATENCY_STATS: u64 = 1 << 7; // Redis ≥ 7.0

pub fn parse_redis_version(s: &str) -> (u32, u32, u32) {
    let parts: Vec<u32> = s.split('.').filter_map(|p| p.parse().ok()).collect();
    (parts.first().copied().unwrap_or(0),
     parts.get(1).copied().unwrap_or(0),
     parts.get(2).copied().unwrap_or(0))
}

pub fn version_to_caps(major: u32, minor: u32, _patch: u32) -> u64 {
    let mut caps = 0u64;
    // Redis 2.8+：SCAN 系列命令
    if major > 2 || (major == 2 && minor >= 8) { caps |= CAP_SCAN; }
    if major >= 4 { caps |= CAP_MEMORY_USAGE | CAP_UNLINK; }
    if major >= 6 { caps |= CAP_ACL | CAP_SCAN_TYPE; }
    if major > 6 || (major == 6 && minor >= 2) { caps |= CAP_COPY | CAP_XAUTOCLAIM | CAP_ERROR_STATS; }
    if major >= 7 { caps |= CAP_LATENCY_STATS; }
    caps
}

// ── 连接建立 ───────────────────────────────────────────────────────────────────

/// URL 编码（Redis 密码可能含特殊字符）
pub fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => { use std::fmt::Write; write!(out, "%{b:02X}").unwrap(); }
        }
    }
    out
}

/// 根据配置构建 Redis URL（支持 ACL、DB 选择）
/// use_tls=true 用 rediss://；insecure=true 追加 #insecure（加密但完全不验证证书）
pub fn build_redis_url(host: &str, port: u16, username: Option<&str>, password: Option<&str>, db: u8, use_tls: bool) -> String {
    let scheme = if use_tls { "rediss" } else { "redis" };
    // host 中的 @ 会破坏 URL 解析，@ 和 / 必须拒绝
    let safe_host = if host.contains('@') || host.contains('/') {
        log::warn!("Redis host 含非法字符，连接可能失败");
        host
    } else { host };
    match (username.filter(|u| !u.is_empty()), password.filter(|p| !p.is_empty())) {
        (Some(u), Some(p)) => format!("{scheme}://{}:{}@{}:{}/{}", urlencode(u), urlencode(p), safe_host, port, db),
        (None, Some(p))    => format!("{scheme}://:{}@{}:{}/{}", urlencode(p), safe_host, port, db),
        _                  => format!("{scheme}://{}:{}/{}", safe_host, port, db),
    }
}

/// 读取 PEM 文件为字节流（路径支持 ~ 展开）；空路径返回 None
fn read_pem_file(path: &str) -> Result<Option<Vec<u8>>, String> {
    let p = path.trim();
    if p.is_empty() { return Ok(None); }
    let full = crate::tester::expand_home(p);
    std::fs::read(&full)
        .map(Some)
        .map_err(|e| format!("读取证书文件失败 ({p}): {e}"))
}

/// 从存储中加载配置 + 密码
pub fn load_config_password(id: &str, storage: &State<'_, StorageState>) -> Result<(ConnConfig, Option<String>), String> {
    let configs = storage.lock().unwrap_or_else(std::sync::PoisonError::into_inner).load()?;
    let config = configs.into_iter().find(|c| c.id == id)
        .ok_or_else(|| format!("连接不存在: {id}"))?;
    let password = crate::keychain::get_password(id)?;
    Ok((config, password))
}

/// 获取配置中的默认 DB 索引
pub fn default_db(config: &ConnConfig) -> u8 {
    config.database.as_deref().and_then(|s| s.parse::<u8>().ok()).unwrap_or(0)
}

/// 建立到 Redis 的新连接（处理 SSH 隧道、TLS、ACL）
pub async fn open_fresh_conn(
    config: &ConnConfig,
    password: Option<&str>,
    db: u8,
) -> Result<RedisEntry, String> {
    use crate::db_tunnel::{DbTunnel, DbTunnelCfg};

    let extra = RedisConnCfg::from_config(config);
    let (host, port, tunnel) = if extra.ssh_tunnel {
        let tcfg = DbTunnelCfg {
            host:      extra.ssh_host.clone(),
            port:      extra.ssh_port,
            user:      extra.ssh_user.clone(),
            auth_type: if extra.ssh_auth_type.is_empty() { "password".into() } else { extra.ssh_auth_type.clone() },
            password:  extra.ssh_password.clone(),
            key_path:  extra.ssh_key_path.clone(),
        };
        let db_host = config.host.as_deref().unwrap_or("127.0.0.1");
        let db_port = config.port.unwrap_or(6379);
        let t = DbTunnel::open_shared(&config.id, &tcfg, db_host, db_port).await?;
        let lp = t.local_port;
        ("127.0.0.1".to_string(), lp, Some(t))
    } else {
        let h = config.host.as_deref().unwrap_or("127.0.0.1").to_string();
        let p = config.port.unwrap_or(6379);
        (h, p, None)
    };

    // TLS：复用 libpq sslMode 四级模型（与 MySQL/PG 一致）
    // disabled=明文 | require=加密不验证(#insecure) | verify-ca/verify-full=验证证书
    // 注：redis 0.26 的 insecure 是 all-or-nothing，无独立 verify-ca，故 verify-ca 等同 verify-full
    let ssl_mode = extra.ssl_mode.as_str();
    let use_tls = !matches!(ssl_mode, "" | "disabled");
    let client = if !use_tls {
        let url = build_redis_url(&host, port, config.username.as_deref(), password, db, false);
        redis::Client::open(url.as_str()).map_err(|e| format!("Redis URL 无效: {e}"))?
    } else if ssl_mode == "require" {
        // 加密但完全不验证证书（#insecure）；CA 在此模式无意义，忽略
        let mut url = build_redis_url(&host, port, config.username.as_deref(), password, db, true);
        url.push_str("#insecure");
        redis::Client::open(url.as_str()).map_err(|e| format!("Redis TLS URL 无效: {e}"))?
    } else {
        // verify-ca / verify-full：验证服务端证书（含主机名）
        let url = build_redis_url(&host, port, config.username.as_deref(), password, db, true);
        let root_cert = read_pem_file(&extra.ssl_ca)?;
        let client_tls = match (read_pem_file(&extra.ssl_cert)?, read_pem_file(&extra.ssl_key)?) {
            (Some(cert), Some(key)) => Some(redis::ClientTlsConfig { client_cert: cert, client_key: key }),
            _ => None,  // mTLS 需同时提供证书+私钥，否则不启用客户端认证
        };
        if root_cert.is_some() || client_tls.is_some() {
            // 自定义 CA / mTLS
            redis::Client::build_with_tls(url.as_str(), redis::TlsCertificates { client_tls, root_cert })
                .map_err(|e| format!("Redis TLS 配置失败: {e}"))?
        } else {
            // 系统根证书验证
            redis::Client::open(url.as_str()).map_err(|e| format!("Redis TLS URL 无效: {e}"))?
        }
    };

    let conn = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        client.get_multiplexed_async_connection(),
    ).await
    .map_err(|_| "连接超时（10 秒）".to_string())?
    .map_err(|e| format!("连接失败: {e}"))?;

    Ok(RedisEntry { conn, _tunnel: tunnel })
}

/// 从连接池获取连接；若不存在或连接失效则重建。
/// db_override 不为 None 时覆盖配置中的 DB 索引。
pub async fn get_conn(
    id: &str,
    db_override: Option<u8>,
    pool: &State<'_, RedisPool>,
    storage: &State<'_, StorageState>,
) -> Result<MultiplexedConnection, String> {
    let (config, password) = load_config_password(id, storage)?;
    let db = db_override.unwrap_or_else(|| default_db(&config));
    let key = (id.to_string(), db);

    // 先检查池是否有缓存
    {
        let guard = pool.lock().await;
        if let Some(entry) = guard.get(&key) {
            return Ok(entry.conn.clone());
        }
    }

    // 池中无缓存，新建连接
    let entry = open_fresh_conn(&config, password.as_deref(), db).await?;
    let conn = entry.conn.clone();
    pool.lock().await.insert(key, entry);
    Ok(conn)
}

/// 连接失败时从池中清除，下次调用会自动重建
pub async fn invalidate_conn(id: &str, db: u8, pool: &State<'_, RedisPool>) {
    pool.lock().await.remove(&(id.to_string(), db));
}

/// 判断错误是否为连接级错误（非 Redis 协议错误）
fn is_conn_error(e: &redis::RedisError) -> bool {
    matches!(e.kind(), redis::ErrorKind::IoError | redis::ErrorKind::TryAgain)
}

/// 将 Redis 原始字节安全转为可显示字符串：合法 UTF-8 原样返回，
/// 非法字节用 U+FFFD 替换（与 stream 读取一致）。这样二进制值（pickle/protobuf/
/// gzip 等）也能正常浏览，不再报「Cannot convert from UTF-8」并整条命令失败。
pub fn bytes_to_text(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

/// 字节转「显示文本 + 是否二进制」。合法 UTF-8 → (原文, false)；
/// 否则 → (十六进制预览, true)，避免界面出现一堆 U+FFFD 乱码。
/// 十六进制最多展示 512 字节，超出部分省略并标注剩余字节数。
pub fn bytes_to_display(b: &[u8]) -> (String, bool) {
    match std::str::from_utf8(b) {
        Ok(s) => (s.to_string(), false),
        Err(_) => {
            const MAX: usize = 512;
            let mut hex: String = b.iter().take(MAX)
                .map(|c| format!("{c:02x}")).collect::<Vec<_>>().join(" ");
            if b.len() > MAX {
                hex.push_str(&format!(" … (+{} 字节)", b.len() - MAX));
            }
            (hex, true)
        }
    }
}

// ── 公共数据结构 ───────────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RedisKeyInfo {
    pub key: String,
    pub kind: String,
    pub ttl: i64, // -1 永久，-2 不存在
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisScanResult {
    pub keys: Vec<RedisKeyInfo>,
    pub cursor: u64,
    pub has_more: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisValue {
    pub kind: String,
    pub value: serde_json::Value,
    pub truncated: bool,
    pub total: usize,
    /// string 类型值为非 UTF-8 二进制时为 true，value 此时是十六进制预览
    #[serde(default)]
    pub binary: bool,
}

const VALUE_LIMIT: usize = 200;

// ── R0 新增命令 ────────────────────────────────────────────────────────────────

/// R0.6 版本 & 能力探测：返回版本字符串和能力位图
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisServerCaps {
    pub version: String,
    pub caps: u64,
    pub mode: String,   // "standalone" | "sentinel" | "cluster"
    pub os: String,
}

#[tauri::command]
pub async fn redis_server_caps(
    id: String,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
) -> Result<RedisServerCaps, String> {
    let (config, password) = load_config_password(&id, &storage)?;
    let db_idx = db.unwrap_or_else(|| default_db(&config));
    let key = (id.clone(), db_idx);

    // 总是建立新连接来探测（不影响池中已有连接）
    let entry = open_fresh_conn(&config, password.as_deref(), db_idx).await?;
    let mut conn = entry.conn.clone();

    let info_str: String = redis::cmd("INFO").arg("server")
        .query_async(&mut conn).await
        .map_err(|e| format!("INFO 失败: {e}"))?;

    let version = info_str.lines()
        .find(|l| l.starts_with("redis_version:"))
        .and_then(|l| l.split(':').nth(1))
        .unwrap_or("0.0.0")
        .trim()
        .to_string();

    let mode = info_str.lines()
        .find(|l| l.starts_with("redis_mode:"))
        .and_then(|l| l.split(':').nth(1))
        .unwrap_or("standalone")
        .trim()
        .to_string();

    let os = info_str.lines()
        .find(|l| l.starts_with("os:"))
        .and_then(|l| l.split(':').nth(1))
        .unwrap_or("")
        .trim()
        .to_string();

    let (major, minor, patch) = parse_redis_version(&version);
    let caps = version_to_caps(major, minor, patch);

    // 将此连接存入池（复用）
    pool.lock().await.insert(key, entry);

    Ok(RedisServerCaps { version, caps, mode, os })
}

/// R0.4 多 DB 信息：各 DB key 数量（INFO keyspace 解析 + DBSIZE）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisDbInfo {
    pub db: u8,
    pub keys: u64,
    pub expires: u64,
}

#[tauri::command]
pub async fn redis_db_info(
    id: String,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
) -> Result<Vec<RedisDbInfo>, String> {
    let mut conn = get_conn(&id, Some(0), &pool, &storage).await?;
    let info_str: String = redis::cmd("INFO").arg("keyspace")
        .query_async(&mut conn).await
        .map_err(|e| format!("INFO keyspace 失败: {e}"))?;

    let mut dbs: Vec<RedisDbInfo> = vec![];
    for line in info_str.lines() {
        if !line.starts_with("db") { continue; }
        let parts: Vec<&str> = line.splitn(2, ':').collect();
        if parts.len() != 2 { continue; }
        let db_num: u8 = parts[0][2..].parse().unwrap_or(255);
        if db_num == 255 { continue; }
        let mut keys = 0u64;
        let mut expires = 0u64;
        for kv in parts[1].split(',') {
            let kv: Vec<&str> = kv.splitn(2, '=').collect();
            if kv.len() != 2 { continue; }
            match kv[0] {
                "keys" => keys = kv[1].parse().unwrap_or(0),
                "expires" => expires = kv[1].parse().unwrap_or(0),
                _ => {}
            }
        }
        dbs.push(RedisDbInfo { db: db_num, keys, expires });
    }

    // 若 INFO keyspace 为空（全是空 db），也返回 db0 entry
    if dbs.is_empty() {
        let n: u64 = redis::cmd("DBSIZE").query_async(&mut conn).await.unwrap_or(0);
        dbs.push(RedisDbInfo { db: 0, keys: n, expires: 0 });
    } else {
        dbs.sort_by_key(|d| d.db);
    }

    Ok(dbs)
}

/// 列出 Redis 逻辑数据库，供资产树「自动获取数据库列表」使用。
/// 返回 ["db0", "db1", …]：数量优先取 `CONFIG GET databases`（默认 16）；
/// 若 CONFIG 被禁用/改名导致取不到，则回退到 INFO keyspace 中已存在的库（并始终包含 db0）。
pub async fn list_db_schemas(
    id: &str,
    pool: &State<'_, RedisPool>,
    storage: &State<'_, StorageState>,
) -> Result<Vec<String>, String> {
    let mut conn = get_conn(id, Some(0), pool, storage).await?;
    // 优先：CONFIG GET databases → 列出全部 db0..dbN-1（与各 Redis GUI 工具一致）
    if let Ok(kv) = redis::cmd("CONFIG").arg("GET").arg("databases")
        .query_async::<Vec<String>>(&mut conn).await
    {
        if let Some(n) = kv.get(1).and_then(|v| v.parse::<u32>().ok()) {
            if n > 0 {
                return Ok((0..n).map(|i| format!("db{i}")).collect());
            }
        }
    }
    // 回退：CONFIG 不可用时，仅列出 INFO keyspace 中已存在的库（始终含 db0）
    let info: String = redis::cmd("INFO").arg("keyspace")
        .query_async(&mut conn).await
        .map_err(|e| format!("INFO keyspace 失败: {e}"))?;
    let mut dbs: Vec<u32> = info.lines()
        .filter_map(|l| l.strip_prefix("db")?.split(':').next()?.parse().ok())
        .collect();
    if !dbs.contains(&0) { dbs.push(0); }
    dbs.sort_unstable();
    dbs.dedup();
    Ok(dbs.into_iter().map(|i| format!("db{i}")).collect())
}

// ── R0 保留的全部现有命令（签名兼容，内部改为用连接池）────────────────────────

/// redis_scan：Redis ≥ 2.8 用 SCAN（增量游标），更老版本降级到 KEYS（一次性全量，需谨慎大库）
#[tauri::command]
pub async fn redis_scan(
    id: String,
    pattern: String,
    cursor: u64,
    caps: Option<u64>,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
) -> Result<RedisScanResult, String> {
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let pat = if pattern.is_empty() { "*".to_string() } else { pattern };

    // Redis < 2.8 无 SCAN：降级到 KEYS（全量，cursor 只在第一页有效）
    let use_scan = caps.map_or(true, |c| c & CAP_SCAN != 0);
    if !use_scan {
        if cursor != 0 { return Ok(RedisScanResult { keys: vec![], has_more: false, cursor: 0 }); }
        let raw_keys: Vec<Vec<u8>> = redis::cmd("KEYS").arg(&pat)
            .query_async(&mut conn).await
            .map_err(|e| format!("KEYS 失败: {e}"))?;
        let limit = raw_keys.len().min(200);
        let mut infos = Vec::with_capacity(limit);
        for key in &raw_keys[..limit] {
            let kind: String = redis::cmd("TYPE").arg(key.as_slice()).query_async(&mut conn).await
                .unwrap_or_else(|_| "unknown".into());
            let ttl: i64 = redis::cmd("TTL").arg(key.as_slice()).query_async(&mut conn).await.unwrap_or(-1);
            infos.push(RedisKeyInfo { key: bytes_to_text(key), kind, ttl });
        }
        return Ok(RedisScanResult { keys: infos, has_more: raw_keys.len() > 200, cursor: 0 });
    }

    // Redis ≥ 2.8：SCAN（读为字节，保证二进制 key 正确处理）
    let result: Result<(u64, Vec<Vec<u8>>), redis::RedisError> = redis::cmd("SCAN")
        .arg(cursor).arg("MATCH").arg(&pat).arg("COUNT").arg(200)
        .query_async(&mut conn).await;

    let (next, keys) = match result {
        Ok(v) => v,
        Err(ref e) if is_conn_error(e) => {
            let (config, _) = load_config_password(&id, &storage)?;
            let db_idx = db.unwrap_or_else(|| default_db(&config));
            invalidate_conn(&id, db_idx, &pool).await;
            return Err(format!("连接断开，请重试: {e}"));
        }
        Err(e) => return Err(format!("SCAN 失败: {e}")),
    };

    let mut infos = Vec::with_capacity(keys.len());
    for key in &keys {
        let kind: String = redis::cmd("TYPE").arg(key.as_slice()).query_async(&mut conn).await
            .unwrap_or_else(|_| "unknown".into());
        let ttl: i64 = redis::cmd("TTL").arg(key.as_slice()).query_async(&mut conn).await.unwrap_or(-1);
        infos.push(RedisKeyInfo { key: bytes_to_text(key), kind, ttl });
    }
    Ok(RedisScanResult { keys: infos, has_more: next != 0, cursor: next })
}

#[tauri::command]
pub async fn redis_get(
    id: String,
    key: String,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
) -> Result<RedisValue, String> {
    use serde_json::json;
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let kind: String = redis::cmd("TYPE").arg(&key).query_async(&mut conn).await
        .map_err(|e| format!("TYPE 失败: {e}"))?;

    let mut binary = false;
    let (value, truncated, total) = match kind.as_str() {
        "string" => {
            // 读为字节：二进制 string（pickle/gzip 等）不再报 UTF-8 错误；非文本时给 hex 预览
            let v: Option<Vec<u8>> = redis::cmd("GET").arg(&key).query_async(&mut conn).await
                .map_err(|e| format!("GET 失败: {e}"))?;
            let (text, is_bin) = v.map(|b| bytes_to_display(&b)).unwrap_or_default();
            binary = is_bin;
            (json!(text), false, 1usize)
        }
        "list" => {
            let len: usize = redis::cmd("LLEN").arg(&key).query_async(&mut conn).await.unwrap_or(0);
            let v: Vec<Vec<u8>> = redis::cmd("LRANGE").arg(&key).arg(0).arg(VALUE_LIMIT as isize - 1)
                .query_async(&mut conn).await.map_err(|e| format!("LRANGE 失败: {e}"))?;
            let v: Vec<String> = v.iter().map(|b| bytes_to_text(b)).collect();
            (json!(v), len > VALUE_LIMIT, len)
        }
        "set" => {
            let (_, v): (u64, Vec<Vec<u8>>) = redis::cmd("SSCAN").arg(&key).arg(0).arg("COUNT").arg(VALUE_LIMIT)
                .query_async(&mut conn).await.map_err(|e| format!("SSCAN 失败: {e}"))?;
            let total: usize = redis::cmd("SCARD").arg(&key).query_async(&mut conn).await.unwrap_or(0);
            let v: Vec<String> = v.iter().map(|b| bytes_to_text(b)).collect();
            (json!(v), total > VALUE_LIMIT, total)
        }
        "zset" => {
            let v: Vec<(Vec<u8>, f64)> = redis::cmd("ZRANGE").arg(&key).arg(0).arg(VALUE_LIMIT as isize - 1).arg("WITHSCORES")
                .query_async(&mut conn).await.map_err(|e| format!("ZRANGE 失败: {e}"))?;
            let total: usize = redis::cmd("ZCARD").arg(&key).query_async(&mut conn).await.unwrap_or(0);
            let arr: Vec<_> = v.into_iter().map(|(m, s)| json!({ "member": bytes_to_text(&m), "score": s })).collect();
            (json!(arr), total > VALUE_LIMIT, total)
        }
        "hash" => {
            let (_, flat): (u64, Vec<Vec<u8>>) = redis::cmd("HSCAN").arg(&key).arg(0).arg("COUNT").arg(VALUE_LIMIT)
                .query_async(&mut conn).await.map_err(|e| format!("HSCAN 失败: {e}"))?;
            let total: usize = redis::cmd("HLEN").arg(&key).query_async(&mut conn).await.unwrap_or(0);
            let mut map = serde_json::Map::new();
            for pair in flat.chunks(2) {
                if let [f, v] = pair { map.insert(bytes_to_text(f), json!(bytes_to_text(v))); }
            }
            (serde_json::Value::Object(map), total > VALUE_LIMIT, total)
        }
        _ => (json!(format!("(暂不支持查看 {kind} 类型)")), false, 0),
    };

    Ok(RedisValue { kind, value, truncated, total, binary })
}

#[tauri::command]
pub async fn redis_set(
    id: String,
    key: String,
    value: String,
    ttl_secs: Option<i64>,
    nx: Option<bool>,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
    readonly_state: State<'_, server::RedisReadonly>,
) -> Result<(), String> {
    server::require_writable(&id, &readonly_state).await?;
    if key.is_empty() { return Err("key 不能为空".to_string()); }
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let kind: String = redis::cmd("TYPE").arg(&key).query_async(&mut conn).await
        .map_err(|e| format!("TYPE 失败: {e}"))?;
    if kind != "string" && kind != "none" {
        return Err(format!("key 已存在且类型为 {kind}，仅支持编辑 string 类型"));
    }
    let mut cmd = redis::cmd("SET");
    cmd.arg(&key).arg(&value);
    if let Some(t) = ttl_secs.filter(|t| *t > 0) {
        cmd.arg("EX").arg(t);
    }
    if nx.unwrap_or(false) {
        cmd.arg("NX");
        let res: Option<String> = cmd.query_async(&mut conn).await
            .map_err(|e| format!("SET 失败: {e}"))?;
        if res.is_none() {
            return Err("key 已存在，请换一个名称".to_string());
        }
    } else {
        cmd.query_async::<()>(&mut conn).await.map_err(|e| format!("SET 失败: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn redis_expire(
    id: String,
    key: String,
    ttl_secs: i64,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
    readonly_state: State<'_, server::RedisReadonly>,
) -> Result<(), String> {
    server::require_writable(&id, &readonly_state).await?;
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    if ttl_secs > 0 {
        let ok: i64 = redis::cmd("EXPIRE").arg(&key).arg(ttl_secs).query_async(&mut conn).await
            .map_err(|e| format!("EXPIRE 失败: {e}"))?;
        if ok == 0 { return Err("key 不存在".to_string()); }
    } else {
        redis::cmd("PERSIST").arg(&key).query_async::<i64>(&mut conn).await
            .map_err(|e| format!("PERSIST 失败: {e}"))?;
    }
    Ok(())
}

/// R1.3: 删除一律用 UNLINK（4.0+），不可用时降级 DEL
#[tauri::command]
pub async fn redis_del(
    id: String,
    key: String,
    db: Option<u8>,
    caps: Option<u64>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
    readonly_state: State<'_, server::RedisReadonly>,
) -> Result<(), String> {
    server::require_writable(&id, &readonly_state).await?;
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let use_unlink = caps.map_or(true, |c| c & CAP_UNLINK != 0);
    if use_unlink {
        let r: Result<(), redis::RedisError> = redis::cmd("UNLINK").arg(&key).query_async(&mut conn).await;
        if r.is_err() {
            // 降级到 DEL
            redis::cmd("DEL").arg(&key).query_async::<()>(&mut conn).await
                .map_err(|e| format!("DEL 失败: {e}"))?;
        }
    } else {
        redis::cmd("DEL").arg(&key).query_async::<()>(&mut conn).await
            .map_err(|e| format!("DEL 失败: {e}"))?;
    }
    Ok(())
}

// ── bigkey 扫描 (N1, 保留复用) ─────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BigKeyInfo {
    pub key: String,
    pub kind: String,
    pub memory_bytes: i64,
    pub length: i64, // 元素数量（hash/list/set/zset）
}

#[tauri::command]
pub async fn redis_bigkey_scan(
    id: String,
    db: Option<u8>,
    caps: Option<u64>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
) -> Result<Vec<BigKeyInfo>, String> {
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let has_memory_usage = caps.map_or(true, |c| c & CAP_MEMORY_USAGE != 0);
    let mut all_keys: Vec<String> = vec![];
    let mut cursor: u64 = 0;
    loop {
        let (next, keys): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor).arg("COUNT").arg(100)
            .query_async(&mut conn).await
            .map_err(|e| format!("SCAN 失败: {e}"))?;
        all_keys.extend(keys);
        cursor = next;
        if cursor == 0 || all_keys.len() >= 500 { break; }
    }
    let mut results: Vec<BigKeyInfo> = vec![];
    for key in all_keys.iter().take(200) {
        let kind: String = redis::cmd("TYPE").arg(key).query_async(&mut conn)
            .await.unwrap_or_else(|_| "unknown".into());
        let memory_bytes: i64 = if has_memory_usage {
            redis::cmd("MEMORY").arg("USAGE").arg(key).arg("SAMPLES").arg(0)
                .query_async(&mut conn).await.unwrap_or(0)
        } else {
            // 按类型用 LEN 类命令估算
            match kind.as_str() {
                "string" => {
                    let s: i64 = redis::cmd("STRLEN").arg(key).query_async(&mut conn).await.unwrap_or(0);
                    s + 64 // 粗略估算 overhead
                }
                "list"  => { let n: i64 = redis::cmd("LLEN").arg(key).query_async(&mut conn).await.unwrap_or(0); n * 32 }
                "set"   => { let n: i64 = redis::cmd("SCARD").arg(key).query_async(&mut conn).await.unwrap_or(0); n * 32 }
                "zset"  => { let n: i64 = redis::cmd("ZCARD").arg(key).query_async(&mut conn).await.unwrap_or(0); n * 48 }
                "hash"  => { let n: i64 = redis::cmd("HLEN").arg(key).query_async(&mut conn).await.unwrap_or(0); n * 64 }
                _ => 0,
            }
        };
        let length: i64 = match kind.as_str() {
            "list"  => redis::cmd("LLEN").arg(key).query_async(&mut conn).await.unwrap_or(0),
            "set"   => redis::cmd("SCARD").arg(key).query_async(&mut conn).await.unwrap_or(0),
            "zset"  => redis::cmd("ZCARD").arg(key).query_async(&mut conn).await.unwrap_or(0),
            "hash"  => redis::cmd("HLEN").arg(key).query_async(&mut conn).await.unwrap_or(0),
            "string"=> redis::cmd("STRLEN").arg(key).query_async(&mut conn).await.unwrap_or(0),
            _ => 0,
        };
        results.push(BigKeyInfo { key: key.clone(), kind, memory_bytes, length });
    }
    results.sort_by(|a, b| b.memory_bytes.cmp(&a.memory_bytes));
    Ok(results.into_iter().take(50).collect())
}

// ── 慢日志 (N2, 保留复用) ─────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlowlogEntry {
    pub id: i64,
    pub timestamp: i64,
    pub duration_us: i64,
    pub command: String,
}

#[tauri::command]
pub async fn redis_slowlog_get(
    id: String,
    count: Option<i64>,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
) -> Result<Vec<SlowlogEntry>, String> {
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let n = count.unwrap_or(50);
    let raw: Vec<redis::Value> = redis::cmd("SLOWLOG").arg("GET").arg(n)
        .query_async(&mut conn).await
        .map_err(|e| format!("SLOWLOG GET 失败: {e}"))?;
    let mut entries = vec![];
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
                    slowlog_store::redact_slowlog_cmd(&toks)  // 抹掉 AUTH/ACL/CONFIG 密码再回前端
                }
                _ => String::new(),
            };
            entries.push(SlowlogEntry { id: eid, timestamp: ts, duration_us: dur, command: cmd });
        }
    }
    Ok(entries)
}

// ── 批量删除 / TTL (N3/N4, 保留复用；底层改 UNLINK) ──────────────────────────

#[tauri::command]
pub async fn redis_batch_del(
    id: String,
    pattern: String,
    db: Option<u8>,
    caps: Option<u64>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
    readonly_state: State<'_, server::RedisReadonly>,
) -> Result<u64, String> {
    server::require_writable(&id, &readonly_state).await?;
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let use_unlink = caps.map_or(true, |c| c & CAP_UNLINK != 0);
    let mut cursor: u64 = 0;
    let mut deleted: u64 = 0;
    loop {
        let (next, keys): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor).arg("MATCH").arg(&pattern).arg("COUNT").arg(200)
            .query_async(&mut conn).await
            .map_err(|e| format!("SCAN 失败: {e}"))?;
        if !keys.is_empty() {
            let cmd_name = if use_unlink { "UNLINK" } else { "DEL" };
            let mut cmd = redis::cmd(cmd_name);
            for k in &keys { cmd.arg(k); }
            let n: u64 = cmd.query_async(&mut conn).await.unwrap_or(0);
            deleted += n;
        }
        cursor = next;
        if cursor == 0 { break; }
    }
    Ok(deleted)
}

#[tauri::command]
pub async fn redis_scan_pattern(
    id: String,
    pattern: String,
    limit: Option<usize>,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
) -> Result<Vec<String>, String> {
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let lim = limit.unwrap_or(500).min(1000);
    let mut cursor: u64 = 0;
    let mut keys: Vec<String> = vec![];
    loop {
        let (next, batch): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor).arg("MATCH").arg(&pattern).arg("COUNT").arg(200)
            .query_async(&mut conn).await
            .map_err(|e| format!("SCAN 失败: {e}"))?;
        keys.extend(batch);
        cursor = next;
        if cursor == 0 || keys.len() >= lim { break; }
    }
    Ok(keys.into_iter().take(lim).collect())
}

#[tauri::command]
pub async fn redis_batch_expire(
    id: String,
    pattern: String,
    ttl_secs: i64,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
    readonly_state: State<'_, server::RedisReadonly>,
) -> Result<u64, String> {
    server::require_writable(&id, &readonly_state).await?;
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let mut cursor: u64 = 0;
    let mut updated: u64 = 0;
    loop {
        let (next, keys): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor).arg("MATCH").arg(&pattern).arg("COUNT").arg(200)
            .query_async(&mut conn).await
            .map_err(|e| format!("SCAN 失败: {e}"))?;
        for k in &keys {
            if ttl_secs < 0 {
                redis::cmd("PERSIST").arg(k).query_async::<i64>(&mut conn).await.ok();
            } else {
                redis::cmd("EXPIRE").arg(k).arg(ttl_secs).query_async::<i64>(&mut conn).await.ok();
            }
            updated += 1;
        }
        cursor = next;
        if cursor == 0 { break; }
    }
    Ok(updated)
}

#[tauri::command]
pub async fn redis_scan_with_ttl(
    id: String,
    pattern: String,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
) -> Result<Vec<RedisKeyInfo>, String> {
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let mut cursor: u64 = 0;
    let mut keys: Vec<RedisKeyInfo> = vec![];
    loop {
        let (next, batch): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor).arg("MATCH").arg(&pattern).arg("COUNT").arg(200)
            .query_async(&mut conn).await
            .map_err(|e| format!("SCAN 失败: {e}"))?;
        for k in &batch {
            let kind: String = redis::cmd("TYPE").arg(k).query_async(&mut conn)
                .await.unwrap_or_else(|_| "unknown".into());
            let ttl: i64 = redis::cmd("TTL").arg(k).query_async(&mut conn).await.unwrap_or(-1);
            keys.push(RedisKeyInfo { key: k.clone(), kind, ttl });
        }
        cursor = next;
        if cursor == 0 || keys.len() >= 200 { break; }
    }
    Ok(keys)
}

/// 断开/清除某个连接的池缓存（用于 DB 切换或强制重连）
#[tauri::command]
pub async fn redis_disconnect(
    id: String,
    pool: State<'_, RedisPool>,
) -> Result<(), String> {
    let mut guard = pool.lock().await;
    guard.retain(|(conn_id, _), _| conn_id != &id);
    Ok(())
}
